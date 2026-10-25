/**
 * GGUF header reader (llama.cpp model files).
 *
 * The header is self-describing: magic, version, counts, a typed key/value
 * block, then one descriptor per tensor. Only that prefix is read — the tensor
 * payload of a real model is tens of gigabytes.
 */
import { previewError } from '../../kernel/errors.ts'

/** One metadata entry, already formatted for display. */
export interface GgufKv {
  readonly key: string
  readonly value: string
}

/** One tensor descriptor. */
export interface GgufTensor {
  readonly name: string
  readonly type: string
  readonly dims: readonly number[]
  readonly params: number
}

/** What the viewer shows. */
export interface GgufHeader {
  readonly version: number
  readonly tensorCount: number
  readonly kvCount: number
  readonly kv: readonly GgufKv[]
  readonly tensors: readonly GgufTensor[]
  readonly quantizations: readonly (readonly [string, number])[]
}

/** Entry caps: a corrupt or hostile count must not turn into an allocation. */
const MAX_KV = 4_096
const MAX_TENSORS = 20_000
/** Longest string kept from the header. */
const MAX_STRING = 1 << 20
/** Array preview length. */
const MAX_ARRAY_PREVIEW = 8

/** GGML tensor type ids, the ones a reader will actually meet. */
const GGML_TYPES: Readonly<Record<number, string>> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1',
  8: 'Q8_0', 9: 'Q8_1', 10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K',
  14: 'Q6_K', 15: 'Q8_K', 16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS',
  19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S', 22: 'IQ2_S', 23: 'IQ4_XS',
  24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64', 29: 'IQ1_M',
  30: 'BF16', 31: 'Q4_0_4_4', 32: 'Q4_0_4_8', 33: 'Q4_0_8_8', 34: 'TQ1_0', 35: 'TQ2_0',
}

interface ReadState {
  offset: number
}

function need(bytes: Uint8Array, state: ReadState, count: number): void {
  if (state.offset + count > bytes.length) {
    throw previewError('gguf.truncated')
  }
}

function u8(bytes: Uint8Array, state: ReadState): number {
  need(bytes, state, 1)
  const value = bytes[state.offset]!
  state.offset += 1
  return value
}

function u16(bytes: Uint8Array, state: ReadState): number {
  need(bytes, state, 2)
  const value = bytes[state.offset]! | (bytes[state.offset + 1]! << 8)
  state.offset += 2
  return value
}

function u32(bytes: Uint8Array, state: ReadState): number {
  need(bytes, state, 4)
  const view = new DataView(bytes.buffer, bytes.byteOffset + state.offset, 4)
  const value = view.getUint32(0, true)
  state.offset += 4
  return value
}

function u64(bytes: Uint8Array, state: ReadState): number {
  need(bytes, state, 8)
  const view = new DataView(bytes.buffer, bytes.byteOffset + state.offset, 8)
  const low = view.getUint32(0, true)
  const high = view.getUint32(4, true)
  state.offset += 8
  if (high > 0x1f_ffff) throw previewError('gguf.integerRange')
  return high * 2 ** 32 + low
}

function text(bytes: Uint8Array, length: number): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, length))
}

function readString(bytes: Uint8Array, state: ReadState): string {
  const length = u64(bytes, state)
  if (length > MAX_STRING) throw previewError('gguf.stringTooLong')
  need(bytes, state, length)
  const value = text(bytes.subarray(state.offset, state.offset + length), length)
  state.offset += length
  return value
}

