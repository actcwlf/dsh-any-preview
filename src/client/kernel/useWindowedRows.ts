/**
 * Row windows for the CSV table, loaded after the scroll settles.
 *
 * Fixed row height means the viewport's row range is known immediately, so during a drag the
 * table can render placeholders and only read the real window once scrolling stops. A
 * generation counter makes a late read harmless: whichever read finishes last wins only if
 * its window is still the one the viewport wants.
 */
import { useEffect, useRef, useState } from 'react'
import { cacheCapacity, planWindow } from './csv-window-state.ts'
import { readWindow } from './csv-window.ts'
import type { CsvIndex } from './csv-index.ts'

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
}

/** Everything the hook needs from the preview. */
export interface WindowedRowsOptions {
  readonly text: string
  readonly index: CsvIndex | null
  readonly delimiter: string
  readonly scrollTop: number
  readonly viewportHeight: number
  /** Total rows, header included: exact once the index is complete, estimated before. */
  readonly totalRows: number
  readonly rowHeight: number
  readonly windowSize?: number
  /** Milliseconds of quiet before a window is read. */
  readonly settleMs?: number
  /** Longest row kept; a longer one stops parsing, as the row buffer does. */
  readonly maxLineChars?: number
}

/** One cached window: its rows plus the condition that stopped the parse. */
interface CachedWindow {
  readonly rows: string[][]
  readonly overlong: boolean
}

/**
 * Pick the window for the current scroll position and read it once scrolling settles.
 * @param options - text, index, geometry and timing.
 * @returns the rows to render plus their absolute start.
 */
export function useWindowedRows(options: WindowedRowsOptions): WindowRows {
  const {
    text, index, delimiter, scrollTop, viewportHeight, totalRows, rowHeight,
    windowSize = 5000, settleMs = 200, maxLineChars,
  } = options

  const cache = useRef(new Map<number, CachedWindow>())
  const cachedText = useRef(-1)
  const generation = useRef(0)
  const [settled, setSettled] = useState(0)

  // More text invalidates every window that ended at the old text end: its rows were
  // cut short and the page just delivered may complete them.
  if (cachedText.current !== text.length) {
    cache.current.clear()
    cachedText.current = text.length
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
  // resetting this timer, so a fast drag reads nothing at all.
  useEffect(() => {
    if (index === null || cached !== undefined) return undefined
    const timer = setTimeout(() => { setSettled(value => value + 1) }, settleMs)
    return () => { clearTimeout(timer) }
  }, [index, cached, plan.window, settleMs, scrollTop])

  useEffect(() => {
    if (index === null || cached !== undefined || settled === 0) return
    const token = ++generation.current
    const read = readWindow(text, index, plan.alignedStart, plan.count, delimiter, maxLineChars)
    if (token !== generation.current) return
    cache.current.set(plan.window, { rows: read.rows, overlong: read.overlong })
    const capacity = cacheCapacity(windowSize)
    while (cache.current.size > capacity) {
      const oldest = cache.current.keys().next().value
      if (oldest === undefined) break
      cache.current.delete(oldest)
    }
    setSettled(0)
  }, [settled, index, cached, plan.alignedStart, plan.count, plan.window, text, delimiter, windowSize, maxLineChars])

  // No index means the caller is not windowing: render nothing at all rather than a
  // whole window of placeholders nobody asked for.
  if (index === null) return { startRow: 0, rows: [], loading: false, overlong: false }

  if (cached !== undefined) {
    return { startRow: plan.alignedStart, rows: cached.rows, loading: false, overlong: cached.overlong }
  }
  // No rows to stand in for: the caller paints the visible band from `loading`, so a
  // window of 5,000 placeholder rows would be allocation without a reader.
  return { startRow: plan.alignedStart, rows: [], loading: true, overlong: false }
}
