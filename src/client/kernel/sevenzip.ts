/**
 * 7z reading over the shared file route: ranged reads plus lib/lzma.wasm.
 *
 * The header may be compressed (kEncodedHeader), so the decoder is loaded lazily and
 * only when a compressed header or an entry payload actually needs it. When the wasm
 * asset is missing, callers see a rejected promise and can fall back to a notice.
 */
import { loadWasm } from './assets.ts'
import { readRange } from './zip.ts'
import {
  isEncodedHeader, parseEncodedHeader, parseHeader, readLayout,
} from '../../shared/sevenzip/structure.ts'
import type { SevenZipArchive, SevenZipEntry, SevenZipPackStream } from '../../shared/sevenzip/structure.ts'
import { canDecode, decodeFolder } from '../../shared/sevenzip/decode.ts'
import type { Decoder } from '../../shared/sevenzip/decode.ts'

/** Packed offsets are relative to the end of the 32-byte signature header. */
const DATA_START = 32

/** One decoder instance per page; instantiation is not free. */
let pending: Promise<Decoder> | undefined

/**
 * Load lib/lzma.wasm once.
 * @returns the module's exports typed as the decoder contract.
 */
export async function decoder(): Promise<Decoder> {
  pending ??= loadWasm('lzma.wasm', {}).then(instance => instance.exports as unknown as Decoder)
  return pending
}

/** Read one packed stream from the file. */
function readPacked(url: string, stream: SevenZipPackStream): Promise<Uint8Array> {
  const start = DATA_START + stream.offset
  return readRange(url, start, start + stream.size - 1)
}

/**
 * Read and parse a 7z archive's listing.
 * @param url - ranged URL of the archive
 */
export async function readSevenZip(url: string): Promise<SevenZipArchive> {
  const layout = readLayout(await readRange(url, 0, 31))
  if (layout === undefined) throw new Error('not a 7z archive')

  const start = DATA_START + layout.nextHeaderOffset
  let next = await readRange(url, start, start + layout.nextHeaderSize - 1)

  if (isEncodedHeader(next)) {
    const streams = parseEncodedHeader(next)
    const folder = streams?.folders[0]
    const stream = streams?.packStreams[0]
    if (streams === undefined || folder === undefined || stream === undefined) {
      throw new Error('7z: encoded header is incomplete')
    }
    next = decodeFolder(await decoder(), folder, await readPacked(url, stream))
  }

  const archive = parseHeader(next)
  if (archive === undefined) throw new Error('7z: header could not be parsed')
  return archive
}

/**
 * Extract one entry's bytes.
 *
 * A folder is the smallest decodable unit, so a solid archive decodes the whole
 * folder and slices the requested stream out of it.
 */
export async function readSevenZipEntry(
  url: string,
  archive: SevenZipArchive,
  entry: SevenZipEntry,
): Promise<Uint8Array> {
  const folder = archive.folders[entry.folder]
  const stream = archive.packStreams[0]
  if (folder === undefined || stream === undefined) throw new Error('7z: entry has no stream')
  if (!canDecode(folder)) throw new Error('7z: unsupported coder chain (AES or filters)')

  const output = decodeFolder(await decoder(), folder, await readPacked(url, stream))
  let offset = 0
  for (let index = 0; index < entry.stream; index++) offset += folder.sizes[index] ?? 0
  return output.slice(offset, offset + entry.size)
}

/** True when this archive can be opened entry by entry. */
export function isSupported(archive: SevenZipArchive): boolean {
  return archive.encrypted === false && archive.folders.every(folder => canDecode(folder))
}

/** Base64 for a byte array, chunked so large entries do not blow the call stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * Write already-decoded bytes to disk through the extraction route.
 *
 * 7z decodes in the browser, so the Host receives the finished member rather than
 * the archive. Naming, size limits and reuse of an identical file match zip's path.
 */
export async function writeExtracted(
  entryName: string,
  bytes: Uint8Array,
  targetDir: string,
  force = false,
): Promise<string> {
  const response = await fetch(new URL('api/any-preview/extract', document.baseURI), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'write', entry: entryName, targetDir, data: toBase64(bytes), force }),
  })
  if (!response.ok) throw new Error(await response.text())
  const result = await response.json() as { path: string }
  return result.path
}
/** Whether an earlier extraction of this member is still on disk. */
export async function checkExtracted(entryName: string, targetDir: string): Promise<string | undefined> {
  const response = await fetch(new URL('api/any-preview/extract', document.baseURI), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'check', entry: entryName, targetDir }),
  })
  if (!response.ok) return undefined
  const result = await response.json() as { exists: boolean, path: string | null }
  return result.exists ? (result.path ?? undefined) : undefined
}
/** Remove the extraction directory through the shared clean action. */
export async function cleanExtracted(targetDir: string): Promise<number> {
  const response = await fetch(new URL('api/any-preview/extract', document.baseURI), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clean', targetDir }),
  })
  if (!response.ok) throw new Error(await response.text())
  const result = await response.json() as { removed: number }
  return result.removed
}