function readValue(bytes: Uint8Array, state: ReadState, type: number): string {
  switch (type) {
    case 0: return String(u8(bytes, state))
    case 1: {
      need(bytes, state, 1)
      const value = new DataView(bytes.buffer, bytes.byteOffset + state.offset, 1).getInt8(0)
      state.offset += 1
      return String(value)
    }
    case 2: return String(u16(bytes, state))
    case 3: {
      need(bytes, state, 2)
      const value = new DataView(bytes.buffer, bytes.byteOffset + state.offset, 2).getInt16(0, true)
      state.offset += 2
      return String(value)
    }
    case 4: return String(u32(bytes, state))
    case 5: {
      need(bytes, state, 4)
      const value = new DataView(bytes.buffer, bytes.byteOffset + state.offset, 4).getInt32(0, true)
      state.offset += 4
      return String(value)
    }
    case 6: {
      need(bytes, state, 4)
      const value = new DataView(bytes.buffer, bytes.byteOffset + state.offset, 4).getFloat32(0, true)
      state.offset += 4
      return String(value)
    }
    case 7: return u8(bytes, state) === 0 ? 'false' : 'true'
    case 8: {
      const value = readString(bytes, state)
      return value.length > 200 ? `${value.slice(0, 200)}…` : value
    }
    case 9: {
      const elementType = u32(bytes, state)
      const count = u64(bytes, state)
      const preview: string[] = []
      for (let index = 0; index < count; index += 1) {
        if (index < MAX_ARRAY_PREVIEW) preview.push(readValue(bytes, state, elementType))
        else skipValue(bytes, state, elementType)
      }
      const suffix = count > MAX_ARRAY_PREVIEW ? ` …（共 ${String(count)} 项）` : ''
      return `[${String(count)} 项] ${preview.join(', ')}${suffix}`
    }
    case 10: return String(u64(bytes, state))
    case 11: {
      need(bytes, state, 8)
      const view = new DataView(bytes.buffer, bytes.byteOffset + state.offset, 8)
      const value = view.getBigInt64(0, true)
      state.offset += 8
      return value.toString()
    }
    case 12: {
      need(bytes, state, 8)
      const view = new DataView(bytes.buffer, bytes.byteOffset + state.offset, 8)
      const value = view.getFloat64(0, true)
      state.offset += 8
      return String(value)
    }
    default: throw previewError('gguf.unknownType', { type: String(type) })
  }
}

function skipValue(bytes: Uint8Array, state: ReadState, type: number): void {
  switch (type) {
    case 0: case 1: case 7: u8(bytes, state); return
    case 2: case 3: u16(bytes, state); return
    case 4: case 5: case 6: u32(bytes, state); return
    case 8: {
      const length = u64(bytes, state)
      need(bytes, state, length)
      state.offset += length
      return
    }
    case 9: {
      const elementType = u32(bytes, state)
      const count = u64(bytes, state)
      for (let index = 0; index < count; index += 1) skipValue(bytes, state, elementType)
      return
    }
    case 10: case 11: case 12: u64(bytes, state); return
    default: throw previewError('gguf.unknownType', { type: String(type) })
  }
}

function typeName(id: number): string {
  return GGML_TYPES[id] ?? `type(${String(id)})`
}

/**
 * Whether the first bytes look like a GGUF file.
 * @param bytes - the file's head.
 */
export function looksLikeGguf(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && text(bytes, 4) === 'GGUF'
}

/**
 * Parse a GGUF header.
 * @param bytes - the head of the file (at least the metadata block).
 * @returns version, metadata and tensor descriptors.
 * @throws when the magic, the version or the byte stream is not valid GGUF.
 */
export function parseGguf(bytes: Uint8Array): GgufHeader {
  if (!looksLikeGguf(bytes)) throw previewError('gguf.notGguf')
  const state: ReadState = { offset: 4 }
  const version = u32(bytes, state)
  if (version < 2 || version > 3) throw previewError('gguf.unsupportedVersion', { version: String(version) })
  const tensorCount = u64(bytes, state)
  const kvCount = u64(bytes, state)

  const kv: GgufKv[] = []
  const metadataLimit = Math.min(kvCount, MAX_KV)
  for (let index = 0; index < kvCount; index += 1) {
    const key = readString(bytes, state)
    const valueType = u32(bytes, state)
    const value = readValue(bytes, state, valueType)
    if (index < metadataLimit) kv.push({ key, value })
  }

  const tensors: GgufTensor[] = []
  const counts = new Map<string, number>()
  const tensorLimit = Math.min(tensorCount, MAX_TENSORS)
  for (let index = 0; index < tensorCount; index += 1) {
    const name = readString(bytes, state)
    const dimensions = u32(bytes, state)
    const dims: number[] = []
    for (let dimension = 0; dimension < dimensions; dimension += 1) dims.push(u64(bytes, state))
    const type = typeName(u32(bytes, state))
    u64(bytes, state) // byte offset into the data section; not needed for the summary
    if (index < tensorLimit) {
      const params = dims.reduce((total, value) => total * value, 1)
      tensors.push({ name, type, dims, params })
      counts.set(type, (counts.get(type) ?? 0) + 1)
    }
  }

  return {
    version,
    tensorCount,
    kvCount,
    kv,
    tensors,
    quantizations: [...counts.entries()].sort((left, right) => right[1] - left[1]),
  }
}
