/**
 * Client half: teach the Sidebar's document pane to render CSV/TSV as a table.
 *
 * Two registrations make one renderer: the metadata row in `documentPreviews`
 * (which file extensions it claims, and how content is delivered), and the
 * keyed component in the `sidebar.right.tab.document` seat. `priority:
 * 'extension'` outranks the builtin plain-text fallback for these suffixes
 * while leaving every other format untouched.
 */
import { CsvBody } from './CsvBody.tsx'

/** Implementation identity, shared by the metadata row and the slot key. */
const ID = 'dsh-any-preview'

interface DocumentPreviewDefinition {
  readonly id: string
  readonly extensions: readonly string[]
  readonly priority?: 'builtin' | 'extension'
  readonly title: () => string
  readonly loading: 'text-pages' | 'bytes-complete'
  readonly wrap?: boolean
}

/** The slice of the client Cordis context this plugin touches. */
interface ClientContext {
  effect(run: () => () => void, label?: string): unknown
  readonly documentPreviews: { register(definition: DocumentPreviewDefinition): () => void }
  readonly slots: {
    inject(key: string, run: () => () => void): () => void
    register(entry: { readonly name: string, readonly key: string }, component: unknown): () => void
  }
}

// Wait for the document owner's registry and the slot system before applying.
export const inject = ['slots', 'documentPreviews']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.documentPreviews.register({
    id: ID,
    extensions: ['csv', 'tsv'],
    priority: 'extension',
    title: () => 'CSV 表格',
    loading: 'text-pages',
    wrap: false,
  }), 'any-preview: csv metadata')

  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: ID },
    CsvBody,
  )), 'any-preview: csv body')
}
