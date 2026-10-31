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
  // Transparent on purpose: the host's own preview leaves its header on the pane surface
  // and tints only the scrolling body (`bg-document-preview`). Painting the whole pane
  // tinted turns the toolbar grey and reads as a block pasted into the app.
  background: 'transparent',
}

/** A centred placeholder that fills the same box. */
export const PANE_FILL: CSSProperties = {  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-document-preview)',
}

/** The scrolling body's surface: the host's document tint, not the app's base white. */
export const DOCUMENT_BODY: CSSProperties = {
  background: 'var(--dsw-alias-bg-document-preview)',
}

/** Background tint for the row the search navigation points at. */
export const ACTIVE_ROW = 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)'