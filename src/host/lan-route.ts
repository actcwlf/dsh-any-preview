/**
 * Loopback HTTP route for media, addressed by a signed URL.
 *
 * Why it exists: the desktop shell serves the page from `dsh-app://app` and
 * proxies `/api`; the proxy withholds `Content-Length`, and Chromium's media
 * loader then reports `seekable = [0, 0]` even when the response is a 206 with
 * a correct `Content-Range`. Loading the same bytes over real HTTP puts them on
 * Chromium's http media path, which understands range responses.
 *
 * The route lives outside `/api` on purpose: that prefix is fenced by the
 * session cookie, and a cross-site media request cannot send one.
 */
import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import { stat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { RouteContext } from './contracts.ts'
import { verifyLanPath } from './lan-url.ts'

/** Path the loopback route claims. */
export const LAN_ROUTE_PATH = '/any-preview/lan'

/** Fixed path of the module-loading probe. */
export const PROBE_ROUTE_PATH = '/any-preview/probe.js'

/**
 * Base URL of the loopback route, filled in when the route registers.
 *
 * The minting route cannot derive this from `request.url`: the authenticated
 * carrier reaches the Host under an internal name (`dsh.internal`), which the
 * page cannot resolve.
 */
let lanBase = ''

/** @returns `http://127.0.0.1:<port>`, or an empty string before registration. */
export function lanBaseUrl(): string {
  return lanBase
}

/** Read window while streaming. */
const CHUNK_BYTES = 1 << 20

/** The slice of the Host context this route needs. */
interface LanContext extends RouteContext {
  inject?(deps: readonly string[], callback: (scope: never) => void): unknown
}

/** The webserver service as this route uses it. */
interface WebServerLike {
  readonly port: number
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function header(res: ServerResponse, status: number, values: Record<string, string>): void {
  res.writeHead(status, values)
}

/**
 * Register the loopback route when the profile provides a web server.
 * @param ctx - Host context.
 * @param secret - per-process signing secret.
 * @returns disposer, or a no-op when no web server is available.
 */
export function registerLanRoute(ctx: LanContext, secret: Uint8Array): () => void {
  let dispose: (() => void) | undefined
  ctx.inject?.(['webServer'], (scope: never) => {
    const server = (scope as { webServer: WebServerLike }).webServer
    // The renderer can only reach the server over loopback.
    lanBase = `http://127.0.0.1:${String(server.port)}`
    dispose = server.register({
      kind: 'exact',
      path: LAN_ROUTE_PATH,
      handler: async (req, res) => { await handle(req, res, ctx, secret) },
    })
    // Module-loading probe: can a dsh-app:// page import() a module served
    // over loopback HTTP? The answer decides whether three can be split out.
    const probeDispose = server.register({
      kind: 'exact',
      path: PROBE_ROUTE_PATH,
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        res.end('export const ok = 1;\nexport const kind = "module-probe";\n')
      },
    })
    // The lazy three.js chunk: a fixed package file, no user input, so it needs
    // no signature. Size is not the constraint; startup time is.
    const chunkDispose = server.register({
      kind: 'exact',
      path: '/any-preview/asset/three-chunk.js',
      handler: (req, res) => { void serveChunk(res) },
    })
    const disposePair = dispose
    dispose = () => { disposePair?.(); probeDispose(); chunkDispose() }
  })
  return () => { dispose?.() }
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: LanContext, secret: Uint8Array): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.searchParams.get('path') ?? ''
  const signature = url.searchParams.get('sig') ?? ''

  // A cross-site media element still needs the response to be readable.
  const cors: Record<string, string> = {
    // Echo only the shell's own origin; other callers get no CORS grant.
    'Access-Control-Allow-Origin': allowedOrigin(req),
    'Access-Control-Allow-Private-Network': 'true',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  }

  if (req.method === 'OPTIONS') {
    header(res, 204, { ...cors, 'Access-Control-Allow-Headers': 'range', 'Access-Control-Allow-Methods': 'GET, HEAD' })
    res.end()
    return
  }
  if (!verifyLanPath(secret, path, signature)) {
    header(res, 403, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('invalid or expired signature')
    return
  }

  let size: number
  try {
    const target = await ctx.fs.resolve(path, { signal: AbortSignal.timeout(5000) })
    const info = await ctx.fs.stat(target, AbortSignal.timeout(5000))
    if (info === undefined || info.type !== 'file' || info.size === undefined) {
      header(res, 404, cors)
      res.end()
      return
    }
    size = info.size
  } catch {
    header(res, 404, cors)
    res.end()
    return
  }

  const type = mediaTypeOf(basename(path))
  if (!(basename(path).slice(basename(path).lastIndexOf('.') + 1).toLowerCase() in TYPES)) {
    header(res, 415, cors)
    res.end()
    return
  }
  const rawRange = req.headers.range
  const rangeHeader = typeof rawRange === 'string' ? rawRange : undefined
  const match = rangeHeader === undefined ? null : /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim())
  const start = match === null || match[1] === '' ? 0 : Number(match[1])
  const end = match === null || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    header(res, 416, { ...cors, 'Content-Range': `bytes */${String(size)}` })
    res.end()
    return
  }

  const length = end - start + 1
  header(res, 206, {
    ...cors,
    'Content-Type': type,
    'Content-Range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
    'Content-Length': String(length),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }

  const target = await ctx.fs.resolve(path, { signal: AbortSignal.timeout(5000) })
  let offset = start
  while (offset <= end) {
    const want = Math.min(CHUNK_BYTES, end - offset + 1)
    const bytes = await ctx.fs.readByteRange(target, { offset, length: want }, AbortSignal.timeout(15000))
    if (!res.write(Buffer.from(bytes))) await once(res, 'drain')
    offset += bytes.length
    if (bytes.length === 0) break
  }
  res.end()
}

/**
 * Serve the packaged 3D chunk from `lib/`.
 * @param res - response to write.
 */
async function serveChunk(res: ServerResponse): Promise<void> {
  try {
    const file = fileURLToPath(new URL('./three-chunk.js', import.meta.url))
    const bytes = await readFile(file)
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Length': String(bytes.length),
    })
    res.end(bytes)
  } catch {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
    res.end()
  }
}

/**
 * CORS grant for the shell's own origin only.
 * @param req - incoming request.
 * @returns the origin to echo, or an empty string for no grant.
 */
function allowedOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin
  return origin === 'dsh-app://app' ? origin : ''
}

/** Media type by suffix, matching the `/api` route. */
function mediaTypeOf(name: string): string {
  const suffix = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return TYPES[suffix] ?? 'application/octet-stream'
}

const TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  ogv: 'video/ogg', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mpg: 'video/mpeg',
  mpeg: 'video/mpeg', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm',
}
