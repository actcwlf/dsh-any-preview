/**
 * Extract one archive member to disk so the standard preview can open it.
 *
 * The Host filesystem service reads bytes but has no binary write, so the write
 * itself uses Node's fs, confined to the directory the caller names and to a
 * sanitized base name. Anything that would escape that directory is refused.
 */
import { LIMITS } from '../shared/limits.ts'
import { appendFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { zipEntryBytes } from '../shared/zip/parse.ts'
import {
  EXTRACTION_DIR,
  safeEntryPath,
  safeEntryName,
} from '../shared/archive-paths.ts'
import type { RouteContext } from './contracts.ts'

export { safeEntryName } from '../shared/archive-paths.ts'

/** Refuse archives larger than this before loading them into memory. */
const MAX_ARCHIVE_BYTES = LIMITS.hostArchive

/** Refuse members larger than this after expansion. */
const MAX_ENTRY_BYTES = LIMITS.hostEntry

/** Path this route claims on the authenticated Fetch channel. */
export const EXTRACT_ROUTE_PATH = '/api/any-preview/extract'

/** The slice of the Host context this route touches. */
export type ExtractRouteContext = RouteContext

interface ExtractRequest {
  /** `extract` (default), `check` for an existing copy, `clean` for the directory. */
  readonly action?: 'extract' | 'check' | 'clean' | 'write' | 'begin' | 'append' | 'end' | 'abort'
  /** Base64 payload for `write`: the already-decoded member bytes. */
  readonly data?: string
  /** Rewrite even when an identical extraction is present. */
  readonly force?: boolean
  readonly archive?: string
  readonly entry?: string
  readonly targetDir: string
}

/**
 * Write one member into a directory and return the file it wrote.
 * @param archiveBytes - the whole archive.
 * @param entryName - exact member name.
 * @param targetDir - absolute destination directory (created when missing).
 * @returns the written file's absolute path.
 */
export async function extractEntryTo(
  archiveBytes: Uint8Array,
  entryName: string,
  targetDir: string,
  force = false,
): Promise<string> {
  const data = await zipEntryBytes(archiveBytes, entryName, bytes => inflateRawSync(bytes))
  if (data.byteLength > MAX_ENTRY_BYTES) {
    throw new Error(`条目解压后 ${String(data.byteLength)} 字节，超过上限`)
  }
  const path = join(targetDir, safeEntryPath(entryName))
  // Reuse an identical previous extraction: reopening an entry should not
  // rewrite it, and the file stays openable by the standard preview.
  if (!force) {
    const existing = await stat(path).catch(() => undefined)
    if (existing !== undefined && existing.isFile() && existing.size === data.byteLength) return path
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
  return path
}


/**
 * Write bytes the client decoded itself, e.g. a member of a 7z archive.
 * @param data - the decoded member.
 * @param entryName - member name, reduced to a safe base name.
 * @param targetDir - absolute destination directory.
 * @param force - rewrite even when an identical copy exists.
 * @returns the written file's absolute path.
 */
export async function writeEntryBytesTo(
  data: Uint8Array,
  entryName: string,
  targetDir: string,
  force = false,
): Promise<string> {
  if (data.byteLength > MAX_ENTRY_BYTES) {
    throw new Error(`条目解压后 ${String(data.byteLength)} 字节，超过上限`)
  }
  const path = join(targetDir, safeEntryPath(entryName))
  if (!force) {
    const existing = await stat(path).catch(() => undefined)
    if (existing !== undefined && existing.isFile() && existing.size === data.byteLength) return path
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, data)
  return path
}

/** Path of the partial file used while a streaming extraction is in progress. */
export function partPathOf(entryName: string, targetDir: string): string {
  return join(targetDir, `${safeEntryPath(entryName)}.part`)
}

/** Start a streaming extraction: an empty partial file under the target. */
export async function beginExtraction(entryName: string, targetDir: string): Promise<string> {
  const part = partPathOf(entryName, targetDir)
  await mkdir(dirname(part), { recursive: true })
  await writeFile(part, new Uint8Array())
  return join(targetDir, safeEntryPath(entryName))
}

/** Append one decoded chunk, refusing to grow past the entry limit. */
export async function appendExtraction(entryName: string, targetDir: string, chunk: Uint8Array): Promise<void> {
  const part = partPathOf(entryName, targetDir)
  const info = await stat(part).catch(() => undefined)
  if (info === undefined) throw new Error('no extraction in progress')
  if ((info.size ?? 0) + chunk.byteLength > MAX_ENTRY_BYTES) {
    await rm(part, { force: true })
    throw new Error('entry exceeds size limit')
  }
  await appendFile(part, chunk)
}

/** Finish a streaming extraction: the partial file takes its final name. */
export async function endExtraction(entryName: string, targetDir: string): Promise<string> {
  const final = join(targetDir, safeEntryPath(entryName))
  await rename(partPathOf(entryName, targetDir), final)
  return final
}

/** Drop a half-written extraction. */
export async function abortExtraction(entryName: string, targetDir: string): Promise<void> {
  await rm(partPathOf(entryName, targetDir), { force: true })
}
/** Whether a previous extraction of this member is still on disk. */
export async function extractedPathOf(entryName: string, targetDir: string): Promise<string | undefined> {
  const path = join(targetDir, safeEntryPath(entryName))
  const info = await stat(path).catch(() => undefined)
  return info !== undefined && info.isFile() ? path : undefined
}

/**
 * Remove an extraction directory. Only `.dsh-any-preview` directories are
 * removable, so a mistyped path cannot delete a user directory.
 * @param targetDir - the directory the client extracted into.
 * @returns how many files were removed.
 */
export async function cleanExtractionDir(targetDir: string): Promise<number> {
  if (basename(dirname(targetDir)) !== EXTRACTION_DIR) {
    throw new Error('只能清理 .dsh-any-preview 下的压缩包子目录')
  }
  const info = await stat(targetDir).catch(() => undefined)
  if (info === undefined) return 0
  const before = await readdir(targetDir).catch(() => [] as string[])
  await rm(targetDir, { recursive: true, force: true })
  return before.length
}

function failure(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
  })
}

