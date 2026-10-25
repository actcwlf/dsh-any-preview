/**
 * The single registration list. Adding a format means adding one import and
 * one array entry — the client entry and the kernel stay untouched.
 */
import type { PreviewModule } from '../kernel/types.ts'
import { csvPreview } from './csv/index.tsx'

/** Every preview this package ships, in registration order. */
export const PREVIEWS: readonly PreviewModule[] = [csvPreview]
