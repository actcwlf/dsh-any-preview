/**
 * 7z archive structure: signature header, next header, files info.
 *
 * Pure: it reads a byte array and never touches the file system or the decoder. A
 * compressed next header (kEncodedHeader) is detected by {@link isEncodedHeader};
 * the caller decodes it with lib/lzma.wasm and hands the plain bytes to
 * {@link parseHeader}.
 *
 * Signature header layout (little endian):
 *   0x00  6B  '7z' BC AF 27 1C
 *   0x06  2B  version
 *   0x08  4B  start header CRC32
 *   0x0C  8B  next header offset (from 0x20)
 *   0x14  8B  next header size
 *   0x1C  4B  next header CRC32
 */
import { crc32 } from './crc32.ts'

/** Signature bytes every 7z archive starts with. */
export const SEVEN_ZIP_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const

/** Property ids used below. */
const ID = {
  end: 0x00,
  header: 0x01,
  archiveProperties: 0x02,
  additionalStreams: 0x03,
  mainStreams: 0x04,
  filesInfo: 0x05,
  packInfo: 0x06,
  unPackInfo: 0x07,
  subStreamsInfo: 0x08,
  size: 0x09,
  crc: 0x0a,
  folder: 0x0b,
  codersUnPackSize: 0x0c,
  numUnPackStream: 0x0d,
  emptyStream: 0x0e,
  emptyFile: 0x0f,
  name: 0x11,
  encodedHeader: 0x17,
} as const

/** Codec ids we can name; unknown ids stay in hex. */
const CODEC_NAMES: Readonly<Record<string, string>> = {
  '00': 'Copy',
  '21': 'LZMA2',
  '030101': 'LZMA',
  '03030103': 'BCJ',
  '0303011b': 'BCJ2',
  '06f10701': 'AES-256',
}

/** One coder inside a folder's chain. */
export interface SevenZipCoder {
  readonly id: string
  readonly name: string
  readonly inStreams: number
  readonly outStreams: number
  readonly properties: Uint8Array
}

/** One folder: the unit of decoding. */
export interface SevenZipFolder {
  readonly coders: readonly SevenZipCoder[]
  /** Unpacked size of the whole folder. */
  size: number
  /** Unpacked size of each stream in the folder, in order. */
  sizes: number[]
  crc?: number
  /** Number of files packed into this folder; >1 means solid. */
  streams: number
  /** Total coder output streams: kCodersUnPackSize stores one size per output. */
  outputs: number
  /** False when a coder we cannot run appears (AES, BCJ2, …). */
  readonly supported: boolean
}

/** One packed stream: a byte range in the file. */
export interface SevenZipPackStream {
  readonly offset: number
  readonly size: number
}

/** One file or directory inside the archive. */
export interface SevenZipEntry {
  readonly name: string
  readonly size: number
  readonly directory: boolean
  readonly encrypted: boolean
  /** Index into {@link SevenZipArchive.folders}; -1 when the entry has no data. */
  readonly folder: number
  /** Index of this entry's stream inside its folder; -1 when empty. */
  readonly stream: number
}

/** Everything a listing needs. */
export interface SevenZipArchive {
  readonly entries: readonly SevenZipEntry[]
  readonly folders: readonly SevenZipFolder[]
  readonly packStreams: readonly SevenZipPackStream[]
  readonly encrypted: boolean
  readonly solid: boolean
}

/** Where the next header lives, from the first 32 bytes. */
export interface SevenZipLayout {
  readonly nextHeaderOffset: number
  readonly nextHeaderSize: number
  readonly nextHeaderCrc: number
}

/** A cursor with the 7z number encoding. */
class Reader {
  readonly bytes: Uint8Array
  offset: number

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes
    this.offset = offset
  }

  get done(): boolean {
    return this.offset >= this.bytes.length
  }

  byte(): number {
    if (this.offset >= this.bytes.length) throw new Error('7z: unexpected end of header')
    const value = this.bytes[this.offset] ?? 0
    this.offset += 1
    return value
  }

  /** Variable length number: the leading one bits count the extra bytes. */
  number(): number {
    const first = this.byte()
    let mask = 0x80
    let value = 0
    for (let index = 0; index < 8; index++) {
      if ((first & mask) === 0) {
        value += (first & (mask - 1)) * 2 ** (index * 8)
        return value
      }
      value += this.byte() * 2 ** (index * 8)
      mask >>= 1
    }
    return value
  }

  /** Fixed 32-bit value: CRCs are stored this way, not as 7z numbers. */
  u32(): number {
    const b = this.bytesOf(4)
    return ((b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 24)) >>> 0
  }

  bytesOf(length: number): Uint8Array {
    const slice = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }

  /**
   * "All defined?" vector: a non-zero first byte means every entry is defined;
   * zero is followed by the packed bits. 7z uses this shape for CRC vectors.
   */
  bits2(count: number): boolean[] {
    const all = this.byte()
    if (all !== 0) return new Array<boolean>(count).fill(true)
    return this.bits(count)
  }
  /** Bit vector, MSB first, padded to a byte boundary. */
  bits(count: number): boolean[] {
    const result: boolean[] = []
    let mask = 0
    let current = 0
    for (let index = 0; index < count; index++) {
      if (mask === 0) {
        current = this.byte()
        mask = 0x80
      }
      result.push((current & mask) !== 0)
      mask >>= 1
    }
    return result
  }
}

