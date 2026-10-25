/**
 * SQLite schema reader.
 *
 * Only the schema is read: the file header, then the b-tree pages holding
 * `sqlite_master`. Table contents are deliberately not decoded — that turns a
 * preview into a database browser, with all the page-overflow and encoding
 * corner cases that implies.
 */
import { LIMITS } from '../../../shared/limits.ts'

/** File header facts worth showing. */
export interface SqliteHeader {
  readonly pageSize: number
  readonly pageCount: number
  readonly encoding: string
}

/** One schema object (`sqlite_master` row). */
export interface SqliteObject {
  readonly type: string
  readonly name: string
  readonly table: string
  readonly rootPage: number
  readonly sql: string
}

/** Pages walked before giving up; a schema this big is pathological. */
export const MAX_SCHEMA_PAGES = LIMITS.sqlitePages

/** Objects listed. */
export const MAX_OBJECTS = LIMITS.sqliteObjects

/**
 * Whether the head bytes carry the SQLite magic.
 * @param bytes - at least 16 bytes from the start of the file.
 */
export function isSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false
  return new TextDecoder('latin1').decode(bytes.subarray(0, 16)).startsWith('SQLite format 3\0')
}

/**
 * Read the file header.
 * @param bytes - the first bytes of the file (100 is enough).
 * @returns page geometry and text encoding, or undefined when too short.
 */
export function parseSqliteHeader(bytes: Uint8Array): SqliteHeader | undefined {
  if (bytes.length < 100) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rawPageSize = view.getUint16(16, false)
  const pageSize = rawPageSize === 1 ? 65_536 : rawPageSize
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) return undefined
  const pageCount = view.getUint32(28, false)
  const encodingId = view.getUint32(56, false)
  const encoding = encodingId === 2 ? 'UTF-16LE' : encodingId === 3 ? 'UTF-16BE' : 'UTF-8'
  return { pageSize, pageCount, encoding }
}

interface Varint {
  readonly value: number
  readonly next: number
}

/**
 * Decode a SQLite variable-length integer.
 * @param bytes - buffer.
 * @param offset - start position.
 * @returns the value and the next position, or undefined past the end.
 */
export function readVarint(bytes: Uint8Array, offset: number): Varint | undefined {
  let value = 0
  for (let index = 0; index < 9; index += 1) {
    const byte = bytes[offset + index]
    if (byte === undefined) return undefined
    if (index === 8) return { value: value * 256 + byte, next: offset + 9 }
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 }
  }
  return undefined
}

function readInteger(bytes: Uint8Array, offset: number, size: number): number {
  let value = 0
  for (let index = 0; index < size; index += 1) value = value * 256 + (bytes[offset + index] ?? 0)
  const span = 2 ** (size * 8)
  return value >= span / 2 ? value - span : value
}

/**
 * Decode one record payload (header of serial types, then the values).
 * @param payload - record bytes.
 * @returns cell values, or undefined when the header is malformed.
 */
export function decodeRecord(payload: Uint8Array): (string | number | null)[] | undefined {
  const header = readVarint(payload, 0)
  if (header === undefined || header.value > payload.length) return undefined
  const types: number[] = []
  let at = header.next
  while (at < header.value) {
    const type = readVarint(payload, at)
    if (type === undefined) return undefined
    types.push(type.value)
    at = type.next
  }

  const values: (string | number | null)[] = []
  let data = header.value
  for (const type of types) {
    if (type === 0) {
      values.push(null)
      continue
    }
    if (type >= 1 && type <= 6) {
      const size = [1, 2, 3, 4, 6, 8][type - 1]!
      values.push(readInteger(payload, data, size))
      data += size
      continue
    }
    if (type === 7) {
      if (data + 8 > payload.length) return undefined
      values.push(new DataView(payload.buffer, payload.byteOffset + data, 8).getFloat64(0, false))
      data += 8
      continue
    }
    if (type === 8 || type === 9) {
      values.push(type === 8 ? 0 : 1)
      continue
    }
    if (type >= 12) {
      const length = Math.floor((type - 12) / 2)
      const isText = type % 2 === 1
      const slice = payload.subarray(data, Math.min(payload.length, data + length))
      values.push(isText ? new TextDecoder('utf-8', { fatal: false }).decode(slice) : `<blob ${String(length)} 字节>`)
      data += length
      continue
    }
    return undefined
  }
  return values
}

