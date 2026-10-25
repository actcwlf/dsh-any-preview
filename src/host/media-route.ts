/**
 * Authenticated byte-range route for media previews.
 *
 * `/api/file` answers the complete body and ignores `Range`, with a byte cap
 * sized for images. A `<video>`/`<audio>` element needs `206 Partial Content`
 * to seek, so this route streams the requested window with `fs.readByteRange`
 * instead of buffering the file.
 *
 * Living under `/api` means the connection carrier applies its Host/Origin
 * fence and browser authentication before this handler runs.
 */
import { basename, extname, isAbsolute, resolve as resolvePath } from 'node:path'
import { LAN_ROUTE_PATH, lanBaseUrl } from './lan-route.ts'
import { signLanPath } from './lan-url.ts'
import type { HostFileSystem, RouteContext } from './contracts.ts'

/** Exact pathname claimed on the shared `/api` Fetch channel. */
export const MEDIA_ROUTE_PATH = '/api/any-preview/media'

/** Bytes read per stream pull; also the seek granularity. */
const CHUNK_BYTES = 1024 * 1024

/** Media types a browser can hand to a native media element. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  mid: 'audio/midi',
  midi: 'audio/midi',
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * Resolve a filename to the media type its element needs.
 * @param path - File path or display path.
 * @returns the media type, or `application/octet-stream` when unknown.
 */
export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Parse one single-range `Range` header against a known size.
 *
 * Multiple ranges are deliberately unsupported: browsers use them only for
 * exotic media, and answering the complete body is a valid fallback.
 * @param header - raw `Range` header.
 * @param size - complete file size in bytes.
 * @returns the window, `'invalid'` when the header asks outside the file, or
 *   `undefined` to serve the complete body.
 */
export function parseRange(header: string | null, size: number): { start: number, end: number } | 'invalid' | undefined {
  if (header === null) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return undefined
  const [, first, last] = match
  if (first === '' && last === '') return undefined
  if (first === '') {
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid'
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1)
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  return { start, end }
}

/** The slice of the Host context this route touches. */
export type MediaRouteContext = RouteContext

/**
 * Stream `[start, start + length)` without buffering the complete file.
 * @param fs - Host filesystem service.
 * @param target - resolved filesystem target.
 * @param start - 0-based first byte.
 * @param length - byte count to send.
 * @param signal - request lifetime.
 * @returns the response body.
 */
function streamBytes(
  fs: HostFileSystem,
  target: unknown,
  start: number,
  length: number,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let offset = start
  let remaining = length
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        controller.close()
        return
      }
      const want = Math.min(CHUNK_BYTES, remaining)
      let bytes: Uint8Array
      try {
        bytes = await fs.readByteRange(target, { offset, length: want }, signal)
      } catch (error) {
        // A vanished client aborts the read; that is a clean end, not a fault.
        if (signal.aborted) {
          try {
            controller.close()
          } catch {
            /* stream already closed by the client */
          }
          return
        }
        controller.error(error)
        return
      }
      if (bytes.byteLength === 0) {
        controller.close()
        return
      }
      try {
        controller.enqueue(bytes)
      } catch {
        return
      }
      offset += bytes.byteLength
      remaining -= bytes.byteLength
    },
  })
}

function failure(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  FS_NOT_FOUND: 404,
  FS_NOT_REGULAR_FILE: 403,
  FS_PERMISSION_DENIED: 403,
  FS_SANDBOX_DENIED: 403,
  FS_ABORTED: 499,
}

/**
 * Serve one media file: metadata, HEAD, and byte ranges over a chunked stream.
 * @param request - authenticated Fetch request.
 * @param fs - Host filesystem service.
 * @returns the response.
 */