/** Check the signature and read the start header. */
export function readLayout(bytes: Uint8Array): SevenZipLayout | undefined {
  if (bytes.length < 32) return undefined
  for (let index = 0; index < SEVEN_ZIP_SIGNATURE.length; index++) {
    if (bytes[index] !== SEVEN_ZIP_SIGNATURE[index]) return undefined
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    nextHeaderOffset: Number(view.getBigUint64(0x0c, true)),
    nextHeaderSize: Number(view.getBigUint64(0x14, true)),
    nextHeaderCrc: view.getUint32(0x1c, true),
  }
}

/** True when the next header is a compressed stream that must be decoded first. */
export function isEncodedHeader(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes[0] === ID.encodedHeader
}

/** Parse a plain kHeader payload into a listing. */
export function parseHeader(bytes: Uint8Array): SevenZipArchive | undefined {
  const reader = new Reader(bytes)
  if (reader.byte() !== ID.header) return undefined

  let folders: SevenZipFolder[] = []
  let packStreams: SevenZipPackStream[] = []

  while (!reader.done) {
    const id = reader.byte()
    if (id === ID.end) break

    if (id === ID.mainStreams) {
      const streams = parseStreamsInfo(reader)
      folders = streams.folders
      packStreams = streams.packStreams
      continue
    }

    if (id === ID.filesInfo) {
      const entries = parseFilesInfo(reader, folders)
      const encrypted = folders.some(folder => folder.coders.some(coder => coder.id === '06f10701'))
      const solid = folders.some(folder => folder.streams > 1)
      return { entries, folders, packStreams, encrypted, solid }
    }

    if (id === ID.archiveProperties || id === ID.additionalStreams) {
      while (!reader.done) {
        const sub = reader.byte()
        if (sub === ID.end) break
        reader.bytesOf(reader.number())
      }
      continue
    }

    reader.bytesOf(reader.number())
  }

  return undefined
}

/** Parse kPackInfo / kUnPackInfo / kSubStreamsInfo. */
function parseStreamsInfo(reader: Reader): {
  folders: SevenZipFolder[]
  packStreams: SevenZipPackStream[]
} {
  const folders: SevenZipFolder[] = []
  const packStreams: SevenZipPackStream[] = []
  let packPosition = 0
  let packSizes: number[] = []

  while (!reader.done) {
    const id = reader.byte()
    if (id === ID.end) break

    if (id === ID.packInfo) {
      packPosition = reader.number()
      const count = reader.number()
      packSizes = new Array<number>(count).fill(0)
      while (!reader.done) {
        const sub = reader.byte()
        if (sub === ID.end) break
        if (sub === ID.size) {
          for (let index = 0; index < count; index++) packSizes[index] = reader.number()
        } else if (sub === ID.crc) {
          const defined = reader.bits2(count)
          for (let index = 0; index < count; index++) if (defined[index] === true) reader.u32()
        } else {
          reader.bytesOf(reader.number())
        }
      }
      continue
    }

    if (id === ID.unPackInfo) {
      while (!reader.done) {
        const sub = reader.byte()
        if (sub === ID.end) break
        if (sub === ID.folder) {
          const count = reader.number()
          if (reader.byte() !== 0x00) throw new Error('7z: external folders are not supported')
          for (let index = 0; index < count; index++) folders.push(parseFolder(reader))
        } else if (sub === ID.codersUnPackSize) {
          // One size per coder output; the last one is the folder's real size.
          for (const folder of folders) {
            for (let out = 0; out < Math.max(1, folder.outputs); out++) folder.size = reader.number()
          }
        } else if (sub === ID.crc) {
          const defined = reader.bits2(folders.length)
          for (let index = 0; index < folders.length; index++) {
            const folder = folders[index]
            if (defined[index] === true && folder !== undefined) folder.crc = reader.u32()
          }
        } else {
          reader.bytesOf(reader.number())
        }
      }
      continue
    }

    if (id === ID.subStreamsInfo) {
      parseSubStreams(reader, folders)
      continue
    }

    reader.bytesOf(reader.number())
  }

  // Each folder holds one stream by default; per-stream sizes come from the
  // substreams block, and the last stream absorbs whatever is left over.
  for (const folder of folders) {
    if (folder.sizes.length === 0) folder.sizes = [folder.size]
  }

  let position = packPosition
  for (const size of packSizes) {
    packStreams.push({ offset: position, size })
    position += size
  }
  return { folders, packStreams }
}

