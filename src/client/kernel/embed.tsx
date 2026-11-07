/**
 * Embedded-preview context.
 *
 * A preview body normally owns its own chrome. When the same body is rendered
 * inside an archive entry, the entry provides the back action and member label
 * here; `PreviewChrome` adds a leading back button instead of stacking a second
 * archive bar above the module's bar.
 */
import { createContext, useContext } from 'react'

/** The back affordance and member label supplied by an embedding container. */
export interface PreviewEmbed {
  /** Return to the embedding container (the archive list). */
  readonly onBack: () => void
  /** Member/file label shown before the module's own title. */
  readonly label?: string
}

/** Null outside an embedded preview; a normal preview renders no back button. */
export const PreviewEmbedContext = createContext<PreviewEmbed | null>(null)

/** Read the current embedded-preview metadata, if any. */
export function usePreviewEmbed(): PreviewEmbed | null {
  return useContext(PreviewEmbedContext)
}
