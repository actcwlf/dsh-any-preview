/**
 * Lazy loader for the 3D chunk.
 *
 * three.js and its addons dominate the client bundle, but a reader who never
 * opens a model should not pay for them at startup. The chunk is therefore a
 * separate ESM file served from a loopback asset route and imported at runtime.
 *
 * The first caller starts the download; everyone afterwards shares the same
 * promise, so a warm-up import and a preview opening a model never race into two
 * loads. A failure clears the promise so the next attempt can retry.
 */
import type { ThreeBundle } from '../../chunk/three.ts'
import { assetUrl } from './assets.ts'

let pending: Promise<ThreeBundle> | undefined

/** Dynamic import through a runtime URL, so no bundler rewrites the specifier. */
const importModule = new Function('u', 'return import(u)') as (url: string) => Promise<ThreeBundle>

export async function chunkUrl(): Promise<string> {
  return assetUrl('three-chunk.js')
}

/**
 * Load the 3D chunk, sharing one download across callers.
 * @returns the module with three.js and the loaders.
 */
export function loadThree(): Promise<ThreeBundle> {
  pending ??= chunkUrl()
    .then((url) => importModule(url))
    .catch((error: unknown) => {
      pending = undefined
      throw error instanceof Error ? error : new Error(String(error))
    })
  return pending
}
