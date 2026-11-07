/**
 * CSV whole-file search: one explicit run at a time, started where the reader is, with
 * occurrences published as they are found and a stop that keeps what it already found.
 *
 * Typing only searches the rows already in memory (that is the caller's own search); this
 * hook owns the expensive run and the navigation that takes over once it has occurrences.
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import type { SearchOccurrence } from '../../kernel/search.ts'
import { NO_OCCURRENCES, scanState as scanReducer } from './state.ts'
import type { ScanState } from './state.ts'

/** Occurrences kept for navigation; the total count stays whole. */
const SCAN_OCCURRENCE_LIMIT = 5_000

/** One request for a whole-file search: what to look for. */
export interface ScanRequest {
  readonly query: string
}

/** Runs one scan; a file source or the delivered text, whichever the caller has. */
export type ScanRunner = (
  pattern: RegExp,
  options: {
    readonly signal: AbortSignal
    readonly from: number
    readonly lineLimit: number
    readonly onSlice: (progress: number, matches: number, occurrences: readonly SearchOccurrence[]) => void
  },
) => Promise<{ readonly matches: number, readonly occurrences: readonly SearchOccurrence[] }>

/** What the arrows walk: scanned occurrences, or in-memory occurrences until there are any. */
export interface ScanNavigation {
  readonly activeOccurrence: SearchOccurrence | undefined
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
  /** Stop the run; the occurrences already on screen stay usable. */
  readonly stop: () => void
  /** Enter: start the scan, or walk the occurrences once there are any. */
  readonly commit: () => void
}

/** What the scan hook needs from the preview. */
export interface WholeFileScanOptions {
  /** Absent when the file is small enough to search from the rows in memory. */
  readonly scan: ScanRunner | undefined
  readonly query: string
  readonly regex: boolean
  readonly caseSensitive: boolean
  /** Bumps when the text behind the scan changes; restarts a run. */
  readonly revision: number
  /** 'file' or 'text': a change of source restarts the run on the new one. */
  readonly sourceKey: string
  /** Occurrences for the rows already in memory, used until the scan finds any. */
  readonly fallback: ScanNavigation
}

/**
 * Own the whole-file search for one CSV.
 * @param options - the runner, the query and how to fall back to in-memory occurrences.
 * @returns the scan state, its navigation, and the three triggers.
 */
export function useWholeFileScan(options: WholeFileScanOptions): WholeFileScan {
  const { scan, query, regex, caseSensitive, revision, sourceKey, fallback } = options
  const [request, setRequest] = useState<ScanRequest | undefined>(undefined)
  const [state, dispatchScan] = useReducer(scanReducer, undefined)
  const [index, setIndex] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const runnerRef = useRef(scan)
  runnerRef.current = scan

  useEffect(() => {
    const runner = runnerRef.current
    if (request === undefined || runner === undefined) {
      dispatchScan({ type: 'clear' })
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
      dispatchScan({ type: 'clear' })
      return undefined
    }
    const controller = new AbortController()
    abortRef.current = controller
    dispatchScan({ type: 'start', query: request.query })
    setIndex(0)
    /** Take one slice's worth of news without waiting for the rest. */
    const report = (progress: number, matches: number, occurrences: readonly SearchOccurrence[]): void => {
      dispatchScan({ type: 'slice', progress, matches, occurrences })
    }
    void runner(pattern, {
      signal: controller.signal,
      // File order: line 1 is body row 0; the header is skipped by the scanner.
      from: 1,
      lineLimit: SCAN_OCCURRENCE_LIMIT,
      onSlice: report,
    }).then((result) => {
      if (controller.signal.aborted) return
      dispatchScan({ type: 'done', matches: result.matches, occurrences: result.occurrences })
    }).catch(() => { /* stopped, or the file went away */ })
    return () => { controller.abort() }
  }, [request, regex, caseSensitive, revision, sourceKey])

  // Editing the query drops hits that belong to the old one.
  useEffect(() => {
    if (request === undefined) return
    if (request.query !== query.trim()) {
      setRequest(undefined)
      dispatchScan({ type: 'clear' })
    }
  }, [query, request])

  const occurrences = state === undefined ? NO_OCCURRENCES : state.occurrences
  const navigating = occurrences.length > 0
  const activeIndex = navigating ? Math.min(index, occurrences.length - 1) : fallback.index
  const activeOccurrence = navigating ? occurrences[activeIndex] : fallback.activeOccurrence
  const activeRow = activeOccurrence?.row ?? fallback.activeRow

  const start = (): void => {
    const text = query.trim()
    if (text === '') return
    dispatchScan({ type: 'clear' })
    // A fresh request object, so asking again with the same query restarts the scan.
    setRequest({ query: text })
  }
  const stop = (): void => {
    abortRef.current?.abort()
    dispatchScan({ type: 'stop' })
  }
  const next = (): void => {
    if (navigating) setIndex((activeIndex + 1) % occurrences.length)
    else fallback.next()
  }
  const prev = (): void => {
    if (navigating) setIndex((activeIndex - 1 + occurrences.length) % occurrences.length)
    else fallback.prev()
  }
  const commit = (): void => {
    if (navigating) next()
    else start()
  }

  return {
    state,
    activeOccurrence,
    activeRow,
    index: activeIndex,
    count: navigating ? (state?.matches ?? occurrences.length) : fallback.count,
    next,
    prev,
    start,
    stop,
    commit,
  }
}