export async function serveMedia(request: Request, fs: HostFileSystem, secret?: Uint8Array): Promise<Response> {
  const url = new URL(request.url)
  // Mint a signed loopback URL for the page: the media element cannot send the
  // session cookie to 127.0.0.1 from a dsh-app:// page, so the URL is the
  // credential.
  if (url.searchParams.get('lan') === '1' && secret !== undefined) {
    const target = url.searchParams.get('path')
    if (target === null || target === '') return failure(400, 'missing path')
    if (!isAbsolute(target)) return failure(400, 'absolute path required')
    // No expiry on purpose: a playing element keeps issuing Range requests, so a
    // time-bounded URL would cut long playback off. The signature binds this one
    // path to the process secret instead.
    const signature = signLanPath(secret, target)
    const query = `path=${encodeURIComponent(target)}&sig=${encodeURIComponent(signature)}`
    const base = lanBaseUrl()
    if (base === '') return failure(503, 'loopback route unavailable')
    return Response.json({ url: `${base}${LAN_ROUTE_PATH}?${query}` }, { headers: BASE_HEADERS })
  }
  const path = url.searchParams.get('path')
  if (path === null || path.length === 0) return failure(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return failure(400, 'absolute path required')

  // Only accept a path the Host actually maps, and only when it round-trips to
  // the same location — an alias or symlink spelling is refused.
  const mapped = fs.processPathFromHostPath(path)
  if (mapped === undefined) return failure(422, 'unmapped host path')

  let target: unknown
  let info: Awaited<ReturnType<HostFileSystem['stat']>>
  try {
    target = await fs.resolve(mapped, { signal: request.signal })
    if (resolvePath(fs.processPath(target)) !== resolvePath(path)) {
      return failure(422, 'unmapped host path')
    }
    info = await fs.stat(target, request.signal)
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    if (code === undefined) throw error
    return failure(STATUS_BY_CODE[code] ?? 500, code)
  }
  if (info === undefined) return failure(404, 'not found')
  if (info.type !== 'file') return failure(403, 'not a regular file')

  const size = info.size ?? 0
  const type = mediaTypeOf(info.displayPath ?? path)
  const range = parseRange(request.headers.get('range'), size)
  const download = url.searchParams.get('download') === '1'

  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    'Accept-Ranges': 'bytes',
    'Content-Type': type,
  }
  if (download) {
    const name = basename(info.displayPath ?? path)
    const safe = name.replace(/["\\\r\n]/gu, '_')
    headers['Content-Disposition'] = `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`
  }

  if (range === 'invalid') {
    headers['Content-Range'] = `bytes */${String(size)}`
    return new Response(null, { status: 416, headers })
  }

  if (size === 0) {
    headers['Content-Length'] = '0'
    return new Response(null, { status: 200, headers })
  }

  // A download and a plain GET both answer the complete body; only a Range
  // request is partial. Answering a plain GET with 206 + Content-Range was
  // measured to leave Chromium's `seekable` empty in the desktop shell, so
  // announcing the length that way buys nothing.
  const partial = range !== undefined
  const window = range === undefined ? { start: 0, end: size - 1 } : range
  const length = window.end - window.start + 1
  if (partial) {
    headers['Content-Range'] = `bytes ${String(window.start)}-${String(window.end)}/${String(size)}`
  }
  headers['Content-Length'] = String(length)

  const status = partial ? 206 : 200
  if (request.method === 'HEAD') {
    return new Response(null, { status, headers })
  }
  return new Response(streamBytes(fs, target, window.start, length, request.signal), { status, headers })
}

/**
 * Claim the media route for the plugin lifetime.
 * @param ctx - Host context carrying `connection` and `fs`.
 */
export function registerMediaRoute(ctx: MediaRouteContext, secret?: Uint8Array): () => void {
  return ctx.connection.fetch.register({
    path: MEDIA_ROUTE_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: request => serveMedia(request, ctx.fs, secret),
  })
}

/**
 * Where the loopback asset route listens, so the client can address the lazy
 * chunk. Separate from the media route because it is a different question
 * ("where do I fetch plugin assets?") rather than a media request.
 */
export const ASSET_BASE_PATH = '/api/any-preview/asset-base'

/**
 * Answer with the loopback origin of the asset route.
 * @param ctx - Host context carrying `connection`.
 * @returns disposer for the route.
 */
export function registerAssetBaseRoute(ctx: MediaRouteContext): () => void {
  return ctx.connection.fetch.register({
    path: ASSET_BASE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json({ base: lanBaseUrl() }, { headers: BASE_HEADERS }),
  })
}
