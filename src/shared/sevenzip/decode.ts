/**
 * Decoding for 7z: turn one folder into bytes using lib/lzma.wasm.
 *
 * The module is injected rather than imported, so this file stays usable from the
 * host, the tests and the browser. Only single-coder chains of LZMA, LZMA2 or Copy
 * are supported today; anything else (AES, BCJ, BCJ2) is reported as unsupported.
 */
import type { SevenZipCoder, SevenZipFolder, SevenZipPackStream } from './structure.ts'

/** The subset of lib/lzma.wasm this module calls. */
export interface Decoder {
  readonly memory: WebAssembly.Memory
  malloc(size: number): number
  free(pointer: number): void
  reset_heap(): void
  lzma_decode(
    props: number, propsLength: number,
    input: number, inputLength: number,
    output: number, outputCapacity: number,
  ): number
  lzma2_decode(
    props: number, propsLength: number,
    input: number, inputLength: number,
    output: number, outputCapacity: number,
  ): number
}

/** Error codes lzma_decode returns. */
const ERRORS: Readonly<Record<number, string>> = {
  '-1': '7z: allocator or properties rejected the block',
  '-2': '7z: compressed data is corrupt',
  '-3': '7z: output buffer was too small',
}

/** True when this decoder can run the folder's coder chain. */
export function canDecode(folder: SevenZipFolder): boolean {
  if (folder.coders.length !== 1) return false
  const coder = folder.coders[0]
  if (coder === undefined) return false
  return coder.id === '030101' || coder.id === '21' || coder.id === '00'
}

/** Copy bytes into the wasm heap. */
function write(decoder: Decoder, bytes: Uint8Array): number {
  const pointer = decoder.malloc(bytes.length)
  if (pointer === 0) throw new Error('7z: input buffer allocation failed')
  new Uint8Array(decoder.memory.buffer).set(bytes, pointer)
  return pointer
}

/** Decode one packed stream with a single coder. */
function runCoder(decoder: Decoder, coder: SevenZipCoder, input: Uint8Array, capacity: number): Uint8Array {
  if (coder.id === '00') return input.slice(0, capacity)

  const properties = coder.properties
  const propsPointer = write(decoder, properties)
  const inputPointer = write(decoder, input)
  const outputPointer = decoder.malloc(capacity)
  if (outputPointer === 0) throw new Error('7z: output buffer allocation failed')

  const written = coder.id === '030101'
    ? decoder.lzma_decode(propsPointer, properties.length, inputPointer, input.length, outputPointer, capacity)
    : decoder.lzma2_decode(propsPointer, properties.length, inputPointer, input.length, outputPointer, capacity)

  if (written < 0) throw new Error(ERRORS[written] ?? `7z: decode failed (${String(written)})`)
  return new Uint8Array(decoder.memory.buffer).slice(outputPointer, outputPointer + written)
}

/**
 * Decode one folder.
 * @param decoder - loaded lib/lzma.wasm
 * @param folder - the folder definition from the header
 * @param packed - the packed bytes the folder's streams occupy, in order
 */
export function decodeFolder(decoder: Decoder, folder: SevenZipFolder, packed: Uint8Array): Uint8Array {
  if (!canDecode(folder)) throw new Error('7z: unsupported coder chain (solid with filters, or AES)')
  const coder = folder.coders[0]
  if (coder === undefined) throw new Error('7z: folder has no coder')

  decoder.reset_heap()
  try {
    return runCoder(decoder, coder, packed, Math.max(1, folder.size))
  } finally {
    decoder.reset_heap()
  }
}

/** Read the packed bytes a folder needs, given the file's pack streams. */
export function folderPackedBytes(
  folder: SevenZipFolder,
  packStreams: readonly SevenZipPackStream[],
  read: (offset: number, length: number) => Uint8Array,
): Uint8Array {
  const stream = packStreams[0]
  if (stream === undefined) throw new Error('7z: folder has no packed stream')
  const bytes = read(stream.offset, stream.size)
  if (bytes.length !== stream.size) throw new Error('7z: packed stream is shorter than declared')
  return bytes
}
