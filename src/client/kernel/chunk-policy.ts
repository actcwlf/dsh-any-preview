/**
 * Load policy for lazily loaded chunks.
 *
 * Chunk boundaries are a build-time decision; what this layer decides is *when*
 * a chunk is fetched and compiled. Keeping the decision in one place means a
 * future configuration surface only has to call `setChunkStrategy` instead of
 * threading flags through every preview.
 *
 * `warm`  - fetch during idle after activation, so opening the file is instant
 * `click` - fetch only when a file of that kind is opened
 * `never` - do not fetch at all; the preview reports that it is disabled
 */

/** Chunks that can be loaded on demand. */
export type ChunkId = 'three' | 'mux'

/** When a chunk is fetched. */
export type ChunkStrategy = 'warm' | 'click' | 'never'

/** Defaults reproduce the behaviour before this layer existed. */
const DEFAULTS: Readonly<Record<ChunkId, ChunkStrategy>> = {
  three: 'warm',
  mux: 'click',
}

const overrides = new Map<ChunkId, ChunkStrategy>()

/**
 * Strategy for one chunk.
 * @param id - chunk identifier.
 * @returns the configured strategy, or the default.
 */
export function chunkStrategy(id: ChunkId): ChunkStrategy {
  return overrides.get(id) ?? DEFAULTS[id]
}

/**
 * Whether a chunk may be loaded at all.
 * @param id - chunk identifier.
 * @returns false only for `never`.
 */
export function isChunkEnabled(id: ChunkId): boolean {
  return chunkStrategy(id) !== 'never'
}

/**
 * Change the strategy for one chunk. Intended entry point for a future
 * configuration surface; nothing calls it yet.
 * @param id - chunk identifier.
 * @param strategy - when to fetch the chunk.
 */
export function setChunkStrategy(id: ChunkId, strategy: ChunkStrategy): void {
  if (!(id in DEFAULTS)) throw new Error(`unknown chunk: ${id}`)
  overrides.set(id, strategy)
}

/**
 * Chunks that should be warmed after activation.
 * @returns chunk ids whose strategy is `warm`.
 */
export function warmableChunks(): ChunkId[] {
  return (Object.keys(DEFAULTS) as ChunkId[]).filter((id) => chunkStrategy(id) === 'warm')
}

/** Restore every strategy to its default; used by tests. */
export function resetChunkStrategies(): void {
  overrides.clear()
}
