/**
 * Lazy loader for the 3D chunk.
 *
 * three.js and its addons dominate the client bundle, but a reader who never
 * opens a model should not pay for them at startup. The chunk is therefore a
 * separate ESM file served from a loopback asset route and imported at runtime.
 *
 * The shared-promise cache and its retry live in `chunk-loader.ts`, so the
 * decoders chunk loads through exactly the same path.
 */
import type { ThreeBundle } from '../../chunk/three.ts'
import { chunkUrl as assetChunkUrl, loadChunk } from './chunk-loader.ts'

/**
 * URL of the 3D chunk.
 * @returns the URL the page imports.
 */
export function chunkUrl(): Promise<string> {
  return assetChunkUrl('three-chunk.js')
}

/**
 * Load the 3D chunk.
 * @returns the module with three.js and the loaders.
 */
export function loadThree(): Promise<ThreeBundle> {
  return loadChunk<ThreeBundle>('three-chunk.js')
}
