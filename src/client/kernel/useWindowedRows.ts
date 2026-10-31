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
 * these numbers changed", and `source` names the thing behind them, so a cache entry is
 * dropped when either changes.
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
  /** Names the source behind `revision`: a change of key drops every window too. */
  readonly source?: string
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
    read, revision, source = '', enabled, scrollTop, viewportHeight, totalRows, rowHeight,
    windowSize = 5000, settleMs = 200,
  } = options

  const cache = useRef(new Map<number, WindowRead>())
  const cachedRevision = useRef(-1)
  const cachedSource = useRef('')
  const generation = useRef(0)
  const reader = useRef(read)
  reader.current = read
  // The last window painted, kept so a re-read of the same window does not blank it:
  // an invalidated window still holds the rows the reader is looking at.
  const lastRead = useRef<{ readonly window: number, readonly read: WindowRead } | null>(null)
  // A cache write is invisible to React, so a landed read bumps this to paint it.
  const [, setLanded] = useState(0)

  // Rows, their numbering, or the source behind them changed: every window that
  // described the old ones is stale.
  if (cachedRevision.current !== revision || cachedSource.current !== source) {
    cache.current.clear()
    cachedRevision.current = revision
    cachedSource.current = source
  }

  const plan = planWindow(scrollTop, viewportHeight, rowHeight, windowSize, totalRows)
  const cached = cache.current.get(plan.window)
  if (cached !== undefined) {
    // Re-insert to move the entry to the back of the eviction order: the map is the
    // LRU queue, and a window the reader keeps returning to must not age out.
    cache.current.delete(plan.window)
    cache.current.set(plan.window, cached)
    lastRead.current = { window: plan.window, read: cached }
  }

  // One scheduler, not two: a window that is missing gets read after the viewport has
  // been quiet for `settleMs` — so a fast drag reads nothing — and at once when the cache
  // is empty, because then the table has nothing at all to show. A landed read bumps
  // state, which ends this effect's turn; a failed one changes nothing, so it cannot
  // spin, and the next scroll, revision or source change retries it.
  useEffect(() => {
    if (!enabled || cached !== undefined) return undefined
    const token = ++generation.current
    let live = true
    const delay = cache.current.size === 0 ? 0 : settleMs
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await reader.current(plan.alignedStart, plan.count)
          if (!live || token !== generation.current) return
          cache.current.set(plan.window, result)
          lastRead.current = { window: plan.window, read: result }
          const capacity = cacheCapacity(windowSize)
          while (cache.current.size > capacity) {
            const oldest = cache.current.keys().next().value
            if (oldest === undefined) break
            cache.current.delete(oldest)
          }
          setLanded(value => value + 1)
        } catch {
          // Leave the placeholders; the next scroll or revision tries again.
        }
      })()
    }, delay)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [enabled, cached, plan.alignedStart, plan.count, plan.window, revision, source, windowSize, scrollTop, settleMs])

  // No windowing means nothing to show: the caller paints from its own rows.
  if (!enabled) return NOTHING

  if (cached !== undefined) {
    return { startRow: plan.alignedStart, rows: cached.rows, loading: false, overlong: cached.overlong, exact: cached.exact }
  }
  // The window was invalidated but the reader is looking at the same one: keep those
  // rows up until the re-read lands (their numbering may change by a row at the end).
  const stale = lastRead.current
  if (stale !== null && stale.window === plan.window) {
    return { startRow: plan.alignedStart, rows: stale.read.rows, loading: false, overlong: stale.read.overlong, exact: stale.read.exact }
  }
  // No rows to stand in for: the caller paints the visible band from `loading`, so a
  // window of 5,000 placeholder rows would be allocation without a reader.
  return { startRow: plan.alignedStart, rows: [], loading: true, overlong: false, exact: true }
}
