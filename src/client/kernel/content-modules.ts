/**
 * Previews that can render a document from content alone, without a file address.
 *
 * Archive members arrive as bytes with no path, so a member is rendered by picking
 * the module for its extension and handing it text or bytes directly.
 */
import type { PreviewModule } from '../kernel/types.ts'
import { csvPreview } from '../previews/csv/index.tsx'
import { diffPreview } from '../previews/diff/index.tsx'
import { emlPreview } from '../previews/eml/index.tsx'
import { fontPreview } from '../previews/font/index.tsx'
import { jsonlPreview } from '../previews/jsonl/index.tsx'
import { logPreview } from '../previews/log/index.tsx'

/** Formats this package renders from content alone. */
export const CONTENT_MODULES: readonly PreviewModule[] = [
  csvPreview, diffPreview, emlPreview, fontPreview, jsonlPreview, logPreview,
]

/** Pick the module for one member name. */
export function contentModuleFor(name: string): PreviewModule | undefined {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  const extension = name.slice(dot + 1).toLowerCase()
  return CONTENT_MODULES.find(module => module.extensions.includes(extension))
}
