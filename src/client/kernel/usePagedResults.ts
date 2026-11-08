/**
 * Cursor-paged result navigation shared by CSV, log and JSONL.
 *
 * A scan publishes the first page plus the cursor of every later page. This hook owns
 * the current page, a small neighbour cache and the global active index; formats only
 * provide a loader from a cursor to one page.
 */
import { useEffect, useRef, useState } from 'react'
import { trimPageCache } from './page-cache.ts'

/** What a format supplies to the pager. */
export interface PagedResultsOptions<T, C> {
  readonly total: number
  readonly pageSize: number
  readonly pageStarts: readonly C[]
  readonly initial: readonly T[]
  /** Changes when the query or source changes; drops every page. */
  readonly resetKey: string
  /** False while there is no scan to navigate. */
  readonly enabled: boolean
  readonly loadPage: (cursor: C, signal: AbortSignal, limit: number) => Promise<readonly T[]>
}

/** What the UI needs from the pager. */
export interface PagedResults<T> {
  readonly items: readonly T[]
  readonly index: number
  readonly active: T | undefined
  readonly globalIndex: number
  readonly loading: boolean
  readonly error: boolean
  readonly next: () => void
  readonly prev: () => void
  readonly cancel: () => void
}

/**
 * Navigate pages of search results without retaining every result.
 * @param options - first page, page cursors and page loader.
 * @returns current page and navigation.
 */
export function usePagedResults<T, C>(options: PagedResultsOptions<T, C>): PagedResults<T> {
  const { total, pageSize, pageStarts, initial, resetKey, enabled, loadPage } = options
  const [pageIndex, setPageIndex] = useState(0)
  const [items, setItems] = useState<readonly T[]>(initial)
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const loadingRef = useRef(false)
  const cache = useRef(new Map<number, readonly T[]>([[0, initial]]))
  const loaderRef = useRef(loadPage)
  loaderRef.current = loadPage
  const resetRef = useRef(resetKey)
  const initialRef = useRef(initial)

  useEffect(() => {
    if (resetRef.current === resetKey && initialRef.current === initial) return
    resetRef.current = resetKey
    initialRef.current = initial
    abortRef.current?.abort()
    abortRef.current = null
    loadingRef.current = false
    cache.current.clear()
    cache.current.set(0, initial)
    setPageIndex(0)
    setItems(initial)
    setActive(0)
    setLoading(false)
    setError(false)
  }, [resetKey, initial])

  const pageCount = enabled && pageStarts.length > 0 ? Math.ceil(total / pageSize) : 1
  const index = items.length === 0 ? -1 : Math.min(active, items.length - 1)
  const activeItem = index < 0 ? undefined : items[index]
  const globalIndex = index < 0 ? -1 : pageIndex * pageSize + index

  const load = (page: number, position: 'first' | 'last'): void => {
    if (loadingRef.current || page < 0 || page >= pageCount || page === pageIndex) return
    const cached = cache.current.get(page)
    if (cached !== undefined) {
      setPageIndex(page)
      setItems(cached)
      setActive(position === 'last' ? Math.max(0, cached.length - 1) : 0)
      return
    }
    const cursor = pageStarts[page - 1]
    if (cursor === undefined) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    loadingRef.current = true
    setLoading(true)
    setError(false)
    void loaderRef.current(cursor, controller.signal, pageSize).then((next) => {
      if (controller.signal.aborted) return
      cache.current.set(page, next)
      trimPageCache(cache.current, page)
      setPageIndex(page)
      setItems(next)
      setActive(position === 'last' ? Math.max(0, next.length - 1) : 0)
    }).catch(() => {
      if (!controller.signal.aborted) setError(true)
    }).finally(() => {
      loadingRef.current = false
      if (!controller.signal.aborted) setLoading(false)
    })
  }

  const next = (): void => {
    if (loadingRef.current || items.length === 0) return
    if (index + 1 < items.length) setActive(index + 1)
    else if (pageIndex + 1 < pageCount) load(pageIndex + 1, 'first')
    else if (pageCount > 1) load(0, 'first')
    else setActive(0)
  }
  const prev = (): void => {
    if (loadingRef.current || items.length === 0) return
    if (index > 0) setActive(index - 1)
    else if (pageIndex > 0) load(pageIndex - 1, 'last')
    else if (pageCount > 1) load(pageCount - 1, 'last')
    else setActive(Math.max(0, items.length - 1))
  }
  const cancel = (): void => {
    abortRef.current?.abort()
    abortRef.current = null
    loadingRef.current = false
    setLoading(false)
  }

  return { items, index: globalIndex, active: activeItem, globalIndex, loading, error, next, prev, cancel }
}
