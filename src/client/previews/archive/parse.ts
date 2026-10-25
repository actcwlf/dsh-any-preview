/** Pure zip and tar parsing, so the formats can be tested without a browser. */

/** One listed archive member. */
export interface ArchiveEntry {
  readonly name: string
  /** Uncompressed size in bytes. */
  readonly size: number
  readonly directory: boolean
  /** Zip compression method; 0 (stored) for tar members. */
  readonly method: number
  /** Bytes of compressed payload; equals {@link size} for stored members. */
  readonly compressedSize: number
  /** Offset of the local header (zip) or of the data (tar). */
  readonly offset: number
}

/** Cap on listed entries. */
export const MAX_ENTRIES = 5_000

export function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8)
}

export function u32(bytes: Uint8Array, at: number): number {
  return (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0
}

/**
 * Find the end-of-central-directory signature, scanning backwards.
 * @param bytes - a tail window or the complete archive.
 * @returns the signature offset within `bytes`, or -1.
 */
export function findEocd(bytes: Uint8Array): number {
  for (let at = bytes.length - 22; at >= 0; at -= 1) {
    if (u32(bytes, at) === 0x06054b50) return at
  }
  return -1
}

/**
 * Read the central directory's absolute offset and length from an EOCD record.
 * @param bytes - the buffer the EOCD was found in.
 * @param eocd - offset of the EOCD signature.
 * @returns the directory location, or undefined for ZIP64 (unsupported).
 */
export function zipDirectoryRange(bytes: Uint8Array, eocd: number): { offset: number, size: number } | undefined {
  const size = u32(bytes, eocd + 12)
  const offset = u32(bytes, eocd + 16)
  if (offset === 0xffffffff || size === 0xffffffff) return undefined
  return { offset, size }
}

/** Parse the zip central directory into entries. */
export function parseZipDirectory(directory: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let at = 0
  while (at + 46 <= directory.length && entries.length < MAX_ENTRIES) {
    if (u32(directory, at) !== 0x02014b50) break
    const method = u16(directory, at + 10)
    const compressedSize = u32(directory, at + 20)
    const nameLength = u16(directory, at + 28)
    const extraLength = u16(directory, at + 30)
    const commentLength = u16(directory, at + 32)
    const size = u32(directory, at + 24)
    const offset = u32(directory, at + 42)
    const name = new TextDecoder('utf-8').decode(directory.subarray(at + 46, at + 46 + nameLength))
    entries.push({ name, size, directory: name.endsWith('/'), method, compressedSize, offset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Walk tar headers (512-byte blocks, octal size fields). */
export function parseTar(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = []
  let at = 0
  const decoder = new TextDecoder()
  while (at + 512 <= bytes.length && entries.length < MAX_ENTRIES) {
    const header = bytes.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) break
    const rawName = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/u, '')
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/u, '')
    const name = prefix === '' ? rawName : `${prefix}/${rawName}`
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(/[\0 ]+$/u, '').trim()
    const size = Number.parseInt(sizeField, 8) || 0
    const type = String.fromCharCode(header[156] ?? 0)
    entries.push({
      name,
      size,
      directory: type === '5' || name.endsWith('/'),
      method: 0,
      compressedSize: size,
      offset: at + 512,
    })
    at += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

/**
 * Offset of the payload inside a zip local file header.
 * @param header - the first 30 or more bytes at the entry's `offset`.
 * @returns bytes from the header start to the first payload byte.
 */
export function localDataStart(header: Uint8Array): number {
  if (u32(header, 0) !== 0x04034b50) throw new Error('不是 ZIP 局部文件头')
  return 30 + u16(header, 26) + u16(header, 28)
}

/** Inflate a raw deflate stream with the platform decoder. */
export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Decode bytes as UTF-8 text, refusing content that is obviously binary.
 * @param bytes - candidate payload.
 * @returns the decoded text, or undefined when it is not text.
 */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Locate one member's compressed payload inside a complete archive.
 * @param archive - the whole archive.
 * @param entry - a member from {@link parseZipDirectory}.
 * @returns the still-compressed bytes (stored members are returned as-is).
 */
export function zipEntryPayload(archive: Uint8Array, entry: ArchiveEntry): Uint8Array {
  const start = entry.offset + localDataStart(archive.subarray(entry.offset, entry.offset + 30))
  return archive.subarray(start, start + entry.compressedSize)
}

/**
 * Expand one zip member from a complete archive buffer.
 * @param archive - the whole archive.
 * @param name - exact member name.
 * @param inflate - the platform's raw-deflate decoder (sync or async).
 * @returns the member's bytes.
 */
export async function zipEntryBytes(
  archive: Uint8Array,
  name: string,
  inflate: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<Uint8Array> {
  const eocd = findEocd(archive)
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录')
  const range = zipDirectoryRange(archive, eocd)
  if (range === undefined) throw new Error('暂不支持 ZIP64 格式')
  const entry = parseZipDirectory(archive.subarray(range.offset, range.offset + range.size))
    .find(candidate => candidate.name === name)
  if (entry === undefined) throw new Error(`压缩包内没有 ${name}`)
  if (entry.directory) throw new Error('这是一个目录，不是文件')
  const payload = zipEntryPayload(archive, entry)
  if (entry.method === 0) return payload
  if (entry.method === 8) return inflate(payload)
  throw new Error(`暂不支持压缩方法 ${String(entry.method)}`)
}
