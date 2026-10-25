/**
 * Extract one archive member to disk so the standard preview can open it.
 *
 * The Host filesystem service reads bytes but has no binary write, so the write
 * itself uses Node's fs, confined to the directory the caller names and to a
 * sanitized base name. Anything that would escape that directory is refused.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { zipEntryBytes } from '../client/previews/archive/parse.ts'

/** Refuse archives larger than this before loading them into memory. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

/** Refuse members larger than this after expansion. */
const MAX_ENTRY_BYTES = 128 * 1024 * 1024

/** Path this route claims on the authenticated Fetch channel. */
export const EXTRACT_ROUTE_PATH = '/api/any-preview/extract'

/** The slice of the Host filesystem service this route uses. */
interface HostFileSystem {
  resolve(path: string, options: { signal: AbortSignal }): Promise<unknown>
  stat(target: unknown, signal: AbortSignal): Promise<{ type?: string, size?: number } | undefined>
  readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
}

export interface ExtractRouteContext {
  readonly fs: HostFileSystem
  readonly connection: {
    readonly fetch: {
      register(route: {
        path: string
        methods: string[]
        requestBody: 'buffered'
        fetch(request: Request): Promise<Response>
      }): () => void
    }
  }
}

interface ExtractRequest {
  readonly archive: string
  readonly entry: string
  readonly targetDir: string
}

/**
 * Reduce a member path to one safe file name.
 * @param name - member name as stored in the archive.
 * @returns a base name with separators and traversal removed.
 */
export function safeEntryName(name: string): string {
  const base = basename(name.replaceAll('\\', '/'))
  const cleaned = base.replace(/[\0<>:"|?*]/gu, '_').replace(/^\.+$/u, '_')
  return cleaned === '' ? 'entry' : cleaned
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
): Promise<string> {
  const data = await zipEntryBytes(archiveBytes, entryName, bytes => inflateRawSync(bytes))
  if (data.byteLength > MAX_ENTRY_BYTES) {
    throw new Error(`条目解压后 ${String(data.byteLength)} 字节，超过上限`)
  }
  await mkdir(targetDir, { recursive: true })
  const path = join(targetDir, safeEntryName(entryName))
  await writeFile(path, data)
  return path
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
  const { archive, entry, targetDir } = body
  if (typeof archive !== 'string' || typeof entry !== 'string' || typeof targetDir !== 'string') {
    return failure(400, 'archive, entry and targetDir are required')
  }
  if (!isAbsolute(archive) || !isAbsolute(targetDir)) return failure(400, 'absolute paths required')
  if (archive.includes('\0') || entry.includes('\0') || targetDir.includes('\0')) return failure(400, 'nul byte')

  try {
    const target = await ctx.fs.resolve(archive, { signal: request.signal })
    const info = await ctx.fs.stat(target, request.signal)
    if (info === undefined) return failure(404, 'archive not found')
    if (info.type !== 'file') return failure(403, 'not a regular file')
    if ((info.size ?? 0) > MAX_ARCHIVE_BYTES) return failure(413, 'archive exceeds size limit')

    const bytes = await ctx.fs.readBytes(target, request.signal, MAX_ARCHIVE_BYTES)
    const path = await extractEntryTo(bytes, entry, targetDir)
    return Response.json({ path }, { headers: { 'Cache-Control': 'private, no-store' } })
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
