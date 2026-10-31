/**
 * The whole-file search: one explicit run at a time, started where the reader is, with
 * hits published as they are found and a stop that keeps what it already found.
 *
 * Typing only searches the rows already in memory (that is the caller's own search); this
 * hook owns the expensive run and the navigation that takes over once it has hits.
 */
import { useEffect, useRef, useState } from 'react'

/** Matches whose row is kept, so the reader can jump to them. */
const SCAN_LINE_LIMIT = 5_000

/** No match rows yet; a stable identity so the scan effect does not churn. */
const NO_ROWS: readonly number[] = []

/** One request for a whole-file search: what to look for, and from which row. */
export interface ScanRequest {
  readonly query: string
  /** Body row the scan starts at; it wraps around to cover the rows before it. */
  readonly from: number
}

/** What a run has found so far. */
export interface ScanState {
  /** The query this scan belongs to; hits for an older one are dropped. */
  readonly query: string
  /** 0..1 of the file looked at. */
  readonly progress: number
  /** Matches seen so far, which may be more than {@link ScanState.rows}. */
  readonly matches: number
  /** Body rows of the first matches, in the order the scan met them. */
  readonly rows: readonly number[]
  /** True when the scan reached the last slice or was stopped. */
  readonly done: boolean
  /** True when the reader stopped it. */
  readonly aborted: boolean
}

/** Runs one scan; a file source or the delivered text, whichever the caller has. */
export type ScanRunner = (
  pattern: RegExp,
  options: {
    readonly signal: AbortSignal
    readonly from: number
    readonly lineLimit: number
    readonly onSlice: (progress: number, matches: number, lines: readonly number[]) => void
  },
) => Promise<{ readonly matches: number, readonly lines: readonly number[] }>

/** What the arrows walk: the scanned rows, or the in-memory hits until there are any. */
export interface ScanNavigation {
  readonly activeRow: number | undefined
  readonly index: number
  readonly count: number
  readonly next: () => void
  readonly prev: () => void
}

/** The scan plus the navigation it drives. */
export interface WholeFileScan extends ScanNavigation {
  readonly state: ScanState | undefined
  /** Start a run from where the reader is (Enter, or the toolbar button). */
  readonly start: () => void
  /** Stop the run; the hits already on screen stay usable. */
  readonly stop: () => void
  /** Enter: start the scan, or walk the hits once there are any. */
  readonly commit: () => void
}

/** What the scan hook needs from the preview. */
export interface WholeFileScanOptions {
  /** Absent when the file is small enough to search from the rows in memory. */
  readonly scan: ScanRunner | undefined
  readonly query: string
  readonly regex: boolean
  readonly caseSensitive: boolean
  /** Body row to start at, read at request time so scrolling cannot restart a run. */
  readonly origin: () => number
  /** Bumps when the text behind the scan changes; restarts a run. */
  readonly revision: number
  /** 'file' or 'text': a change of source restarts the run on the new one. */
  readonly sourceKey: string
  /** Hits for the rows already in memory; used until the scan finds any. */
  readonly fallback: ScanNavigation
}

/**
 * Own the whole-file search for one preview.
 * @param options - the runner, the query and how to fall back to in-memory hits.
 * @returns the scan state, its navigation, and the three triggers.
 */
export function useWholeFileScan(options: WholeFileScanOptions): WholeFileScan {
  const { scan, query, regex, caseSensitive, origin, revision, sourceKey, fallback } = options
  const [request, setRequest] = useState<ScanRequest | undefined>(undefined)
  const [state, setState] = useState<ScanState | undefined>(undefined)
  const [index, setIndex] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const runnerRef = useRef(scan)
  runnerRef.current = scan

  useEffect(() => {
    const runner = runnerRef.current
    if (request === undefined || runner === undefined) {
      setState(undefined)
      return undefined
    }
    let pattern: RegExp
    const flags = caseSensitive ? 'gu' : 'giu'
    try {
      pattern = regex
        ? new RegExp(request.query, flags)
        : new RegExp(request.query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), flags)
    } catch {
      // An unfinished regular expression is not an error the reader must see.
      setState(undefined)
      return undefined
    }
    const controller = new AbortController()
    abortRef.current = controller
    setState({ query: request.query, progress: 0, matches: 0, rows: NO_ROWS, done: false, aborted: false })
    setIndex(0)
    /** Take one slice's worth of news without waiting for the rest. */
    const report = (progress: number, matches: number, lines: readonly number[]): void => {
      setState(current => {
        if (current === undefined) return current
        // Line 0 is the header, so a match's body row is one less; a header hit has none.
        const rows: number[] = []
        for (const line of lines) if (line > 0) rows.push(line - 1)
        return { ...current, progress, matches, rows }
      })
    }
    void runner(pattern, {
      signal: controller.signal,
      // Body row -> file row: the walk needs the header counted in.
      from: request.from + 1,
      lineLimit: SCAN_LINE_LIMIT,
      onSlice: report,
    }).then((result) => {
      if (controller.signal.aborted) return
      setState(current => {
        if (current === undefined) return current
        const rows: number[] = []
        for (const line of result.lines) if (line > 0) rows.push(line - 1)
        return { ...current, progress: 1, matches: result.matches, rows, done: true }
      })
    }).catch(() => { /* stopped, or the file went away */ })
    return () => { controller.abort() }
  }, [request, regex, caseSensitive, revision, sourceKey])

  // Editing the query drops hits that belong to the old one: they would highlight and
  // jump to rows the reader is no longer looking for.
  useEffect(() => {
    if (request === undefined) return
    if (request.query !== query.trim()) {
      setRequest(undefined)
      setState(undefined)
    }
  }, [query, request])

  const rows = state === undefined ? NO_ROWS : state.rows
  const navigating = rows.length > 0
  const activeIndex = navigating ? Math.min(index, rows.length - 1) : fallback.index
  const activeRow = navigating ? rows[activeIndex] : fallback.activeRow

  const start = (): void => {
    const text = query.trim()
    if (text === '') return
    setState(undefined)
    // A fresh request object, so asking again with the same query restarts the scan.
    setRequest({ query: text, from: origin() })
  }
  const stop = (): void => {
    abortRef.current?.abort()
    setState(current => (current === undefined ? current : { ...current, done: true, aborted: true }))
  }
  const next = (): void => {
    if (navigating) setIndex((activeIndex + 1) % rows.length)
    else fallback.next()
  }
  const prev = (): void => {
    if (navigating) setIndex((activeIndex - 1 + rows.length) % rows.length)
    else fallback.prev()
  }
  const commit = (): void => {
    if (navigating) next()
    else start()
  }

  return {
    state,
    activeRow,
    index: activeIndex,
    count: navigating ? rows.length : fallback.count,
    next,
    prev,
    start,
    stop,
    commit,
  }
}
