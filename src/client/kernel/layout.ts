/**
 * Layout for a preview body that owns its own scrollport.
 *
 * The document owner's `.body` is `position: relative` and may be the scroller
 * itself, so a body that keeps a fixed toolbar must fill that box outright
 * instead of relying on a percentage height: an absolutely positioned root is
 * exactly the owner's content box, and everything scrolls inside it.
 */
import type { CSSProperties } from 'react'

/** Root of a pane-filling body: pinned to the owner's content box. */
export const PANE_ROOT: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  // Opaque on purpose. The owner renders its own "load more" row under this box for a
  // document that still has pages (it cannot know a preview reads the file itself), so a
  // transparent pane shows that button through the title bar.
  background: 'var(--dsw-alias-bg-base)',
}

/** A centred placeholder that fills the same box. */
export const PANE_FILL: CSSProperties = {  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-base)',
}

/** Background tint for the row the search navigation points at. */
export const ACTIVE_ROW = 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)'