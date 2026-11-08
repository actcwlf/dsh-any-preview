/**
 * Scroll geometry for a fixed-height row viewer (log or JSONL).
 *
 * The body has no table header, so its rows start at the top of the scroller. Past the
 * browser's scroll-height cap the scrollbar becomes proportional, exactly like the CSV
 * table, while the rows keep their natural height.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { logicalRow, proportionalGeometry } from './window-state.ts'
import type { ProportionalGeometry } from './window-state.ts'

/** Natural height of one code-style row. */
export const DEFAULT_ROW_HEIGHT = 18

/** Space left below the viewport so a drag can reveal the next row early. */
export const DEFAULT_OVERSCAN = 40

/** Browser-safe maximum content height, leaving room for the viewport. */
const SCROLL_LIMIT_PX = 16_000_000

/** Viewport height before the first measurement. */
const FALLBACK_VIEWPORT = 480

/** Scroll state and geometry for one fixed-row viewer. */
export interface FixedRowScroll {
  readonly scrollTop: number
  readonly viewportHeight: number
  readonly totalRows: number
  readonly geometry: ProportionalGeometry | undefined
  readonly mappingPitch: number
  readonly logical: number
  readonly contentHeight: number
  readonly bindScroller: (element: HTMLDivElement | null) => void
  readonly setScrollTop: (top: number) => void
  readonly scrollToBottom: () => void
  readonly reveal: (row: number) => void
}

/** What the fixed-row scroll hook needs. */
export interface FixedRowScrollOptions {
  readonly scrollportRef?: (element: HTMLElement | null) => void
  readonly ready: boolean
  readonly totalRows: number
  readonly rowHeight?: number
}

/**
 * Track a fixed-row scroller and derive its row geometry.
 * @param options - readiness, total lines and optional row height.
 * @returns scroll state and helpers.
 */
export function useFixedRowScroll(options: FixedRowScrollOptions): FixedRowScroll {
  const { scrollportRef, ready, totalRows, rowHeight = DEFAULT_ROW_HEIGHT } = options
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT)

  const geometry = useMemo(() => (
    totalRows * rowHeight > SCROLL_LIMIT_PX
      ? proportionalGeometry(totalRows, viewportHeight, rowHeight, SCROLL_LIMIT_PX, 0)
      : undefined
  ), [totalRows, rowHeight, viewportHeight])

  const mappingPitch = geometry === undefined ? rowHeight : geometry.pitch
  const logical = geometry === undefined
    ? Math.max(0, Math.floor(scrollTop / rowHeight))
    : logicalRow(scrollTop, geometry, totalRows)
  const contentHeight = geometry === undefined ? Math.max(0, totalRows * rowHeight) : geometry.contentHeight

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
      setScrollTop(element.scrollTop)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ready])

  const scrollToBottom = useCallback((): void => {
    const element = scrollerRef.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
    setScrollTop(element.scrollTop)
  }, [])

  const reveal = useCallback((row: number): void => {
    const element = scrollerRef.current
    if (element === null) return
    const wanted = geometry === undefined
      ? Math.max(0, row * rowHeight - element.clientHeight / 2)
      : Math.max(0, (row - geometry.visibleRows / 2) * geometry.pitch)
    const top = geometry === undefined ? wanted : Math.min(wanted, geometry.maxScroll)
    element.scrollTop = top
    setScrollTop(top)
  }, [geometry, rowHeight])

  return {
    scrollTop,
    viewportHeight,
    totalRows,
    geometry,
    mappingPitch,
    logical,
    contentHeight,
    bindScroller,
    setScrollTop,
    scrollToBottom,
    reveal,
  }
}
