/** Whole-file log search: line results, progress, stop and cursor-paged navigation. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { compileSearch } from '../../kernel/search.ts'
import { usePagedResults } from '../../kernel/usePagedResults.ts'
import { LOG_MATCH_LIMIT } from './search.ts'
import type { LogScanOptions, LogScanResult } from './search.ts'

/** A scan function over a file or a delivered text. */
export type LogScanRunner = (pattern: RegExp, options: LogScanOptions) => Promise<LogScanResult>

/** Loads one page of matching lines at or after a line cursor. */
export type LogPageRunner = (
  pattern: RegExp,
  cursor: number,
  signal: AbortSignal,
  limit: number,
) => Promise<readonly number[]>

/** Scan state for one query. */
export interface LogScanState {
  readonly query: string
  readonly progress: number
  /** Matching lines in the whole file so far. */
  readonly matches: number
  /** Matching lines kept for the current navigation page. */
  readonly lines: readonly number[]
  /** First matching line of each page after the first. */
  readonly pages: readonly number[]
  readonly done: boolean
  readonly aborted: boolean
}

/** What the log body needs for full-file search. */
export interface LogScan {
  readonly state: LogScanState | undefined
  readonly count: number
  readonly index: number
  readonly activeLine: number | undefined
  readonly loadingPage: boolean
  readonly pageError: boolean
  readonly page: number
  readonly pageCount: number
  readonly goToPage: (page: number) => void
  readonly start: () => void
  readonly stop: () => void
  readonly next: () => void
  readonly prev: () => void
  readonly clear: () => void
}

/** No lines/page starts yet; stable identities so the pager does not reset every render. */
const NO_LINES: readonly number[] = []
const NO_PAGES: readonly number[] = []

/**
 * Run one full-file scan for the current query, with line navigation.
 * @param options - runner, page loader, source identity, query and query modes.
 * @returns scan state and navigation.
 */
export function useLogScan(options: {
  readonly scan: LogScanRunner | undefined
  readonly loadPage?: LogPageRunner
  /** Changes when the underlying file/text source changes. */
  readonly sourceKey: string
  readonly query: string
  readonly regex: boolean
  readonly caseSensitive: boolean
}): LogScan {
  const { scan, loadPage, sourceKey, query, regex, caseSensitive } = options
  const [request, setRequest] = useState<{ readonly query: string } | undefined>(undefined)
  const [state, setState] = useState<LogScanState | undefined>(undefined)
  const controller = useRef<AbortController | null>(null)
  const keyRef = useRef(sourceKey)
  const pageAbort = useRef<AbortController | null>(null)
  const patternRef = useRef<RegExp | undefined>(undefined)
  const pageLoaderRef = useRef(loadPage)
  pageLoaderRef.current = loadPage

  useEffect(() => {
    if (request !== undefined && request.query !== query) {
      controller.current?.abort()
      controller.current = null
      pageAbort.current?.abort()
      pageAbort.current = null
      setRequest(undefined)
      setState(undefined)
    }
  }, [query, request])

  useEffect(() => {
    if (state !== undefined && state.query !== query) {
      controller.current?.abort()
      controller.current = null
      pageAbort.current?.abort()
      pageAbort.current = null
      setRequest(undefined)
      setState(undefined)
    }
  }, [query, state])

  useEffect(() => {
    if (keyRef.current === sourceKey) return undefined
    keyRef.current = sourceKey
    controller.current?.abort()
    controller.current = null
    pageAbort.current?.abort()
    pageAbort.current = null
    setRequest(undefined)
    setState(undefined)
    return undefined
  }, [sourceKey])

  useEffect(() => {
    if (request === undefined || scan === undefined) return undefined
    const pattern = compileSearch({ query: request.query, regex, caseSensitive })
    if (pattern === undefined) return undefined
    const abort = new AbortController()
    controller.current = abort
    pageAbort.current?.abort()
    pageAbort.current = null
    patternRef.current = pattern
    setState({ query: request.query, progress: 0, matches: 0, lines: [], pages: [], done: false, aborted: false })
    void scan(pattern, {
      signal: abort.signal,
      lineLimit: LOG_MATCH_LIMIT,
      onSlice: (progress, matches, lines) => {
        if (abort.signal.aborted) return
        setState(current => current === undefined
          ? undefined
          : { ...current, progress, matches, lines })
      },
    }).then((result) => {
      if (abort.signal.aborted) return
      setState({
        query: request.query,
        progress: 1,
        matches: result.matches,
        lines: result.lines,
        pages: result.pages,
        done: true,
        aborted: false,
      })
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
  }, [request, scan, regex, caseSensitive, sourceKey])

  const pageLoader = useCallback((cursor: number, signal: AbortSignal, limit: number) => {
    const loader = pageLoaderRef.current
    return loader === undefined
      ? Promise.resolve<readonly number[]>([])
      : loader(patternRef.current ?? /(?:)/gu, cursor, signal, limit)
  }, [])

  const pager = usePagedResults<number, number>({
    total: state?.matches ?? 0,
    pageSize: LOG_MATCH_LIMIT,
    pageStarts: state?.pages ?? NO_PAGES,
    initial: state?.lines ?? NO_LINES,
    resetKey: `${sourceKey}:${state?.query ?? ''}`,
    enabled: state !== undefined,
    loadPage: pageLoader,
  })

  return {
    state,
    count: state?.matches ?? 0,
    index: pager.index,
    activeLine: pager.active,
    loadingPage: pager.loading,
    pageError: pager.error,
    page: pager.page,
    pageCount: pager.pageCount,
    goToPage: pager.goToPage,
    start: (): void => {
      if (query === '') return
      setRequest({ query })
      setState(undefined)
    },
    stop: (): void => {
      controller.current?.abort()
      pageAbort.current?.abort()
      pageAbort.current = null
      pager.cancel()
      setState(current => current === undefined ? undefined : { ...current, done: true, aborted: true })
    },
    next: pager.next,
    prev: pager.prev,
    clear: (): void => {
      controller.current?.abort()
      controller.current = null
      pageAbort.current?.abort()
      pageAbort.current = null
      pager.cancel()
      setRequest(undefined)
      setState(undefined)
    },
  }
}
