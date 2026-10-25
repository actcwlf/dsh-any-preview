/** Scroll a rendered row into view by its data attribute. */

/**
 * Centre the row carrying `data-row-index` inside its scroll container.
 * @param container - the scrollable element, or null before mount.
 * @param row - the row index to reveal.
 */
export function scrollToRow(container: HTMLElement | null, row: number): void {
  if (container === null) return
  const element = container.querySelector<HTMLElement>(`[data-row-index="${String(row)}"]`)
  element?.scrollIntoView({ block: 'center' })
}
