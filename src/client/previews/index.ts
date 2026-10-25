/**
 * The single registration list. Adding a format means adding one import and
 * one array entry — the client entry and the kernel stay untouched.
 */
import type { PreviewModule } from '../kernel/types.ts'
import { archivePreview } from './archive/index.tsx'
import { csvPreview } from './csv/index.tsx'
import { diffPreview } from './diff/index.tsx'
import { emlPreview } from './eml/index.tsx'
import { fontPreview } from './font/index.tsx'
import { jsonlPreview } from './jsonl/index.tsx'
import { logPreview } from './log/index.tsx'
import { audioPreview, videoPreview } from './media/index.tsx'
import { glbPreview, gltfPreview, objPreview, stlPreview } from './model/index.tsx'

/** Every preview this package ships, in registration order. */
export const PREVIEWS: readonly PreviewModule[] = [
  archivePreview,
  csvPreview,
  diffPreview,
  emlPreview,
  fontPreview,
  logPreview,
  jsonlPreview,
  videoPreview,
  audioPreview,
  glbPreview,
  gltfPreview,
  objPreview,
  stlPreview,
]
