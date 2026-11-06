/**
 * Lazy chunk loading over the loopback asset route.
 *
 * three.js and the model decoders dominate the client bundle, but a reader who
 * never opens a model should not pay for them at startup. Each chunk is a
 * separate ESM file imported at runtime from the asset route; the first caller
 * starts the download and everyone afterwards shares the same promise, so a
 * warm-up import and a preview opening a model never race into two loads.
 *
 * A failure clears its entry so the next attempt can retry.
 */
import { assetUrl } from './assets.ts'
import type { AssetName } from './assets.ts'

/** Dynamic import through a runtime URL, so no bundler rewrites the specifier. */
const importModule = new Function('u', 'return import(u)') as <T>(url: string) => Promise<T>

/** One pending download per asset name. */
const pending = new Map<string, Promise<unknown>>()

/**
 * Resolve one chunk's URL.
 * @param name - whitelisted chunk asset.
 * @returns the URL the page can import.
 */
export function chunkUrl(name: AssetName): Promise<string> {
  return assetUrl(name)
}

/**
 * Load one chunk, sharing the download across callers.
 * @param name - whitelisted chunk asset.
 * @returns the module's exports.
 */
export function loadChunk<T>(name: AssetName): Promise<T> {
  let held = pending.get(name)
  if (held === undefined) {
    held = assetUrl(name)
      .then((url) => importModule<T>(url))
      .catch((error: unknown) => {
        pending.delete(name)
        throw error instanceof Error ? error : new Error(String(error))
      })
    pending.set(name, held)
  }
  return held as Promise<T>
}

/** Forget every cached download; used by tests. */
export function resetChunks(): void {
  pending.clear()
}
