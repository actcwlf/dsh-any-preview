/** Whole-file log search: line results, progress, stop and 5,000-line navigation. */
import { useEffect, useRef, useState } from 'react'
import { compileSearch } from '../../kernel/search.ts'
import { LOG_MATCH_LIMIT } from './search.ts'
import type { LogScanOptions, LogScanResult } from './search.ts'

/** A scan function over a file or a delivered text. */
export type LogScanRunner = (pattern: RegExp, options: LogScanOptions) => Promise<LogScanResult>

/** Scan state for one query. */
export interface LogScanState {
  readonly query: string
  readonly progress: number
  /** Matching lines in the whole file so far. */
  readonly matches: number
  /** Matching lines kept for navigation, in file order. */
  readonly lines: readonly number[]
  readonly done: boolean
  readonly aborted: boolean
}

/** What the log body needs for full-file search. */
export interface LogScan {
  readonly state: LogScanState | undefined
  readonly count: number
  readonly index: number
  readonly activeLine: number | undefined
  readonly start: () => void
  readonly stop: () => void
  readonly next: () => void
  readonly prev: () => void
  readonly clear: () => void
}

/**
 * Run one full-file scan for the current query, with line navigation.
 * @param options - runner, query and query modes.
 * @returns scan state and navigation.
 */
export function useLogScan(options: {
  readonly scan: LogScanRunner | undefined
  readonly query: string
  readonly regex: boolean
  readonly caseSensitive: boolean
}): LogScan {
  const { scan, query, regex, caseSensitive } = options
  const [request, setRequest] = useState<{ readonly query: string } | undefined>(undefined)
  const [state, setState] = useState<LogScanState | undefined>(undefined)
  const [active, setActive] = useState(0)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    if (request !== undefined && request.query !== query) {
      controller.current?.abort()
      controller.current = null
      setRequest(undefined)
      setState(undefined)
      setActive(0)
    }
  }, [query, request])

  useEffect(() => {
    if (state !== undefined && state.query !== query) {
      controller.current?.abort()
      controller.current = null
      setRequest(undefined)
      setState(undefined)
      setActive(0)
    }
  }, [query, state])

  useEffect(() => {
    if (request === undefined || scan === undefined) return undefined
    const pattern = compileSearch({ query: request.query, regex, caseSensitive })
    if (pattern === undefined) return undefined
    const abort = new AbortController()
    controller.current = abort
    setActive(0)
    setState({ query: request.query, progress: 0, matches: 0, lines: [], done: false, aborted: false })
    void scan(pattern, {
      signal: abort.signal,
      lineLimit: LOG_MATCH_LIMIT,
      onSlice: (progress, matches, lines) => {
        if (abort.signal.aborted) return
        setState({ query: request.query, progress, matches, lines, done: false, aborted: false })
      },
    }).then((result) => {
      if (abort.signal.aborted) return
      setState({ query: request.query, progress: 1, matches: result.matches, lines: result.lines, done: true, aborted: false })
    }).catch(() => {
      if (abort.signal.aborted) return
      setState(current => current === undefined
        ? undefined
        : { ...current, done: true, aborted: true })
    })
    return () => {
      abort.abort()
      controller.current = null
    }
  }, [request, scan, regex, caseSensitive])

  const count = state?.matches ?? 0
  const total = state?.lines.length ?? 0
  const index = total === 0 ? -1 : Math.min(active, total - 1)
  const activeLine = index < 0 ? undefined : state?.lines[index]

  return {
    state,
    count,
    index,
    activeLine,
    start: (): void => {
      if (query === '') return
      setRequest({ query })
      setState(undefined)
      setActive(0)
    },
    stop: (): void => {
      controller.current?.abort()
      controller.current = null
      setState(current => current === undefined ? undefined : { ...current, done: true, aborted: true })
    },
    next: (): void => {
      if (total > 0) setActive((index + 1) % total)
    },
    prev: (): void => {
      if (total > 0) setActive((index - 1 + total) % total)
    },
    clear: (): void => {
      controller.current?.abort()
      controller.current = null
      setRequest(undefined)
      setState(undefined)
      setActive(0)
    },
  }
}
