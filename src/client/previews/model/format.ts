/**
 * Format adapter registry for the model preview.
 *
 * Decoding is deliberately open at the edges: GLB/glTF, OBJ and STL are the
 * current adapters, but a future PMX/PMD reader can register here without
 * growing another `if` chain in `parseModel`. The registry only holds metadata
 * and parser callbacks; it never touches the DOM or three.js itself.
 */
import type { ModelNeeds } from './resources.ts'
import { NO_NEEDS } from './resources.ts'

/** One file format the preview can decode. */
export interface ModelFormatAdapter {
  /** Lowercase suffixes without a leading dot. */
  readonly extensions: readonly string[]
  /** What optional decoders/textures this file needs, when it differs from NO_NEEDS. */
  readonly needs?: (extension: string, bytes: ArrayBuffer, text?: string) => ModelNeeds
  /** Decode the bytes; the context is passed through from `parseModel`. */
  readonly parse: (context: ModelFormatParseContext) => Promise<any>
}

/** Arguments one adapter receives from the orchestrator. */
export interface ModelFormatParseContext {
  readonly bundle: any
  readonly extension: string
  readonly bytes: ArrayBuffer
  readonly options: any
}

const adapters = new Map<string, ModelFormatAdapter>()

/**
 * Register one adapter for all of its suffixes.
 * @param adapter - metadata and parser callback.
 */
export function registerModelFormat(adapter: ModelFormatAdapter): void {
  for (const extension of adapter.extensions) {
    adapters.set(extension.toLowerCase(), adapter)
  }
}

/**
 * Find the adapter that owns a suffix.
 * @param extension - lowercase or mixed-case suffix without a dot.
 * @returns the adapter, or undefined for an unsupported format.
 */
export function modelFormatFor(extension: string): ModelFormatAdapter | undefined {
  return adapters.get(extension.toLowerCase())
}

/**
 * Capabilities an adapter declares for one set of bytes.
 * @param extension - suffix without a dot.
 * @param bytes - the whole file.
 * @param text - already-decoded text, when available.
 * @returns the adapter's needs, or the no-op set.
 */
export function modelNeedsFor(
  extension: string,
  bytes: ArrayBuffer,
  text?: string,
): ModelNeeds {
  const adapter = modelFormatFor(extension)
  if (adapter?.needs === undefined) return NO_NEEDS
  try {
    return adapter.needs(extension.toLowerCase(), bytes, text)
  } catch {
    // A malformed header should fail in the parser with the format's own
    // error, not while the caller is deciding which decoder chunk to load.
    return NO_NEEDS
  }
}

/** Suffixes currently registered, for diagnostics and tests. */
export function modelFormatExtensions(): readonly string[] {
  return [...adapters.keys()].sort()
}
