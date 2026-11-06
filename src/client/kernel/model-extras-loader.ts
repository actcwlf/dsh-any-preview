/**
 * Lazy loader for the model decoder chunk.
 *
 * Draco, KTX2 and OBJ material support live in their own chunk: only a model
 * that actually declares one of those extensions pays for the loader code.
 * The decoder binaries they need (Draco/Basis wasm) are fetched separately by
 * the loaders themselves, from the same loopback asset base.
 */
import type { ModelExtrasBundle } from '../../chunk/model-extras.ts'
import { chunkUrl as assetChunkUrl, loadChunk } from './chunk-loader.ts'

/**
 * URL of the decoder chunk.
 * @returns the URL the page imports.
 */
export function extrasChunkUrl(): Promise<string> {
  return assetChunkUrl('model-extras-chunk.js')
}

/**
 * Load the decoder chunk.
 * @returns the loaders and decoder modules.
 */
export function loadModelExtras(): Promise<ModelExtrasBundle> {
  return loadChunk<ModelExtrasBundle>('model-extras-chunk.js')
}
