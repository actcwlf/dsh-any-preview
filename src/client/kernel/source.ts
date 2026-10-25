/**
 * Normalize the owner's three delivery modes into one shape so a body never
 * branches on how its content arrived.
 */
import type { DocumentContent } from './types.ts'

/** What a preview body actually consumes. */
export type PreviewSource =
  | { readonly kind: 'text', readonly text: string, readonly eof: boolean }
  | { readonly kind: 'bytes', readonly data: Uint8Array }
  | { readonly kind: 'stream' }
  | { readonly kind: 'none' }

/**
 * Project owner content onto the source a body reads.
 * @param content - the document owner's content union.
 * @returns the normalized source.
 */
export function previewSourceOf(content: DocumentContent): PreviewSource {
  if (content.kind === 'text') return { kind: 'text', text: content.text, eof: content.eof }
  if (content.kind === 'bytes') return { kind: 'bytes', data: content.data }
  return { kind: 'stream' }
}

/**
 * Read the accumulated text, or an empty string for other modes.
 * @param content - the document owner's content union.
 * @returns the text prefix.
 */
export function textOf(content: DocumentContent): string {
  return content.kind === 'text' ? content.text : ''
}
