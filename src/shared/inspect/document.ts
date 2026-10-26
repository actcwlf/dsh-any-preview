/**
 * Document model shared by every markup reader.
 *
 * These are **content** shapes, not presentation: a reader turns source text into
 * this list, renderers in the client turn it into elements, and tools can read it
 * without pulling in React. Keep it free of rendering concerns — anything that
 * only matters for pixels belongs in the client renderer.
 */

/** One block of a parsed document. */
export type Block =
  | { readonly kind: 'heading', readonly level: number, readonly text: string }
  | { readonly kind: 'paragraph', readonly text: string }
  | { readonly kind: 'code', readonly text: string, readonly language?: string }
  | { readonly kind: 'list', readonly ordered: boolean, readonly items: readonly string[] }
  | { readonly kind: 'quote', readonly text: string }
  | { readonly kind: 'table', readonly header: readonly string[], readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'image', readonly src: string, readonly alt: string }

/**
 * Outline of a document, for callers that want structure rather than content.
 * @param blocks - parsed blocks.
 * @returns headings plus per-kind counts.
 */
export function outlineOf(blocks: readonly Block[]): {
  headings: { level: number, text: string }[]
  counts: Record<string, number>
} {
  const headings: { level: number, text: string }[] = []
  const counts: Record<string, number> = {}
  for (const block of blocks) {
    counts[block.kind] = (counts[block.kind] ?? 0) + 1
    if (block.kind === 'heading') headings.push({ level: block.level, text: block.text })
  }
  return { headings, counts }
}
