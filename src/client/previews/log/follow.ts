/**
 * Tail-follow behaviour for the log viewer.
 *
 * Two rules, both worth pinning down without a DOM:
 *   - stick to the bottom only while the user is already at the bottom;
 *   - reading history turns follow off, and returning to the bottom turns it
 *     back on (unless the user switched it off by hand).
 */

/** How close to the bottom still counts as "at the bottom", in pixels. */
export const FOLLOW_THRESHOLD = 24

/**
 * Whether a scroll position counts as the bottom of the list.
 * @param scrollTop - current offset.
 * @param scrollHeight - total content height.
 * @param clientHeight - visible height.
 * @param threshold - slack in pixels.
 * @returns true when the last row is visible.
 */
export function isAtBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold: number = FOLLOW_THRESHOLD,
): boolean {
  if (scrollHeight <= clientHeight) return true
  return scrollHeight - (scrollTop + clientHeight) <= threshold
}

/**
 * Decide the follow flag after the user scrolls.
 *
 * Distinguishes "auto-follow was turned off by reading history" from "the user
 * unchecked the box": only the former is re-enabled by scrolling back down.
 * @param input - current state and the measured scroll position.
 * @returns the next follow flag, and whether it was changed by the user.
 */
export function followAfterScroll(input: {
  readonly follow: boolean
  readonly manualOff: boolean
  readonly atBottom: boolean
}): boolean {
  if (input.manualOff) return input.follow
  return input.atBottom
}
