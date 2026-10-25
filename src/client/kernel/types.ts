/**
 * Shared preview contracts. Every format in `previews/` implements
 * `PreviewModule`; the client entry registers the array and nothing else
 * needs to know about individual formats.
 */
import type { ComponentType } from 'react'

/** Accumulated text window; the final page marks the file complete. */
export interface TextContent {
  readonly kind: 'text'
  readonly text: string
  readonly eof: boolean
}

/** One complete byte buffer. */
export interface BytesContent {
  readonly kind: 'bytes'
  readonly data: Uint8Array
}

/** The renderer loads its own content; the owner only tracks the revision. */
export interface RendererContent {
  readonly kind: 'renderer'
  readonly revision: number
  readonly loaded: (version: string) => void
  readonly failed: () => void
  readonly reload: () => void
}

/** What the document owner hands a renderer body. */
export type DocumentContent = TextContent | BytesContent | RendererContent

/** Metadata the `file` resource publishes for the previewed file. */
export interface FileMeta {
  readonly absolutePath?: string
  readonly version?: string
  readonly size?: number
}

/** Input every preview body receives. */
export interface PreviewBodyProps {
  readonly content: DocumentContent
  readonly resourceAddress: string
  readonly wrap: boolean
  readonly scrollportRef?: (element: HTMLElement | null) => void
  readonly useResource?: (address: string) => { readonly value?: FileMeta }
}

/** One preview implementation, independent of how it is registered. */
export interface PreviewModule {
  /** Unique across the package; also the document renderer id and slot key. */
  readonly id: string
  /** Suffixes claimed without a leading dot. */
  readonly extensions: readonly string[]
  /** Suffixes among `extensions` whose bytes are not text; suppresses the text fallback. */
  readonly binary?: readonly string[]
  /** How the owner delivers content. */
  readonly load: 'text-pages' | 'bytes-complete' | 'renderer'
  /** Whether this body honours the shared wrap preference. */
  readonly wrap?: boolean
  /** Toolbar label. */
  readonly title: () => string
  /** The body rendered inside the document seat. */
  readonly Body: ComponentType<PreviewBodyProps>
}