async function handle(request: Request, ctx: ExtractRouteContext): Promise<Response> {
  let body: ExtractRequest
  try {
    body = await request.json() as ExtractRequest
  } catch {
    return failure(400, 'invalid json')
  }
  const { archive, entry, targetDir, action, force } = body
  if (typeof targetDir !== 'string') return failure(400, 'targetDir is required')
  if (!isAbsolute(targetDir)) return failure(400, 'absolute paths required')
  if (targetDir.includes('\0')) return failure(400, 'nul byte')

  const json = (value: unknown): Response =>
    Response.json(value, { headers: { 'Cache-Control': 'private, no-store' } })

  try {
    if (action === 'clean') return json({ removed: await cleanExtractionDir(targetDir) })

    if (typeof entry !== 'string' || entry.includes('\0')) return failure(400, 'entry is required')

    if (action === 'check') {
      const path = await extractedPathOf(entry, targetDir)
      return json({ exists: path !== undefined, path: path ?? null })
    }

    const partPath = partPathOf(entry, targetDir)
    const finalPath = join(targetDir, safeEntryPath(entry))

    if (action === 'begin') {
      await mkdir(dirname(partPath), { recursive: true })
      await writeFile(partPath, new Uint8Array())
      return json({ path: finalPath })
    }

    if (action === 'append') {
      if (typeof body.data !== 'string') return failure(400, 'data is required')
      const decoded = Buffer.from(body.data, 'base64')
      const info = await stat(partPath).catch(() => undefined)
      if (info === undefined) return failure(409, 'no extraction in progress')
      if ((info.size ?? 0) + decoded.length > MAX_ENTRY_BYTES) {
        await rm(partPath, { force: true })
        return failure(413, 'entry exceeds size limit')
      }
      await appendFile(partPath, decoded)
      return json({ written: decoded.length })
    }

    if (action === 'end') {
      await mkdir(dirname(finalPath), { recursive: true })
      await rename(partPath, finalPath)
      return json({ path: finalPath })
    }

    if (action === 'abort') {
      await rm(partPath, { force: true })
      return json({ removed: true })
    }

    if (action === 'write') {
      if (typeof body.data !== 'string') return failure(400, 'data is required')
      const decoded = Buffer.from(body.data, 'base64')
      const written = await writeEntryBytesTo(new Uint8Array(decoded), entry, targetDir, force === true)
      return json({ path: written })
    }

    if (typeof archive !== 'string' || !isAbsolute(archive)) return failure(400, 'absolute archive path required')
    if (archive.includes('\0')) return failure(400, 'nul byte')

    const target = await ctx.fs.resolve(archive, { signal: request.signal })
    const info = await ctx.fs.stat(target, request.signal)
    if (info === undefined) return failure(404, 'archive not found')
    if (info.type !== 'file') return failure(403, 'not a regular file')
    if ((info.size ?? 0) > MAX_ARCHIVE_BYTES) return failure(413, 'archive exceeds size limit')

    const bytes = await ctx.fs.readBytes(target, request.signal, MAX_ARCHIVE_BYTES)
    const path = await extractEntryTo(bytes, entry, targetDir, force === true)
    return json({ path })
  } catch (error) {
    return failure(500, error instanceof Error ? error.message : 'extract failed')
  }
}

/**
 * Claim the extraction route for the plugin lifetime.
 * @param ctx - Host context carrying `connection` and `fs`.
 */
export function registerExtractRoute(ctx: ExtractRouteContext): () => void {
  return ctx.connection.fetch.register({
    path: EXTRACT_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handle(request, ctx),
  })
}
