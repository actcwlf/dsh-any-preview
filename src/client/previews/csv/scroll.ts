/**
 * Where the viewport is and how a pixel maps to a row.
 *
 * The proportional mode needs this geometry to keep its identity between renders: the
 * reveal effect depends on it, and a fresh object every render would re-run the reveal
 * after every scroll and pin the view to the last search hit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { logicalRow, proportionalGeometry } from '../../kernel/window-state.ts'
import type { ProportionalGeometry } from '../../kernel/window-state.ts'
import { HEADER_HEIGHT } from './layout.ts'

/** Viewport height before the first measurement. */
const FALLBACK_VIEWPORT = 480

/** A drag this many screens long may replace an estimated total with the exact one. */
const EXACT_SWITCH_SCREENS = 3

/** Scroll state and geometry for the table. */
export interface RowScroll {
  /** Scroller offset in pixels. */
  readonly scrollTop: number
  /** Visible height in pixels. */
  readonly viewportHeight: number
  /** Total rows, header included: exact once the index is complete, estimated before. */
  readonly totalRows: number
  /** Present only when the table is too tall to position row by row. */
  readonly geometry: ProportionalGeometry | undefined
  /** Scroll pixels per row: a row's height, or the proportional pitch. */
  readonly mappingPitch: number
  /** Body row at the top of the viewport when the bar is proportional. */
  readonly logical: number
  /** Body row the reader is looking at; where a search starts. */
  readonly currentRow: number
  /** Stable ref callback for the scroller (the owner writes its offset on attach). */
  readonly bindScroller: (element: HTMLDivElement | null) => void
  /** Adopt a scroll offset the browser already applied (the scroll event). */
  readonly setScrollTop: (top: number) => void
  /** Scroll the element and adopt the offset. */
  readonly scrollTo: (top: number) => void
  /** Scroll so `row` sits in the middle, clamped to what can be scrolled. */
  readonly reveal: (row: number) => void
}

/** What the scroll hook needs from the source. */
export interface RowScrollOptions {
  readonly scrollportRef?: (element: HTMLElement | null) => void
  /** False until the first rows are known; nothing is measured before that. */
  readonly ready: boolean
  /** True when a windowed read is the row source. */
  readonly windowed: boolean
  readonly fileMode: boolean
  /** Best-known file rows (header included). */
  readonly fileRows: number
  /** Rows the delivered text holds (header included). */
  readonly textRows: number
  readonly rowHeight: number
  /** The scroll height the browser will honour. */
  readonly scrollLimit: number
}

/**
 * Track the scroller and derive the row geometry from it.
 * @param options - readiness, row counts and row height.
 * @returns the scroll state plus the helpers the body needs.
 */
export function useRowScroll(options: RowScrollOptions): RowScroll {
  const { scrollportRef, ready, windowed, fileMode, fileRows, textRows, rowHeight, scrollLimit } = options
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const adoptRef = useRef({ shown: 0, at: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT)

  // A file's row count starts as an estimate from the bytes read and becomes exact when
  // the background walk ends. The product rule is not to swap it in immediately: the new
  // total is adopted on the next drag longer than about three screens, so the scrollbar
  // never changes length under the reader's hand.
  const totalRows = useMemo(() => {
    if (!fileMode) {
      adoptRef.current.shown = 0
      return Math.max(1, textRows)
    }
    const hold = adoptRef.current
    if (hold.shown === 0 || Math.abs(scrollTop - hold.at) > EXACT_SWITCH_SCREENS * viewportHeight) {
      hold.shown = Math.max(1, fileRows)
      hold.at = scrollTop
    }
    return Math.max(1, hold.shown)
  }, [fileMode, fileRows, textRows, scrollTop, viewportHeight])

  const bodyRows = windowed ? Math.max(0, totalRows - 1) : 0
  // Memoized on purpose: the object must not change identity while neither the row count
  // nor the viewport did, or the reveal below re-runs on every render.
  const geometry = useMemo(() => (
    windowed && bodyRows * rowHeight > scrollLimit
      ? proportionalGeometry(bodyRows, viewportHeight, rowHeight, scrollLimit, HEADER_HEIGHT)
      : undefined
  ), [windowed, bodyRows, rowHeight, scrollLimit, viewportHeight])
  const mappingPitch = geometry === undefined ? rowHeight : geometry.pitch
  const logical = geometry === undefined ? 0 : logicalRow(scrollTop, geometry, bodyRows)
  const currentRow = Math.max(0, Math.floor(geometry === undefined ? scrollTop / rowHeight : logical))

  // A stable ref: an inline one detaches and re-attaches every render, and the owner
  // writes its remembered scroll offset on every attach — which fights a window drag.
  const bindScroller = useCallback((element: HTMLDivElement | null) => {
    scrollerRef.current = element
    scrollportRef?.(element)
  }, [scrollportRef])

  useEffect(() => {
    if (!ready) return undefined
    const element = scrollerRef.current
    if (element === null) return undefined
    const measure = (): void => {
      setViewportHeight(element.clientHeight)
      // The owner restores its remembered offset while attaching the ref; adopting it
      // here keeps the first painted band on the rows the reader left behind.
      setScrollTop(element.scrollTop)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ready])

  const reveal = useCallback((row: number): void => {
    const element = scrollerRef.current
    if (element === null) return
    // In the proportional mode a scroll pixel is worth `pitch` rows, so the match is
    // placed by rows: half a viewport in pixels is far more than half a screen of rows
    // there, and would push the row below the fold.
    const wanted = geometry === undefined
      ? Math.max(0, row * rowHeight - element.clientHeight / 2)
      : Math.max(0, (row - geometry.visibleRows / 2) * geometry.pitch)
    const top = geometry === undefined ? wanted : Math.min(wanted, geometry.maxScroll)
    element.scrollTop = top
    setScrollTop(top)
  }, [geometry, rowHeight])

  const scrollTo = useCallback((top: number): void => {
    const element = scrollerRef.current
    if (element === null) return
    element.scrollTop = top
    setScrollTop(top)
  }, [])

  return {
    scrollTop, viewportHeight, totalRows, geometry, mappingPitch, logical, currentRow,
    bindScroller, setScrollTop, scrollTo, reveal,
  }
}



