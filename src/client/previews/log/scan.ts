/** Whole-file log search: line results, progress, stop and cursor-paged navigation. */
import { useEffect, useRef, useState } from 'react'
import { compileSearch } from '../../kernel/search.ts'
import { trimPageCache } from '../../kernel/page-cache.ts'
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
  readonly start: () => void
  readonly stop: () => void
  readonly next: () => void
  readonly prev: () => void
  readonly clear: () => void
}

/**
 * Run one full-file scan for the current query, with line navigation.
 * @param options - runner, page loader, query and query modes.
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
  const [active, setActive] = useState(0)
  const [pageIndex, setPageIndex] = useState(0)
  const [pageLines, setPageLines] = useState<readonly number[] | undefined>(undefined)
  const [loadingPage, setLoadingPage] = useState(false)
  const [pageError, setPageError] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const pageAbort = useRef<AbortController | null>(null)
  const loadingRef = useRef(false)
  const keyRef = useRef(sourceKey)
  const pageCache = useRef(new Map<number, readonly number[]>())
  const patternRef = useRef<RegExp | undefined>(undefined)
  const loaderRef = useRef(loadPage)
  loaderRef.current = loadPage

  useEffect(() => {
    if (request !== undefined && request.query !== query) {
      controller.current?.abort()
      controller.current = null
      pageAbort.current?.abort()
      pageAbort.current = null
      pageCache.current.clear()
      setRequest(undefined)
      setState(undefined)
      setActive(0)
      setPageIndex(0)
      setPageLines(undefined)
      setLoadingPage(false)
      setPageError(false)
      loadingRef.current = false
    }
  }, [query, request])

  useEffect(() => {
    if (state !== undefined && state.query !== query) {
      controller.current?.abort()
      controller.current = null
      pageAbort.current?.abort()
      pageAbort.current = null
      pageCache.current.clear()
      setRequest(undefined)
      setState(undefined)
      setActive(0)
      setPageIndex(0)
      setPageLines(undefined)
      setLoadingPage(false)
      setPageError(false)
      loadingRef.current = false
    }
  }, [query, state])

  useEffect(() => {
    if (keyRef.current === sourceKey) return undefined
    keyRef.current = sourceKey
    controller.current?.abort()
    controller.current = null
    pageAbort.current?.abort()
    pageAbort.current = null
    pageCache.current.clear()
    setRequest(undefined)
    setState(undefined)
    setActive(0)
    setPageIndex(0)
    setPageLines(undefined)
    setLoadingPage(false)
    setPageError(false)
    loadingRef.current = false
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
    pageCache.current.clear()
    patternRef.current = pattern
    setActive(0)
    setPageIndex(0)
    setPageLines(undefined)
    setLoadingPage(false)
    setPageError(false)
    loadingRef.current = false
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
      pageCache.current.set(0, result.lines)
      setPageIndex(0)
      setPageLines(result.lines)
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

  const lines = pageLines ?? (state?.lines ?? [])
  const count = state?.matches ?? 0
  const pageCount = state?.pages.length !== undefined && state.pages.length > 0
    ? Math.ceil(state.matches / LOG_MATCH_LIMIT)
    : 1
  const index = lines.length === 0 ? -1 : Math.min(active, lines.length - 1)
  const activeLine = index < 0 ? undefined : lines[index]
  const globalIndex = index < 0 ? -1 : pageIndex * LOG_MATCH_LIMIT + index

  const resetPages = (): void => {
    pageAbort.current?.abort()
    pageAbort.current = null
    pageCache.current.clear()
    loadingRef.current = false
    setPageIndex(0)
    setPageLines(undefined)
    setLoadingPage(false)
    setPageError(false)
  }

  const load = (page: number, position: 'first' | 'last'): void => {
    if (loadingRef.current || page < 0 || page >= pageCount || page === pageIndex || lines.length === 0) return
    const cached = pageCache.current.get(page)
    if (cached !== undefined) {
      setPageIndex(page)
      setPageLines(cached)
      setActive(position === 'last' ? Math.max(0, cached.length - 1) : 0)
      return
    }
    const loader = loaderRef.current
    const pattern = patternRef.current
    const cursor = state?.pages[page - 1]
    if (loader === undefined || pattern === undefined || cursor === undefined) return
    pageAbort.current?.abort()
    const abort = new AbortController()
    pageAbort.current = abort
    loadingRef.current = true
    setPageError(false)
    setLoadingPage(true)
    void loader(pattern, cursor, abort.signal, LOG_MATCH_LIMIT).then((next) => {
      if (abort.signal.aborted) return
      pageCache.current.set(page, next)
      trimPageCache(pageCache.current, page)
      setPageIndex(page)
      setPageLines(next)
      setActive(position === 'last' ? Math.max(0, next.length - 1) : 0)
    }).catch(() => {
      if (!abort.signal.aborted) setPageError(true)
    })
      .finally(() => {
        loadingRef.current = false
        if (!abort.signal.aborted) setLoadingPage(false)
      })
  }

  const start = (): void => {
    if (query === '') return
    resetPages()
    setRequest({ query })
    setState(undefined)
    setActive(0)
  }
  const stop = (): void => {
    controller.current?.abort()
    pageAbort.current?.abort()
    pageAbort.current = null
    loadingRef.current = false
    setLoadingPage(false)
    setState(current => current === undefined ? undefined : { ...current, done: true, aborted: true })
  }
  const next = (): void => {
    if (loadingRef.current) return
    if (lines.length === 0) return
    if (index + 1 < lines.length) setActive(index + 1)
    else if (pageIndex + 1 < pageCount) load(pageIndex + 1, 'first')
    else if (pageCount > 1) load(0, 'first')
    else setActive(0)
  }
  const prev = (): void => {
    if (loadingRef.current) return
    if (lines.length === 0) return
    if (index > 0) setActive(index - 1)
    else if (pageIndex > 0) load(pageIndex - 1, 'last')
    else if (pageCount > 1) load(pageCount - 1, 'last')
    else setActive(Math.max(0, lines.length - 1))
  }
  const clear = (): void => {
    controller.current?.abort()
    controller.current = null
    resetPages()
    setRequest(undefined)
    setState(undefined)
    setActive(0)
  }

  return {
    state,
    count,
    index: globalIndex,
    activeLine,
    loadingPage,
    pageError,
    start,
    stop,
    next,
    prev,
    clear,
  }
}
