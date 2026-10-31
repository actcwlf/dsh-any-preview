/**
 * Decoding for 7z: turn one folder into bytes using lib/lzma.wasm.
 *
 * The decoder is injected rather than imported, so this file stays usable from the
 * host, the tests and the browser. A folder is a chain of coders: one data coder
 * (LZMA, LZMA2 or Copy) optionally followed by the x86 BCJ or Delta filter. AES and
 * BCJ2 are refused rather than mis-decoded.
 */
import type { SevenZipCoder, SevenZipFolder, SevenZipPackStream } from './structure.ts'

/** Codec ids that produce the data stream. */
const DATA_CODERS = new Set(['030101', '21', '00'])

/** Filter ids applied after the data coder. */
const FILTER_CODERS = new Set(['03030103', '03'])

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
  bcj_x86(data: number, size: number, pc: number): number
  delta_decode(data: number, size: number, distance: number): number
}

/** Error codes the decode exports return. */
const ERRORS: Readonly<Record<number, string>> = {
  '-1': '7z: allocator or properties rejected the block',
  '-2': '7z: compressed data is corrupt',
  '-3': '7z: output buffer was too small',
}

/** Split a folder's coders into the data coder and its filters. */
function chainOf(folder: SevenZipFolder): { data: SevenZipCoder, filters: SevenZipCoder[] } | undefined {
  const data = folder.coders.find(coder => DATA_CODERS.has(coder.id))
  const filters = folder.coders.filter(coder => FILTER_CODERS.has(coder.id))
  if (data === undefined) return undefined
  if (data.inStreams !== 1 || data.outStreams !== 1) return undefined
  if (filters.length + (folder.coders.length - filters.length) !== folder.coders.length) return undefined
  if (folder.coders.length !== filters.length + 1) return undefined
  return { data, filters }
}

/** True when this decoder can run the folder's coder chain. */
export function canDecode(folder: SevenZipFolder): boolean {
  return chainOf(folder) !== undefined
}

/** Copy bytes into the wasm heap. */
function write(decoder: Decoder, bytes: Uint8Array): number {
  const pointer = decoder.malloc(bytes.length)
  if (pointer === 0) throw new Error('7z: input buffer allocation failed')
  new Uint8Array(decoder.memory.buffer).set(bytes, pointer)
  return pointer
}

/** Run the data coder, leaving the result in the heap. */
function runDataCoder(decoder: Decoder, coder: SevenZipCoder, input: Uint8Array, capacity: number): { pointer: number, length: number } {
  if (coder.id === '00') {
    const pointer = write(decoder, input.subarray(0, capacity))
    return { pointer, length: Math.min(input.length, capacity) }
  }

  const properties = coder.properties
  const propsPointer = write(decoder, properties)
  const inputPointer = write(decoder, input)
  const outputPointer = decoder.malloc(capacity)
  if (outputPointer === 0) throw new Error('7z: output buffer allocation failed')

  const written = coder.id === '030101'
    ? decoder.lzma_decode(propsPointer, properties.length, inputPointer, input.length, outputPointer, capacity)
    : decoder.lzma2_decode(propsPointer, properties.length, inputPointer, input.length, outputPointer, capacity)

  if (written < 0) throw new Error(ERRORS[written] ?? `7z: decode failed (${String(written)})`)
  return { pointer: outputPointer, length: written }
}

/** Apply the folder's filters in place on the decoded buffer. */
function runFilters(decoder: Decoder, filters: readonly SevenZipCoder[], pointer: number, length: number): void {
  for (const filter of filters) {
    if (filter.id === '03030103') {
      decoder.bcj_x86(pointer, length, 0)
      continue
    }
    if (filter.id === '03') {
      // Delta properties hold the distance minus one.
      const distance = (filter.properties[0] ?? 0) + 1
      decoder.delta_decode(pointer, length, distance)
      continue
    }
    throw new Error(`7z: unsupported filter ${filter.name}`)
  }
}

/**
 * Decode one folder.
 * @param decoder - loaded lib/lzma.wasm
 * @param folder - the folder definition from the header
 * @param packed - the packed bytes the folder's streams occupy
 */
export function decodeFolder(decoder: Decoder, folder: SevenZipFolder, packed: Uint8Array): Uint8Array {
  const chain = chainOf(folder)
  if (chain === undefined) throw new Error('7z: unsupported coder chain (AES / BCJ2 / multi-stream)')

  decoder.reset_heap()
  try {
    const { pointer, length } = runDataCoder(decoder, chain.data, packed, Math.max(1, folder.size))
    runFilters(decoder, chain.filters, pointer, length)
    return new Uint8Array(decoder.memory.buffer).slice(pointer, pointer + length)
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
  void folder
  const stream = packStreams[0]
  if (stream === undefined) throw new Error('7z: folder has no packed stream')
  const bytes = read(stream.offset, stream.size)
  if (bytes.length !== stream.size) throw new Error('7z: packed stream is shorter than declared')
  return bytes
}
