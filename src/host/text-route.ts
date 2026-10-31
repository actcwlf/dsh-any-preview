/**
 * Text slices for renderers that page through a large file themselves.
 *
 * The document owner hands text over in order and keeps it as one contiguous
 * prefix, so "show me row 200,000" has no answer: page N cannot be read without
 * every page before it. This route answers a byte window instead — the file is
 * seekable, and a caller that counts newlines can turn windows into rows in any
 * order. Windows are aligned to whole lines and decoded here, so the client never
 * has to reason about UTF-8 boundaries.
 */
import type { HostFileSystem, RouteContext } from './contracts.ts'
import { ROUTE_HEADERS, failure, failureFrom, resolveHostFile } from './file-target.ts'
import type { HostFile } from './file-target.ts'

/** Exact pathname claimed on the shared `/api` Fetch channel. */
export const TEXT_ROUTE_PATH = '/api/any-preview/text'

/** Bytes one slice returns when the caller does not ask; the client pages onward. */
export const TEXT_SLICE_BYTES = 1024 * 1024

/** Largest window one request may read. */
export const TEXT_MAX_SLICE_BYTES = 4 * 1024 * 1024

/** Newline byte; row boundaries are found in bytes so decoding stays aligned. */
const NEWLINE = 0x0a

/** One line-aligned, decoded slice of a text file. */
export interface TextSlice {
  /** Whole lines, the last one open only at end of file. */
  readonly text: string
  /** Byte offset of `text[0]`; a row starts here, or it is the start of the file. */
  readonly start: number
  /** Byte offset just past `text`; the next read starts here. */
  readonly end: number
  /** Bytes in the file. */
  readonly size: number
  /** True when this slice reached the end of the file. */
  readonly eof: boolean
}

/**
 * Cut a decoded, line-aligned slice out of one byte window.
 *
 * A window that starts mid-line drops that line (its beginning is elsewhere); a
 * caller that knows the window starts on a row boundary says so with `rowStart`,
 * which is what every follow-up read of an index does. A window that ends
 * mid-line drops the fragment unless it ends the file, where the fragment is the
 * last row. Boundaries are found in bytes, so a multi-byte character is never
 * split.
 * @param bytes - the raw window, starting at `offset`.
 * @param offset - byte offset of `bytes[0]` in the file.
 * @param size - bytes in the file.
 * @param rowStart - true when `offset` is known to begin a row.
 */
export function alignTextSlice(bytes: Uint8Array, offset: number, size: number, rowStart = false): TextSlice {
  const eof = offset + bytes.length >= size
  if (bytes.length === 0) return { text: '', start: Math.min(offset, size), end: Math.min(offset, size), size, eof }
  const first = bytes.indexOf(NEWLINE)
  const last = bytes.lastIndexOf(NEWLINE)
  // Only a window that begins at row 0 or says so keeps a leading partial line.
  const from = offset === 0 || rowStart ? 0 : first === -1 ? -1 : first + 1
  if (from === -1) return { text: '', start: offset, end: offset, size, eof }
  const to = eof ? bytes.length : last >= from ? last + 1 : -1
  if (to === -1) return { text: '', start: offset + from, end: offset + from, size, eof }
  return {
    text: new TextDecoder().decode(bytes.subarray(from, to)),
    start: offset + from,
    end: offset + to,
    size,
    eof: offset + to >= size,
  }
}

/**
 * Read one non-negative integer query parameter.
 * @param value - raw value, or null when absent.
 * @param fallback - value to use when absent.
 * @returns the number, or undefined when malformed.
 */
function intParam(value: string | null, fallback: number): number | undefined {
  if (value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Serve one line-aligned text slice.
 * @param request - authenticated Fetch request carrying `path`, `offset`, `length`,
 *   and `rowStart=1` when the offset is known to begin a row.
 * @param fs - Host filesystem service.
 * @returns JSON `TextSlice`.
 */
export async function serveText(request: Request, fs: HostFileSystem): Promise<Response> {
  const url = new URL(request.url)
  const path = url.searchParams.get('path') ?? ''
  if (path.length === 0) return failure(400, 'missing path')
  const offset = intParam(url.searchParams.get('offset'), 0)
  const length = intParam(url.searchParams.get('length'), TEXT_SLICE_BYTES)
  if (offset === undefined) return failure(400, 'offset must be a non-negative integer')
  if (length === undefined || length < 1 || length > TEXT_MAX_SLICE_BYTES) {
    return failure(400, `length must be 1..${String(TEXT_MAX_SLICE_BYTES)}`)
  }

  let file: HostFile | Response
  try {
    file = await resolveHostFile(fs, path, request.signal)
  } catch (error) {
    return failureFrom(error)
  }
  if (file instanceof Response) return file

  const { size } = file
  if (offset >= size) {
    const end = { text: '', start: size, end: size, size, eof: true }
    return Response.json(end, { headers: ROUTE_HEADERS })
  }

  let bytes: Uint8Array
  try {
    bytes = await fs.readByteRange(file.target, { offset, length: Math.min(length, size - offset) }, request.signal)
  } catch (error) {
    return failureFrom(error)
  }
  const rowStart = url.searchParams.get('rowStart') === '1'
  return Response.json(alignTextSlice(bytes, offset, size, rowStart), { headers: ROUTE_HEADERS })
}

/**
 * Claim the text route for the plugin lifetime.
 * @param ctx - Host context carrying `connection` and `fs`.
 * @returns disposer for the route.
 */
export function registerTextRoute(ctx: RouteContext): () => void {
  return ctx.connection.fetch.register({
    path: TEXT_ROUTE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => serveText(request, ctx.fs),
  })
}