/** kSubStreamsInfo: how many files each folder holds, and their sizes. */
function parseSubStreams(reader: Reader, folders: SevenZipFolder[]): void {
  const counts = folders.map(() => 1)

  while (!reader.done) {
    const id = reader.byte()
    if (id === ID.end) break

    if (id === ID.numUnPackStream) {
      for (let index = 0; index < folders.length; index++) counts[index] = reader.number()
      continue
    }

    if (id === ID.size) {
      for (let index = 0; index < folders.length; index++) {
        const total = counts[index] ?? 1
        const folder = folders[index]
        const sizes: number[] = []
        let assigned = 0
        for (let stream = 0; stream < total - 1; stream++) {
          const size = reader.number()
          sizes.push(size)
          assigned += size
        }
        sizes.push(Math.max(0, (folder?.size ?? 0) - assigned))
        if (folder !== undefined) folder.sizes = sizes
      }
      continue
    }

    if (id === ID.crc) {
      const total = counts.reduce((sum, count) => sum + count, 0)
      const defined = reader.bits2(total)
      for (let index = 0; index < total; index++) if (defined[index] === true) reader.u32()
      continue
    }

    throw new Error(`7z: unexpected substreams id ${id.toString(16)}`)
  }

  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index]
    if (folder !== undefined) folder.streams = counts[index] ?? 1
  }
}

/** Parse one folder definition (coder chain). */
function parseFolder(reader: Reader): SevenZipFolder {
  const coderCount = reader.number()
  const coders: SevenZipCoder[] = []
  let totalIn = 0
  let totalOut = 0

  for (let index = 0; index < coderCount; index++) {
    const flags = reader.byte()
    const idLength = flags & 0x0f
    const complex = (flags & 0x10) !== 0
    const hasAttributes = (flags & 0x20) !== 0
    const id = [...reader.bytesOf(idLength)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const inStreams = complex ? reader.number() : 1
    const outStreams = complex ? reader.number() : 1
    const properties = hasAttributes ? reader.bytesOf(reader.number()) : new Uint8Array()
    totalIn += inStreams
    totalOut += outStreams
    coders.push({ id, name: CODEC_NAMES[id] ?? id, inStreams, outStreams, properties })
  }

  const bindPairs = totalOut - 1
  for (let index = 0; index < bindPairs; index++) { reader.number(); reader.number() }

  const packedCount = totalIn - bindPairs
  for (let index = 0; index < packedCount - 1; index++) reader.number()

  const supported = coders.every(coder => coder.id === '030101' || coder.id === '21' || coder.id === '00')
  return { coders, size: 0, sizes: [], streams: 1, outputs: totalOut, supported }
}

/** Parse kFilesInfo: names, directory flags and per-stream sizes. */
function parseFilesInfo(reader: Reader, folders: readonly SevenZipFolder[]): SevenZipEntry[] {
  const fileCount = reader.number()
  let emptyStream = new Array<boolean>(fileCount).fill(false)
  let emptyFile = new Array<boolean>(fileCount).fill(false)
  let names: string[] = []

  while (!reader.done) {
    const id = reader.byte()
    if (id === ID.end) break
    const size = reader.number()

    if (id === ID.emptyStream) { emptyStream = reader.bits(fileCount); continue }
    if (id === ID.emptyFile) { emptyFile = reader.bits(fileCount); continue }
    if (id === ID.name) {
      const external = reader.byte()
      if (external !== 0x00) throw new Error('7z: external names are not supported')
      names = new TextDecoder('utf-16le')
        .decode(reader.bytesOf(size - 1))
        .split('\u0000')
        .filter(name => name !== '')
      continue
    }
    reader.bytesOf(size)
  }

  const entries: SevenZipEntry[] = []
  let folderIndex = -1
  let stream = -1
  for (let index = 0; index < fileCount; index++) {
    const name = names[index] ?? `file_${String(index + 1)}`
    if (emptyStream[index] === true) {
      // No data: a directory when kEmptyFile does not mark it as an empty file.
      entries.push({ name, size: 0, directory: emptyFile[index] !== true, encrypted: false, folder: -1, stream: -1 })
      continue
    }
    const nextFolder = folderIndex < 0 || (folders[folderIndex]?.sizes.length ?? 0) <= stream + 1
    if (nextFolder) {
      folderIndex += 1
      stream = 0
    } else {
      stream += 1
    }
    const folder = folders[folderIndex]
    entries.push({
      name,
      size: folder?.sizes[stream] ?? folder?.size ?? 0,
      directory: false,
      encrypted: folder?.coders.some(coder => coder.id === '06f10701') ?? false,
      folder: folderIndex,
      stream,
    })
  }
  return entries
}

/** CRC32 helper, so a caller can verify the start header. */
export function crc32Of(bytes: Uint8Array): number {
  return crc32(bytes)
}
