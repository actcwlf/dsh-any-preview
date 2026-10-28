/**
 * Measure an element's width without a layout library.
 *
 * The sidebar can be dragged down to its minimum width, and a fixed breakpoint
 * cannot know that minimum. Measuring the element itself keeps the decision local
 * to the component and works at any width the shell allows.
 */
import { useEffect, useRef, useState } from 'react'

/**
 * Track an element's content width.
 * @returns a ref to attach and the current width (0 before the first measurement).
 */
export function useElementWidth<T extends HTMLElement>(): {
  ref: ReturnType<typeof useRef<T | null>>
  width: number
} {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    setWidth(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') {
      return () => {}
    }
    const observer = new ResizeObserver(() => { setWidth(element.clientWidth) })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  return { ref, width }
}
