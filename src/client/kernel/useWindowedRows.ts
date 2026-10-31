/**
 * Row windows for the CSV table, loaded after the scroll settles.
 *
 * Fixed row height means the viewport's row range is known immediately, so during a
 * drag the table can render placeholders and only read the real window once scrolling
 * stops. A generation counter makes a late read harmless: whichever read finishes last
 * wins only if its window is still the one the viewport wants.
 *
 * The read itself may be synchronous (rows already in the text) or a file slice, so it
 * is always awaited; `revision` is whatever the caller uses to say "the rows behind
 * these numbers changed", and a cache entry is dropped when it changes.
 */
import { useEffect, useRef, useState } from 'react'
import { cacheCapacity, planWindow } from './csv-window-state.ts'

/** One window read. */
export interface WindowRead {
  readonly rows: string[][]
  /** True when a row passed the line cap and parsing stopped there. */
  readonly overlong: boolean
  /** False when the row numbers are estimates (a file jump past the built index). */
  readonly exact: boolean
}

/** What the table needs for one render. */
export interface WindowRows {
  /** Absolute index of the first row below (header excluded). */
  readonly startRow: number
  /** Rows to render; empty while the window is still loading. */
  readonly rows: readonly (readonly string[])[]
  /** True while the window has not been read yet. */
  readonly loading: boolean
  /** True when a row in the shown window passed the line cap. */
  readonly overlong: boolean
  /** True when the row numbers come from an index rather than an estimate. */
  readonly exact: boolean
}

/** Everything the hook needs from the preview. */
export interface WindowedRowsOptions {
  /** Read one window, `count` rows from `startRow` (file rows, header included). */
  readonly read: (startRow: number, count: number) => Promise<WindowRead>
  /** Bumps whenever the rows or their numbering changed. */
  readonly revision: number
  /** False when the caller is not windowing at all. */
  readonly enabled: boolean
  readonly scrollTop: number
  readonly viewportHeight: number
  /** Total rows, header included: exact once the index is complete, estimated before. */
  readonly totalRows: number
  readonly rowHeight: number
  readonly windowSize?: number
  /** Milliseconds of quiet before a window is read. */
  readonly settleMs?: number
}

/** What the table gets when the caller is not windowing. */
const NOTHING: WindowRows = { startRow: 0, rows: [], loading: false, overlong: false, exact: true }

/**
 * Pick the window for the current scroll position and read it once scrolling settles.
 * @param options - read function, geometry and timing.
 * @returns the rows to render plus their absolute start.
 */
export function useWindowedRows(options: WindowedRowsOptions): WindowRows {
  const {
    read, revision, enabled, scrollTop, viewportHeight, totalRows, rowHeight,
    windowSize = 5000, settleMs = 200,
  } = options

  const cache = useRef(new Map<number, WindowRead>())
  const cachedRevision = useRef(-1)
  const generation = useRef(0)
  const reader = useRef(read)
  reader.current = read
  const readFailed = useRef(false)
  // Start settled: the first window of a freshly opened table has nothing to wait for.
  const [settled, setSettled] = useState(1)

  // Rows or their numbering changed: every window that described them is stale.
  if (cachedRevision.current !== revision) {
    cache.current.clear()
    cachedRevision.current = revision
  }

  const plan = planWindow(scrollTop, viewportHeight, rowHeight, windowSize, totalRows)
  const cached = cache.current.get(plan.window)
  if (cached !== undefined) {
    // Re-insert to move the entry to the back of the eviction order: the map is the
    // LRU queue, and a window the reader keeps returning to must not age out.
    cache.current.delete(plan.window)
    cache.current.set(plan.window, cached)
  }

  // Only fetch after the scroll has been quiet for `settleMs`; a moving viewport keeps
  // resetting this timer, so a fast drag reads nothing at all. The very first window is
  // read at once — nothing is being dragged yet — unless a read already failed.
  useEffect(() => {
    if (!enabled || cached !== undefined) return undefined
    if (cache.current.size === 0 && !readFailed.current) {
      setSettled(1)
      return undefined
    }
    const timer = setTimeout(() => { setSettled(value => value + 1) }, settleMs)
    return () => { clearTimeout(timer) }
  }, [enabled, cached, plan.window, settleMs, scrollTop])

  useEffect(() => {
    if (!enabled || cached !== undefined || settled === 0) return undefined
    const token = ++generation.current
    let live = true
    const startRow = plan.alignedStart
    const count = plan.count
    void (async () => {
      try {
        const result = await reader.current(startRow, count)
        if (!live || token !== generation.current) return
        readFailed.current = false
        cache.current.set(plan.window, result)
        const capacity = cacheCapacity(windowSize)
        while (cache.current.size > capacity) {
          const oldest = cache.current.keys().next().value
          if (oldest === undefined) break
          cache.current.delete(oldest)
        }
      } catch {
        // A failed read leaves the placeholders in place; the next scroll retries.
        if (live) readFailed.current = true
      }
      if (live) setSettled(0)
    })()
    return () => { live = false }
  }, [settled, enabled, cached, plan.alignedStart, plan.count, plan.window, revision, windowSize])

  // No windowing means nothing to show: the caller paints from its own rows.
  if (!enabled) return NOTHING

  if (cached !== undefined) {
    return { startRow: plan.alignedStart, rows: cached.rows, loading: false, overlong: cached.overlong, exact: cached.exact }
  }
  // No rows to stand in for: the caller paints the visible band from `loading`, so a
  // window of 5,000 placeholder rows would be allocation without a reader.
  return { startRow: plan.alignedStart, rows: [], loading: true, overlong: false, exact: true }
}
