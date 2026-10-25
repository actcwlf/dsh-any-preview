/**
 * SafeTensors header reader: an 8-byte little-endian header length followed by
 * a JSON object mapping tensor names to dtype, shape and byte offsets.
 *
 * Only the header is ever read; tensor data is not touched.
 */
import { LIMITS } from '../../../shared/limits.ts'

/** One tensor entry from the header. */
export interface SafeTensor {
  readonly name: string
  readonly dtype: string
  readonly shape: readonly number[]
  readonly params: number
}

/** What the viewer shows. */
export interface SafeTensorsHeader {
  readonly headerBytes: number
  readonly tensors: readonly SafeTensor[]
  readonly metadata: readonly (readonly [string, string])[]
  readonly totalParams: number
  readonly dtypes: readonly (readonly [string, number])[]
}

/** Header metadata beyond this is refused rather than buffered. */
export const MAX_HEADER_BYTES = LIMITS.safetensorsHeader

/** Tolerated tensor entries; a bigger file still lists this many. */
export const MAX_TENSORS = 50_000

/**
 * Read the little-endian u64 header length.
 * @param bytes - at least eight bytes from the start of the file.
 * @returns the declared header size, or undefined when the buffer is short.
 */
export function readHeaderLength(bytes: Uint8Array): number | undefined {
  if (bytes.length < 8) return undefined
  let value = 0
  for (let index = 7; index >= 0; index -= 1) {
    value = value * 256 + bytes[index]!
    if (value > Number.MAX_SAFE_INTEGER) return undefined
  }
  return value
}

function paramCount(shape: readonly number[]): number {
  return shape.reduce((total, dimension) => total * (Number.isFinite(dimension) ? dimension : 1), 1)
}

/**
 * Parse the JSON header body.
 * @param text - the UTF-8 header.
 * @param headerBytes - declared length, for display.
 * @returns tensor list, metadata and aggregates.
 * @throws when the JSON is not a SafeTensors header object.
 */
export function parseHeaderJson(text: string, headerBytes: number): SafeTensorsHeader {
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('头部不是 JSON 对象')
  const record = parsed as Record<string, unknown>

  const tensors: SafeTensor[] = []
  const counts = new Map<string, number>()
  let totalParams = 0
  for (const [name, value] of Object.entries(record)) {
    if (name === '__metadata__') continue
    if (tensors.length >= MAX_TENSORS) break
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const dtype = typeof entry.dtype === 'string' ? entry.dtype : '?'
    const shape = Array.isArray(entry.shape)
      ? entry.shape.filter((dimension): dimension is number => typeof dimension === 'number')
      : []
    const params = paramCount(shape)
    tensors.push({ name, dtype, shape, params })
    totalParams += params
    counts.set(dtype, (counts.get(dtype) ?? 0) + 1)
  }

  const meta: [string, string][] = []
  const rawMeta = record.__metadata__
  if (typeof rawMeta === 'object' && rawMeta !== null) {
    for (const [key, value] of Object.entries(rawMeta as Record<string, unknown>)) {
      meta.push([key, typeof value === 'string' ? value : JSON.stringify(value)])
    }
  }

  return {
    headerBytes,
    tensors,
    metadata: meta,
    totalParams,
    dtypes: [...counts.entries()].sort((left, right) => right[1] - left[1]),
  }
}
