/**
 * Client-side zip/tar IO: ranged reads over the shared file route, directory
 * listing, and per-entry expansion.
 *
 * Both the archive preview and the EPUB reader sit on this, so the ranged-read
 * fallbacks (`Content-Range` for the size, 200 answers to a Range request) are
 * written once. The pure byte parsing lives in `shared/zip/parse.ts`.
 */
import { findEocd, inflateRaw, localDataStart, parseTar, parseZipDirectory, zipDirectoryRange } from '../../shared/zip/parse.ts'
import type { ArchiveEntry } from '../../shared/zip/parse.ts'
import { formatBytes } from './format.ts'

/** Anything read whole must fit this. */
export const MAX_WHOLE_BYTES = 64 * 1024 * 1024

/** Largest member expanded inline; bigger payloads stay on disk. */
export const MAX_ENTRY_BYTES = 2 * 1024 * 1024

/** Enough tail to cover an archive comment plus the end-of-central-directory record. */
const TAIL_BYTES = 66_000

/** Read an inclusive byte window, working whether or not the server honours Range. */
export async function readRange(url: string, start: number, end: number): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=${String(start)}-${String(end)}` } })
  if (response.status === 206) return new Uint8Array(await response.arrayBuffer())
  if (response.status === 200) {
    // The server ignored Range and sent everything.
    const whole = new Uint8Array(await response.arrayBuffer())
    return whole.subarray(start, Math.min(whole.length, end + 1))
  }
  throw new Error(`读取失败（HTTP ${String(response.status)}）`)
}

/**
 * Total size from a one-byte range. `Content-Range` carries it and, unlike
 * `Content-Length`, survives the desktop shell's forwarding proxy.
 */
export async function fileSize(url: string): Promise<number | undefined> {
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } })
  if (response.status !== 206) {
    await response.body?.cancel()
    return undefined
  }
  const match = /\/(\d+)$/u.exec(response.headers.get('content-range') ?? '')
  await response.body?.cancel()
  return match === null ? undefined : Number(match[1])
}

/** Read the whole file. */
export function readAll(url: string): Promise<Uint8Array> {
  return fetch(url).then(async (response) => {
    if (response.status !== 200 && response.status !== 206) {
      throw new Error(`读取失败（HTTP ${String(response.status)}）`)
    }
    return new Uint8Array(await response.arrayBuffer())
  })
}

/** Decompress a gzip stream with the platform's inflate. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // A Uint8Array view is a valid BlobPart; the cast keeps lib.dom's stricter
  // ArrayBufferLike typing out of the call site.
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Parse the central directory out of a complete archive buffer. */
export function listEntriesFromBuffer(archive: Uint8Array): ArchiveEntry[] {
  const eocd = findEocd(archive)
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录')
  const range = zipDirectoryRange(archive, eocd)
  if (range === undefined) throw new Error('暂不支持 ZIP64 格式')
  if (range.size === 0) return []
  return parseZipDirectory(archive.subarray(range.offset, range.offset + range.size))
}

/**
 * List a zip's members, reading only the central directory when the size is known.
 * @param url - file URL.
 * @param sizeHint - size from metadata; 0/undefined means "probe it".
 */
export async function listZipEntries(url: string, sizeHint: number): Promise<ArchiveEntry[]> {
  const size = sizeHint > 0 ? sizeHint : await fileSize(url)

  if (size === undefined || size <= 0) {
    const whole = await readAll(url)
    if (whole.length > MAX_WHOLE_BYTES) {
      throw new Error(`压缩包 ${formatBytes(whole.length)} 超过 ${formatBytes(MAX_WHOLE_BYTES)} 上限`)
    }
    return listEntriesFromBuffer(whole)
  }

  const tailStart = Math.max(0, size - TAIL_BYTES)
  const tail = await readRange(url, tailStart, size - 1)
  const eocd = findEocd(tail)
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录')
  const range = zipDirectoryRange(tail, eocd)
  if (range === undefined) throw new Error('暂不支持 ZIP64 格式')
  if (range.size === 0) return []

  const inTail = range.offset >= tailStart && range.offset + range.size <= tailStart + tail.length
  const directory = inTail
    ? tail.subarray(range.offset - tailStart, range.offset - tailStart + range.size)
    : await readRange(url, range.offset, range.offset + range.size - 1)
  return parseZipDirectory(directory)
}

/**
 * List a tar's members, inflating first when the payload is gzipped.
 * @param url - file URL.
 * @param size - size from metadata, for the whole-file cap.
 */
export async function listTarEntries(url: string, size: number): Promise<ArchiveEntry[]> {
  if (size > MAX_WHOLE_BYTES) {
    throw new Error(`压缩包 ${formatBytes(size)} 超过 ${formatBytes(MAX_WHOLE_BYTES)} 上限`)
  }
  const bytes = await readAll(url)
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b
  return parseTar(gzipped ? await gunzip(bytes) : bytes)
}

/**
 * Expand one member by reading its local header and payload from the route.
 * @param url - file URL.
 * @param entry - listed member.
 * @param maxBytes - expansion cap.
 */
export async function readEntryBytesFromUrl(url: string, entry: ArchiveEntry, maxBytes = MAX_ENTRY_BYTES): Promise<Uint8Array> {
  if (entry.size > maxBytes) {
    throw new Error(`条目 ${formatBytes(entry.size)} 超过 ${formatBytes(maxBytes)} 上限`)
  }
  const header = await readRange(url, entry.offset, entry.offset + 29)
  const dataStart = entry.offset + localDataStart(header)
  const raw = entry.compressedSize === 0
    ? new Uint8Array()
    : await readRange(url, dataStart, dataStart + entry.compressedSize - 1)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRaw(raw)
  throw new Error(`暂不支持压缩方法 ${String(entry.method)}`)
}

/**
 * Expand one member out of an archive already held in memory.
 * @param archive - the whole archive.
 * @param entry - listed member.
 */
export async function entryBytes(archive: Uint8Array, entry: ArchiveEntry): Promise<Uint8Array> {
  const start = entry.offset + localDataStart(archive.subarray(entry.offset, entry.offset + 30))
  const raw = archive.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRaw(raw)
  throw new Error(`暂不支持压缩方法 ${String(entry.method)}`)
}

/** Compare entry names across the separators and `./` prefixes archives use. */
export function normalizeEntryName(name: string): string {
  return name.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase()
}

/** Find a listed member by name. */
export function findEntry(entries: readonly ArchiveEntry[], name: string): ArchiveEntry | undefined {
  const wanted = normalizeEntryName(name)
  return entries.find(entry => normalizeEntryName(entry.name) === wanted)
}

/**
 * Read one member as UTF-8 text.
 * @param archive - the whole archive.
 * @param entries - its listing.
 * @param name - member name.
 * @returns the decoded text, or undefined when the member is absent.
 */
export async function readEntryText(
  archive: Uint8Array,
  entries: readonly ArchiveEntry[],
  name: string,
): Promise<string | undefined> {
  const entry = findEntry(entries, name)
  if (entry === undefined) return undefined
  const bytes = await entryBytes(archive, entry)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}