/** What one b-tree page contributes. */
export interface TablePage {
  readonly rows: readonly (string | number | null)[][]
  readonly children: readonly number[]
}

/**
 * Decode the cells of one table b-tree page.
 * @param page - the page bytes.
 * @param pageNumber - 1-based page number (page 1 carries the file header).
 * @returns decoded cells and, for interior pages, the child page numbers.
 */
export function decodeTablePage(page: Uint8Array, pageNumber: number): TablePage {
  const base = pageNumber === 1 ? 100 : 0
  const kind = page[base]
  if (kind !== 0x0d && kind !== 0x05) return { rows: [], children: [] }
  const cellCount = ((page[base + 3] ?? 0) << 8) | (page[base + 4] ?? 0)
  const pointerBase = base + (kind === 0x05 ? 12 : 8)
  const children: number[] = []
  if (kind === 0x05) {
    const rightMost = ((page[base + 8] ?? 0) << 24) | ((page[base + 9] ?? 0) << 16) | ((page[base + 10] ?? 0) << 8) | (page[base + 11] ?? 0)
    children.push(rightMost)
  }

  const rows: (string | number | null)[][] = []
  for (let index = 0; index < cellCount; index += 1) {
    const pointerOffset = pointerBase + index * 2
    const pointer = ((page[pointerOffset] ?? 0) << 8) | (page[pointerOffset + 1] ?? 0)
    if (kind === 0x05) {
      const child = ((page[pointer] ?? 0) << 24) | ((page[pointer + 1] ?? 0) << 16) | ((page[pointer + 2] ?? 0) << 8) | (page[pointer + 3] ?? 0)
      children.push(child)
      continue
    }
    const payloadLength = readVarint(page, pointer)
    if (payloadLength === undefined) continue
    const rowid = readVarint(page, payloadLength.next)
    if (rowid === undefined) continue
    const available = Math.min(payloadLength.value, page.length - rowid.next)
    const record = decodeRecord(page.subarray(rowid.next, rowid.next + available))
    if (record !== undefined) rows.push(record)
  }
  return { rows, children }
}

/**
 * Turn a `sqlite_master` cell into a schema object.
 * @param row - decoded cell.
 * @returns the object, or undefined for rows that are not schema entries.
 */
export function toSchemaObject(row: readonly (string | number | null)[]): SqliteObject | undefined {
  const [type, name, table, rootPage, sql] = row
  if (typeof type !== 'string' || typeof name !== 'string') return undefined
  if (!['table', 'index', 'view', 'trigger'].includes(type)) return undefined
  return {
    type,
    name,
    table: typeof table === 'string' ? table : '',
    rootPage: typeof rootPage === 'number' ? rootPage : 0,
    sql: typeof sql === 'string' ? sql : '',
  }
}

/** How the walker reaches pages: ranged reads in the viewer, a buffer in tests. */
export interface SchemaSource {
  readonly header: SqliteHeader
  readPage(pageNumber: number): Uint8Array | Promise<Uint8Array>
}

/** What a schema walk produced. */
export interface SchemaResult {
  readonly objects: readonly SqliteObject[]
  readonly pages: number
  readonly truncated: boolean
}

/**
 * Walk the b-tree pages holding `sqlite_master` and collect the schema objects.
 * @param source - page access plus the parsed header.
 * @returns the objects found, and whether a cap stopped the walk.
 */
export async function collectSchema(source: SchemaSource): Promise<SchemaResult> {
  const objects: SqliteObject[] = []
  const queue: number[] = [1]
  const seen = new Set<number>([1])
  let pages = 0
  let truncated = false

  while (queue.length > 0) {
    if (pages >= MAX_SCHEMA_PAGES || objects.length >= MAX_OBJECTS) {
      truncated = true
      break
    }
    const pageNumber = queue.shift()!
    pages += 1
    const page = await source.readPage(pageNumber)
    const decoded = decodeTablePage(page, pageNumber)
    for (const row of decoded.rows) {
      const object = toSchemaObject(row)
      if (object !== undefined && objects.length < MAX_OBJECTS) objects.push(object)
    }
    for (const child of decoded.children) {
      if (child > 0 && !seen.has(child)) {
        seen.add(child)
        queue.push(child)
      }
    }
  }

  return { objects, pages, truncated }
}
