/**
 * Lazy loader for the MPEG-TS chunk.
 *
 * Same shape as the three.js loader: one shared promise, a runtime URL from the
 * asset route, and a failure that clears the cache so the next open can retry.
 */
import type { MuxBundle } from '../../chunk/mux.ts'
import { assetUrl } from './assets.ts'

let pending: Promise<MuxBundle> | undefined

const importModule = new Function('u', 'return import(u)') as (url: string) => Promise<MuxBundle>

/**
 * Load the transport-stream chunk.
 * @returns the module with the mux.js transmuxer.
 */
export function loadMux(): Promise<MuxBundle> {
  pending ??= assetUrl('mux-chunk.js')
    .then((url) => importModule(url))
    .catch((error: unknown) => {
      pending = undefined
      throw error instanceof Error ? error : new Error(String(error))
    })
  return pending
}
