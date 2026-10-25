/** Pure zip and tar parsing, so the formats can be tested without a browser. */

/** One listed archive member. */
export interface ArchiveEntry {
  readonly name: string
  readonly size: number
  readonly directory: boolean
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
    const nameLength = u16(directory, at + 28)
    const extraLength = u16(directory, at + 30)
    const commentLength = u16(directory, at + 32)
    const size = u32(directory, at + 24)
    const name = new TextDecoder('utf-8').decode(directory.subarray(at + 46, at + 46 + nameLength))
    entries.push({ name, size, directory: name.endsWith('/') })
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
    entries.push({ name, size, directory: type === '5' || name.endsWith('/') })
    at += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}
