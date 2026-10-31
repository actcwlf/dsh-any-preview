/**
 * Row windows for the CSV table, loaded after the scroll settles.
 *
 * Fixed row height means the viewport's row range is known immediately, so during a drag the
 * table can render placeholders and only read the real window once scrolling stops. A
 * generation counter makes a late read harmless: whichever read finishes last wins only if
 * its window is still the one the viewport wants.
 */
import { useEffect, useRef, useState } from 'react'
import { cacheCapacity, placeholderRows, planWindow } from './csv-window-state.ts'
import { readWindow } from './csv-window.ts'
import type { CsvIndex } from './csv-index.ts'

/** What the table needs for one render. */
export interface WindowRows {
  /** Absolute index of the first row below (header excluded). */
  readonly startRow: number
  /** Rows to render; empty arrays while the window is still loading. */
  readonly rows: readonly (readonly string[])[]
  /** True while the shown rows are placeholders. */
  readonly loading: boolean
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
}

/**
 * Pick the window for the current scroll position and read it once scrolling settles.
 * @param options - text, index, geometry and timing.
 * @returns the rows to render plus their absolute start.
 */
export function useWindowedRows(options: WindowedRowsOptions): WindowRows {
  const {
    text, index, delimiter, scrollTop, viewportHeight, totalRows, rowHeight,
    windowSize = 5000, settleMs = 200,
  } = options

  const cache = useRef(new Map<number, string[][]>())
  const generation = useRef(0)
  const [settled, setSettled] = useState(0)

  const plan = planWindow(scrollTop, viewportHeight, rowHeight, windowSize, totalRows)
  const cached = cache.current.get(plan.window)

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
    const rows = readWindow(text, index, plan.alignedStart, plan.count, delimiter).rows
    if (token !== generation.current) return
    cache.current.set(plan.window, rows)
    const capacity = cacheCapacity(windowSize)
    while (cache.current.size > capacity) {
      const oldest = cache.current.keys().next().value
      if (oldest === undefined) break
      cache.current.delete(oldest)
    }
    setSettled(0)
  }, [settled, index, cached, plan.alignedStart, plan.count, plan.window, text, delimiter, windowSize])

  if (cached !== undefined) {
    return { startRow: plan.alignedStart, rows: cached, loading: false }
  }
  return { startRow: plan.alignedStart, rows: placeholderRows(plan.count), loading: true }
}
