/**
 * Streaming decode for one folder: feed packed bytes in, emit only the requested
 * range of the unpacked output.
 *
 * A solid folder is decoded front to back; the caller says which slice it wants, so a
 * member can be extracted without ever holding the whole folder. Only single-coder
 * folders (LZMA, LZMA2 or Copy) stream here — BCJ/BCJ2 need the whole buffer and stay
 * on the one-shot path.
 */
import type { SevenZipFolder } from './structure.ts'
import type { Decoder } from './decode.ts'

/** The session API the streaming path needs on top of the one-shot decoder. */
export interface SessionDecoder extends Decoder {
  dec_open(props: number, propsLength: number, kind: number): number
  dec_push(
    handle: number,
    input: number, inputLength: number,
    output: number, outputCapacity: number,
    consumed: number,
  ): number
  dec_finish(handle: number, output: number, outputCapacity: number): number
  dec_close(handle: number): void
}

/** Output bytes requested from a folder. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

/** Everything one streaming extraction needs. */
export interface StreamOptions {
  readonly decoder: SessionDecoder
  readonly folder: SevenZipFolder
  /** Read packed bytes: (pack index, offset within the pack, length). */
  readonly readPacked: (index: number, offset: number, length: number) => Promise<Uint8Array>
  readonly range: ByteRange
  /** Receives the intersecting part of each decoded chunk. */
  readonly sink: (chunk: Uint8Array, offset: number) => void | Promise<void>
  /** Bytes pulled per round trip; 1 MB by default. */
  readonly chunkSize?: number
}

/** True when this folder can be decoded without holding all of it. */
export function canStream(folder: SevenZipFolder): boolean {
  if (folder.coders.length !== 1) return false
  const coder = folder.coders[0]
  if (coder === undefined) return false
  return coder.id === '030101' || coder.id === '21' || coder.id === '00'
}

/**
 * Decode one folder and hand the requested slice to `sink`.
 * @param options - folder, packed reader, range and sink.
 */
export async function streamFolderRange(options: StreamOptions): Promise<void> {
  const { decoder, folder, readPacked, range, sink, chunkSize = 1024 * 1024 } = options
  const coder = folder.coders[0]
  if (coder === undefined) throw new Error('7z: folder has no coder')
  if (!canStream(folder)) throw new Error('7z: this folder cannot be streamed (filters or coder chain)')

  const pack = folder.packs[0]
  if (pack === undefined) throw new Error('7z: folder has no packed stream')

  // Copy needs no decoder state: slice the packed bytes directly.
  if (coder.id === '00') {
    let position = 0
    while (position < range.end) {
      const length = Math.min(chunkSize, range.end - position)
      const bytes = await readPacked(pack, position, length)
      if (bytes.length === 0) break
      const from = Math.max(range.start, position)
      const to = Math.min(range.end, position + bytes.length)
      if (to > from) await sink(bytes.subarray(from - position, to - position), from)
      position += bytes.length
    }
    return
  }

  const kind = coder.id === '21' ? 1 : 0
  const properties = coder.properties
  const propsPointer = decoder.malloc(properties.length)
  if (propsPointer === 0) throw new Error('7z: properties allocation failed')
  new Uint8Array(decoder.memory.buffer).set(properties, propsPointer)

  const handle = decoder.dec_open(propsPointer, properties.length, kind)
  if (handle < 0) throw new Error('7z: no decoder session available')

  const chunk = Math.max(64 * 1024, chunkSize)
  const inputPointer = decoder.malloc(chunk)
  const outputPointer = decoder.malloc(chunk)
  const consumedPointer = decoder.malloc(4)
  if (inputPointer === 0 || outputPointer === 0 || consumedPointer === 0) {
    decoder.dec_close(handle)
    throw new Error('7z: streaming buffers could not be allocated')
  }

  let position = 0
  let consumedTotal = 0
  try {
    while (true) {
      const input = await readPacked(pack, position, chunk)
      if (input.length === 0) break
      position += input.length
      new Uint8Array(decoder.memory.buffer).set(input, inputPointer)

      let used = 0
      while (used < input.length) {
        const written = decoder.dec_push(handle, inputPointer + used, input.length - used, outputPointer, chunk, consumedPointer)
        if (written < 0) throw new Error('7z: streaming decode failed')
        used += new Uint32Array(decoder.memory.buffer, consumedPointer, 1)[0] ?? 0
        if (written > 0) {
          const base = consumedTotal
          const from = Math.max(range.start, base)
          const to = Math.min(range.end, base + written)
          if (to > from) {
            const slice = new Uint8Array(decoder.memory.buffer).slice(outputPointer + (from - base), outputPointer + (to - base))
            await sink(slice, from)
          }
          consumedTotal += written
          if (consumedTotal >= range.end) return
        }
      }
    }

    // Drain whatever the decoder still holds.
    const tail = decoder.dec_finish(handle, outputPointer, chunk)
    if (tail < 0) throw new Error('7z: streaming decode failed at the end')
    if (tail > 0) {
      const from = Math.max(range.start, consumedTotal)
      const to = Math.min(range.end, consumedTotal + tail)
      if (to > from) {
        await sink(new Uint8Array(decoder.memory.buffer).slice(outputPointer + (from - consumedTotal), outputPointer + (to - consumedTotal)), from)
      }
    }
  } finally {
    decoder.dec_close(handle)
    decoder.reset_heap()
  }
}
