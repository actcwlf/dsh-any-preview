/**
 * The document lifecycle every self-loading format needs: read the file
 * metadata, and report the rendered revision exactly once so the pane leaves
 * its loading state.
 */
import { useEffect, useRef } from 'react'
import type { DocumentContent, FileMeta } from './types.ts'

/** What a body reads from its own file. */
export interface DocumentState {
  readonly meta: FileMeta | undefined
  readonly absolutePath: string | undefined
  readonly version: string | undefined
}

/**
 * Subscribe a body to its file metadata and report readiness.
 *
 * For `renderer` content the owner waits until `loaded(version)` is called;
 * repeating that per format invited four slightly different copies of the same
 * bookkeeping, so it lives here instead.
 * @param content - what the owner handed this body.
 * @param resourceAddress - address of the previewed file.
 * @param useResource - the owner's metadata hook, when available.
 * @returns the file metadata plus the two fields bodies usually need.
 */
export function useDocument(
  content: DocumentContent,
  resourceAddress: string,
  useResource?: (address: string) => { readonly value?: FileMeta },
): DocumentState {
  const meta = useResource?.(resourceAddress)?.value
  const version = meta?.version
  const reported = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (content.kind !== 'renderer' || version === undefined) return
    if (reported.current === version) return
    reported.current = version
    content.loaded(version)
  }, [content, version])

  return { meta, absolutePath: meta?.absolutePath, version }
}
