/**
 * One file, resolved the way every `/api/any-preview` route resolves it.
 *
 * The routes differ in what they serve (media bytes, text slices), not in who may
 * read what: a path must be absolute, must map to the Host's own filesystem, must
 * round-trip to the same location (no alias spelling), and must be a regular file.
 * Keeping the checks here is what stops one route from drifting into a weaker
 * policy than its neighbour.
 */
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { HostFileSystem } from './contracts.ts'

/** Headers every route in this plugin sets. */
export const ROUTE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
}

/** Filesystem error codes this plugin's routes report as HTTP statuses. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_ABORTED: 499,
}

/** A path the Host will serve, with the identity and size already read. */
export interface HostFile {
  readonly target: unknown
  /** Bytes in the file; 0 when the backend does not report a size. */
  readonly size: number
  readonly displayPath: string
}

/** A plain-text failure response. */
export function failure(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { ...ROUTE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Map a thrown filesystem error to its status, or rethrow what is not one.
 * @param error - whatever the backend threw.
 * @returns the response to send.
 */
export function failureFrom(error: unknown): Response {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code === undefined) throw error
  return failure(STATUS_BY_CODE[code] ?? 500, code)
}

/**
 * Resolve a query-supplied path to a file the Host may serve.
 * @param fs - Host filesystem service.
 * @param path - absolute path from the query string.
 * @param signal - request lifetime.
 * @returns the file, or the response to send instead.
 */
export async function resolveHostFile(fs: HostFileSystem, path: string, signal: AbortSignal): Promise<HostFile | Response> {
  if (path.length === 0) return failure(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return failure(400, 'absolute path required')

  // Only accept a path the Host actually maps, and only when it round-trips to
  // the same location — an alias or symlink spelling is refused.
  const mapped = fs.processPathFromHostPath(path)
  if (mapped === undefined) return failure(422, 'unmapped host path')

  let target: unknown
  let info: Awaited<ReturnType<HostFileSystem['stat']>>
  try {
    target = await fs.resolve(mapped, { signal })
    if (resolvePath(fs.processPath(target)) !== resolvePath(path)) return failure(422, 'unmapped host path')
    info = await fs.stat(target, signal)
  } catch (error) {
    return failureFrom(error)
  }
  if (info === undefined) return failure(404, 'not found')
  if (info.type !== 'file') return failure(403, 'not a regular file')
  return { target, size: info.size ?? 0, displayPath: info.displayPath ?? path }
}
