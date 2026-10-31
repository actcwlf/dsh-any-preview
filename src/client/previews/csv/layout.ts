/**
 * The table's physical constants, shared by the body, the scroll hook and the view.
 *
 * The header's box is part of the geometry, not decoration: the rows start below it, so
 * how many rows fit the viewport — and therefore where the proportional scrollbar puts
 * the last screen — depends on it.
 */

/** Fixed row height; the table never squeezes its rows. */
export const ROW_HEIGHT = 22

/**
 * The header's box: 5px padding above and below, one 12px line, and the bottom rule.
 * Chromium lays the real header out at 26.5px; 27 is the conservative integer, which
 * keeps "one more row fits" false rather than true.
 */
export const HEADER_HEIGHT = 27

/**
 * Browsers stop growing an element's scroll height near 2^24 px (about 727,000 rows at
 * 22px). Past that the scrollbar turns proportional instead of the rows shrinking.
 */
export const SCROLL_LIMIT_PX = 16_777_216

/** Rows rendered above and below the viewport to cover fast scrolling. */
export const OVERSCAN = 8

/** Rows per window, and the quiet time after a drag before that window is read. */
export const WINDOW_ROWS = 5_000
export const SETTLE_MS = 200
