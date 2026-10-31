/**
 * `preview_inspect`: answer "what is in this file" without reading its bytes.
 *
 * The output is an envelope shared by every format: one summary line, a few facts,
 * an optional schema, warnings, and concrete next steps. `read` and `grep` already
 * give content and matches; this tool exists to make the first decision cheap
 * (can I work with this file, and how) instead of dumping data.
 *
 * Scope: workspace files, read through the same fs service the previews use. The
 * read itself is not fenced to the workspace — see docs/security-notes.md.
 */
import { extname, isAbsolute, join } from 'node:path'
import type { HostFileSystem, RouteContext } from './contracts.ts'
import { looksLikeGguf, parseGguf } from '../client/previews/gguf/parse.ts'
import { parseNotebook } from '../client/previews/ipynb/parse.ts'
import { parseHeaderJson, readHeaderLength } from '../client/previews/safetensors/parse.ts'
import { collectSchema, parseSqliteHeader } from '../client/previews/sqlite/parse.ts'
import { parseRst } from '../shared/inspect/rst.ts'
import { isEncodedHeader, parseEncodedHeader, parseHeader, readLayout } from '../shared/sevenzip/structure.ts'
import { decodeFolder } from '../shared/sevenzip/decode.ts'
import type { Decoder } from '../shared/sevenzip/decode.ts'
import { outlineOf } from '../shared/inspect/document.ts'
import { findEocd, parseZipDirectory, u16, u32 } from '../shared/zip/parse.ts'

/** Header window for binary formats. */
const HEAD_BYTES = 4 * 1024 * 1024

/** Text window for delimited files. */
const TEXT_BYTES = 1 * 1024 * 1024

/** How many keys, tensors, columns or rows a summary may name. */
const MAX_ITEMS = 20

/** Parameters: object root, closed, no required on the scalar. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'Absolute path of the file to inspect.' },
  },
} as const

/** Output: object root, closed; lists are strings so the schema stays flat. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    summary: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    schema: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    next: { type: 'array', items: { type: 'string' } },
    truncated: { type: 'boolean' },
  },
} as const

/** One inspection result. */
interface InspectResult {
  kind: string
  summary: string
  facts: string[]
  schema: string[]
  notes: string[]
  next: string[]
  truncated: boolean
}

/** The `tools` service as this tool uses it. */
interface ToolsLike {
  register(tool: unknown): () => void
}

/** The sandbox policy service: it resolves the workspace root per session. */
interface SandboxPolicyLike {
  resolve(input: { session?: unknown }): { workspaceRoot?: string, root?: string }
}

/** Context with the optional injects used to reach `tools` and `sandboxPolicy`. */
interface InspectContext extends RouteContext {
  fs: HostFileSystem
  inject?(deps: readonly string[], callback: (scope: never) => void): unknown
}

/** Describe a GGUF header. */
function inspectGguf(bytes: Uint8Array): InspectResult {
  const header = parseGguf(bytes)
  const kv = header.kv ?? []
  const tensors = header.tensors ?? []
  const find = (key: string): string => {
    const hit = kv.find(entry => entry.key === key)
    return hit === undefined ? '' : String(hit.value)
  }
  const architecture = find('general.architecture')
  const context = find(`${architecture}.context_length`)

  const summary = [
    `GGUF v${String(header.version)}`,
    `${tensors.length.toLocaleString('en-US')} tensors`,
    architecture,
  ].filter(part => part !== '').join(' · ')

  const facts = kv.slice(0, MAX_ITEMS).map(entry => `${entry.key} = ${String(entry.value)}`)
  const schema = tensors.slice(0, MAX_ITEMS).map(
    tensor => `${tensor.name}: ${tensor.type} [${tensor.dims.join('×')}] ${tensor.params.toLocaleString('en-US')} params`,
  )

  const notes: string[] = []
  if (kv.length > MAX_ITEMS) notes.push(`${kv.length.toLocaleString('en-US')} metadata keys, first ${String(MAX_ITEMS)} shown`)
  if (tensors.length > MAX_ITEMS) notes.push(`${tensors.length.toLocaleString('en-US')} tensors, first ${String(MAX_ITEMS)} shown`)
  if (context !== '') notes.push(`context length ${context}`)

  return {
    kind: 'gguf',
    summary,
    facts,
    schema,
    notes,
    next: ['grep(pattern="…") 在文件其它部分定位（GGUF 主体是二进制，仅元数据可读）'],
    truncated: kv.length > MAX_ITEMS || tensors.length > MAX_ITEMS,
  }
}

/** Pick the delimiter that appears most on the first line. */
function detectDelimiter(line: string): string {
  const candidates = [',', '\t', ';', '|']
  let best = ','
  let bestCount = 0
  for (const candidate of candidates) {
    const count = line.split(candidate).length - 1
    if (count > bestCount) { best = candidate; bestCount = count }
  }
  return best
}

/** Infer a column type from a handful of values; deliberately coarse. */
function inferType(values: readonly string[]): string {
  const sample = values.filter(value => value !== '')
  if (sample.length === 0) return 'empty'
  if (sample.every(value => /^[-+]?\d+$/u.test(value))) return 'integer'
  if (sample.every(value => /^[-+]?\d*\.\d+(?:[eE][-+]?\d+)?$/u.test(value))) return 'number'
  if (sample.every(value => /^(?:true|false)$/iu.test(value))) return 'boolean'
  return 'string'
}

/** Describe a delimited text file from its first bytes. */
function inspectCsv(bytes: Uint8Array, truncatedRead: boolean, size: number): InspectResult {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const lines = text.split(/\r?\n/u).filter(line => line !== '')
  if (lines.length === 0) throw new Error('file is empty')

  const first = lines[0] ?? ''
  const delimiter = detectDelimiter(first)
  const columns = first.split(delimiter)
  const dataRows = lines.slice(1)

  const schema = columns.slice(0, MAX_ITEMS).map((column, index) => {
    const values = dataRows.slice(0, 20).map(row => row.split(delimiter)[index] ?? '')
    return `${column === '' ? `column_${String(index + 1)}` : column}: ${inferType(values)}`
  })

  const notes: string[] = []
  const ragged = dataRows.slice(0, 50).filter(row => row.split(delimiter).length !== columns.length).length
  if (ragged > 0) notes.push(`${String(ragged)} of the first 50 rows have a different column count`)
  if (text.includes('"\n') || text.includes('"\r\n')) notes.push('quoted fields contain newlines; a line is not a row')
  if (truncatedRead) notes.push('only the first 1 MB was read')
  if (size > 0) notes.push(`file size ${(size / 1024 / 1024).toFixed(2)} MB`)

  return {
    kind: 'csv',
    summary: `delimited text · ${String(columns.length)} columns · delimiter ${JSON.stringify(delimiter === '\t' ? 'tab' : delimiter)}`,
    facts: [
      `delimiter: ${delimiter === '\t' ? 'tab' : delimiter}`,
      `columns: ${String(columns.length)}`,
      `header: ${columns.slice(0, MAX_ITEMS).join(' | ')}`,
    ],
    schema,
    notes,
    next: [
      'read(offset=1, limit=50) 查看表头与首批数据',
      'grep(pattern="…") 按内容定位行',
    ],
    truncated: truncatedRead,
  }
}

/** A reader over one file's bytes, supplied by the caller. */
type Reader = (offset: number, length: number) => Promise<Uint8Array>

/** Describe a line-delimited JSON file from its first bytes. */
function inspectJsonl(bytes: Uint8Array, truncatedRead: boolean): InspectResult {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '')
  if (lines.length === 0) throw new Error('file is empty')

  const counts = new Map<string, number>()
  let objects = 0
  let invalid = 0
  for (const line of lines.slice(0, 500)) {
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        objects += 1
        for (const key of Object.keys(value as Record<string, unknown>)) {
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      } else {
        invalid += 1
      }
    } catch {
      invalid += 1
    }
  }

  const sampled = Math.min(lines.length, 500)
  const fields = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ITEMS)
  const notes: string[] = []
  if (invalid > 0) notes.push(`${String(invalid)} of the first ${String(sampled)} lines are not JSON objects`)
  if (sampled < lines.length) notes.push(`only the first ${String(sampled)} lines were sampled`)
  if (truncatedRead) notes.push('only the first 1 MB was read')

  return {
    kind: 'jsonl',
    summary: `JSONL · ${String(objects)} objects sampled · ${String(fields.length)} distinct fields`,
    facts: [
      `sampled lines: ${String(sampled)}`,
      `objects: ${String(objects)}`,
      `invalid lines: ${String(invalid)}`,
    ],
    schema: fields.map(([key, count]) => `${key}: present in ${String(count)}/${String(objects)} objects`),
    notes,
    next: ['read(offset=1, limit=20) 查看原始记录', 'grep(pattern="…") 按字段值定位'],
    truncated: truncatedRead || sampled < lines.length,
  }
}

/** Describe a zip archive from its tail and central directory. */
async function inspectZip(size: number, read: Reader): Promise<InspectResult> {
  const tailLength = Math.min(size, 66_000)
  const tail = await read(size - tailLength, tailLength)
  const eocd = findEocd(tail)
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record')

  const entries = u16(tail, eocd + 10)
  const directorySize = u32(tail, eocd + 12)
  const directoryOffset = u32(tail, eocd + 16)
  if (directorySize === 0 || directoryOffset === 0) throw new Error('zip: empty central directory')

  const directory = await read(directoryOffset, directorySize)
  const listed = parseZipDirectory(directory)
  const files = listed.filter(entry => !entry.directory)
  const totalSize = files.reduce((sum, entry) => sum + entry.size, 0)
  const totalCompressed = files.reduce((sum, entry) => sum + entry.compressedSize, 0)

  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 5)
  const notes: string[] = []
  if (entries > listed.length) notes.push(`central directory lists ${String(listed.length)} of ${String(entries)} entries`)
  if (totalSize > 0) notes.push(`compressed ${(totalCompressed / 1024 / 1024).toFixed(2)} MB into ${(totalSize / 1024 / 1024).toFixed(2)} MB`)

  return {
    kind: 'zip',
    summary: `ZIP · ${String(files.length)} files · ${(totalSize / 1024 / 1024).toFixed(2)} MB uncompressed`,
    facts: [
      `entries: ${String(listed.length)}`,
      `files: ${String(files.length)}`,
      `directories: ${String(listed.length - files.length)}`,
      `uncompressed total: ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
    ],
    schema: largest.map(entry => `${entry.name}: ${(entry.size / 1024).toFixed(0)} KB`),
    notes,
    next: ['在面板中打开压缩包可直接列出条目', '若需按扩展名预览某个条目，先解压到工作区'],
    truncated: listed.length < entries,
  }
}

/** Describe a SQLite database from its header and schema table. */
async function inspectSqlite(read: Reader): Promise<InspectResult> {
  const header = parseSqliteHeader(await read(0, 100))
  if (header === undefined) throw new Error('not a SQLite database (magic mismatch)')

  const schema = await collectSchema({
    header,
    readPage: pageNumber => read((pageNumber - 1) * header.pageSize, header.pageSize),
  })

  const objects = schema.objects
  const tables = objects.filter(object => object.type === 'table')
  const indexes = objects.filter(object => object.type === 'index')
  const views = objects.filter(object => object.type === 'view')

  return {
    kind: 'sqlite',
    summary: `SQLite · ${String(tables.length)} tables · ${String(indexes.length)} indexes`,
    facts: [
      `tables: ${String(tables.length)}`,
      `indexes: ${String(indexes.length)}`,
      `views: ${String(views.length)}`,
      `triggers: ${String(objects.filter(object => object.type === 'trigger').length)}`,
    ],
    schema: objects.slice(0, MAX_ITEMS).map(object => `${object.type} ${object.name}: ${object.sql ?? ''}`.trim()),
    notes: objects.length > MAX_ITEMS ? [`${String(objects.length)} objects, first ${String(MAX_ITEMS)} shown`] : [],
    next: ['在面板中打开数据库可看到每个对象完整的 CREATE 语句'],
    truncated: schema.truncated || objects.length > MAX_ITEMS,
  }
}
/** Describe a safetensors header (8-byte length prefix plus JSON). */
async function inspectSafetensors(size: number, read: Reader): Promise<InspectResult> {
  const prefix = await read(0, 8)
  const headerLength = readHeaderLength(prefix)
  if (headerLength === undefined) throw new Error('not a safetensors file (length prefix missing)')
  const bytes = await read(8, Math.min(headerLength, size - 8))
  const header = parseHeaderJson(new TextDecoder().decode(bytes), headerLength)
  const dtypes = header.dtypes.map(([dtype, count]) => `${dtype}: ${String(count)}`)

  return {
    kind: 'safetensors',
    summary: `safetensors · ${String(header.tensors.length)} tensors · ${header.totalParams.toLocaleString('en-US')} params`,
    facts: [
      `tensors: ${String(header.tensors.length)}`,
      `parameters: ${header.totalParams.toLocaleString('en-US')}`,
      `header bytes: ${String(headerLength)}`,
      `metadata keys: ${String(header.metadata.length)}`,
    ],
    schema: header.tensors.slice(0, MAX_ITEMS).map(
      tensor => `${tensor.name}: ${tensor.dtype} [${tensor.shape.join('×')}] ${tensor.params.toLocaleString('en-US')}`,
    ),
    notes: dtypes.slice(0, 5),
    next: ['在面板中打开可看到完整张量表与 dtype 分布'],
    truncated: header.tensors.length > MAX_ITEMS,
  }
}

/** Describe a reStructuredText document by its outline. */
function inspectRst(bytes: Uint8Array, truncatedRead: boolean): InspectResult {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const blocks = parseRst(text)
  const { headings, counts } = outlineOf(blocks)

  return {
    kind: 'rst',
    summary: `reST · ${String(headings.length)} headings · ${String(counts.paragraph ?? 0)} paragraphs`,
    facts: [
      `headings: ${String(headings.length)}`,
      `paragraphs: ${String(counts.paragraph ?? 0)}`,
      `literal blocks: ${String(counts.code ?? 0)}`,
      `tables: ${String(counts.table ?? 0)}`,
      `lists: ${String(counts.list ?? 0)}`,
    ],
    schema: headings.slice(0, MAX_ITEMS).map(heading => `${'  '.repeat(Math.max(0, heading.level - 1))}${heading.text}`),
    notes: [
      ...(truncatedRead ? ['only the first 2 MB was read'] : []),
      ...(headings.length > MAX_ITEMS ? [`${String(headings.length)} headings, first ${String(MAX_ITEMS)} shown`] : []),
    ],
    next: ['在面板中打开可按章节阅读', 'grep(pattern="…") 定位具体段落'],
    truncated: truncatedRead || headings.length > MAX_ITEMS,
  }
}

/** Describe a notebook by its cells, not their content. */
function inspectNotebook(bytes: Uint8Array): InspectResult {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  const notebook = parseNotebook(parsed)
  const markdown = notebook.cells.filter(cell => cell.kind === 'markdown').length
  const code = notebook.cells.filter(cell => cell.kind === 'code').length
  const withOutput = notebook.cells.filter(cell => (cell.outputs ?? []).length > 0).length

  return {
    kind: 'ipynb',
    summary: `notebook · ${String(notebook.cells.length)} cells · ${String(code)} code`,
    facts: [
      `cells: ${String(notebook.cells.length)}`,
      `markdown: ${String(markdown)}`,
      `code: ${String(code)}`,
      `cells with output: ${String(withOutput)}`,
    ],
    schema: notebook.cells.slice(0, MAX_ITEMS).map((cell, index) => `#${String(index + 1)} ${cell.kind}: ${(cell.source ?? '').split('\n')[0]?.slice(0, 80) ?? ''}`),
    notes: notebook.cells.length > MAX_ITEMS ? [`${String(notebook.cells.length)} cells, first ${String(MAX_ITEMS)} shown`] : [],
    next: ['在面板中打开可逐单元格阅读'],
    truncated: notebook.cells.length > MAX_ITEMS,
  }
}

/** Describe an EPUB by its archive shape (entries, not rendered text). */
async function inspectEpub(size: number, read: Reader): Promise<InspectResult> {
  const tailLength = Math.min(size, 66_000)
  const tail = await read(size - tailLength, tailLength)
  const eocd = findEocd(tail)
  if (eocd < 0) throw new Error('epub: no end-of-central-directory record')
  const directorySize = u32(tail, eocd + 12)
  const directoryOffset = u32(tail, eocd + 16)
  const entries = parseZipDirectory(await read(directoryOffset, directorySize))

  const names = entries.map(entry => entry.name)
  const xhtml = names.filter(name => /\.x?html?$/iu.test(name)).length
  const images = names.filter(name => /\.(?:png|jpe?g|gif|svg|webp)$/iu.test(name)).length
  const styles = names.filter(name => /\.css$/iu.test(name)).length
  const hasContainer = names.some(name => name === 'META-INF/container.xml')
  const opf = names.find(name => name.endsWith('.opf')) ?? ''

  return {
    kind: 'epub',
    summary: `EPUB · ${String(xhtml)} chapters · ${String(images)} images`,
    facts: [
      `entries: ${String(entries.length)}`,
      `chapters (html): ${String(xhtml)}`,
      `images: ${String(images)}`,
      `stylesheets: ${String(styles)}`,
      `package document: ${opf === '' ? 'missing' : opf}`,
    ],
    schema: names.slice(0, MAX_ITEMS),
    notes: hasContainer ? [] : ['META-INF/container.xml is missing; the book may not open'],
    next: ['在面板中打开可按章节阅读'],
    truncated: entries.length > MAX_ITEMS,
  }
}
/** Load lib/lzma.wasm once, for archives whose header is compressed. */
let cachedDecoder: Promise<Decoder> | undefined
async function sevenZipDecoder(): Promise<Decoder> {
  cachedDecoder ??= (async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const path = fileURLToPath(new URL('../../lib/lzma.wasm', import.meta.url))
    const module = await WebAssembly.compile(await readFile(path))
    const instance = await WebAssembly.instantiate(module, {})
    return instance.exports as unknown as Decoder
  })()
  return cachedDecoder
}

/** Describe a 7z archive: entries, sizes, and whether it can be opened. */
async function inspectSevenZip(read: Reader): Promise<InspectResult> {
  const layout = readLayout(await read(0, 32))
  if (layout === undefined) throw new Error('not a 7z archive (signature mismatch)')

  let header = await read(32 + layout.nextHeaderOffset, layout.nextHeaderSize)
  if (isEncodedHeader(header)) {
    const streams = parseEncodedHeader(header)
    const folder = streams?.folders[0]
    const stream = streams?.packStreams[0]
    if (streams === undefined || folder === undefined || stream === undefined) {
      throw new Error('7z: encoded header is incomplete')
    }
    const bytes = await read(32 + stream.offset, stream.size)
    header = decodeFolder(await sevenZipDecoder(), folder, [bytes])
  }

  const archive = parseHeader(header)
  if (archive === undefined) throw new Error('7z: header could not be parsed')

  const files = archive.entries.filter(entry => !entry.directory)
  const total = files.reduce((sum, entry) => sum + entry.size, 0)
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, MAX_ITEMS)
  const encrypted = archive.encrypted
  const solid = archive.solid

  const notes: string[] = []
  if (solid) notes.push('solid: entries share a folder, so opening one decodes all of them')
  if (encrypted) notes.push('encrypted: AES-256 folders cannot be decoded without a password')
  if (files.length > MAX_ITEMS) notes.push(`${String(files.length)} files, ${String(MAX_ITEMS)} listed`)

  return {
    kind: '7z',
    summary: `7z · ${String(files.length)} files · ${(total / 1024).toFixed(1)} KB uncompressed${solid ? ' · solid' : ''}`,
    facts: [
      `files: ${String(files.length)}`,
      `directories: ${String(archive.entries.length - files.length)}`,
      `uncompressed total: ${(total / 1024).toFixed(1)} KB`,
      `folders: ${String(archive.folders.length)}`,
      `encrypted: ${encrypted ? 'yes' : 'no'}`,
      `solid: ${solid ? 'yes' : 'no'}`,
    ],
    schema: largest.map(entry => `${entry.name}: ${(entry.size / 1024).toFixed(1)} KB`),
    notes,
    next: [
      '在面板中打开可直接列出条目并按需解码',
      encrypted ? '"解压后用主预览查看" 是当前对加密包的处理' : 'read(offset=…) 无法直接读压缩内容，需先解压',
    ],
    truncated: files.length > MAX_ITEMS,
  }
}
/**
 * Register the inspect tool when the profile provides a tool registry.
 * @param ctx - Host context carrying `fs` and optionally `tools`.
 * @returns disposer, or a no-op when `tools` is unavailable.
 */
export function registerInspectTool(ctx: InspectContext): () => void {
  let dispose: (() => void) | undefined
  // The sandbox policy knows the session's workspace root, which the fs service
  // does not expose; without it a relative path resolves against the app cwd.
  let sandbox: SandboxPolicyLike | undefined
  ctx.inject?.(['sandboxPolicy'], (scope: never) => {
    sandbox = (scope as { sandboxPolicy?: SandboxPolicyLike }).sandboxPolicy
  })
  ctx.inject?.(['tools'], (scope: never) => {
    const toolsCtx = scope as unknown as {
      tools: ToolsLike
      effect(fn: () => void, label: string): unknown
    }
    toolsCtx.effect(() => {
      dispose = toolsCtx.tools.register({
        name: 'preview_inspect',
        description: 'Describe the structure of a file instead of reading its bytes: one summary line, '
          + 'a few facts, a schema (columns or tensors), warnings, and concrete next steps. '
          + 'Supports GGUF model headers and delimited text (CSV/TSV).',
        parameters: PARAMETERS,
        output: {
          schema: OUTPUT_SCHEMA,
          render: (_args: unknown, value: InspectResult): unknown[] => [{
            type: 'text',
            text: [
              value.summary,
              ...value.facts.map(line => `  ${line}`),
              ...value.schema.map(line => `  ${line}`),
              ...value.notes.map(line => `! ${line}`),
              ...value.next.map(line => `→ ${line}`),
            ].join('\n'),
          }],
        },
        async execute(args: { path?: string } | undefined, exec?: { agent?: { session?: unknown } }) {
          const path = args?.path
          if (typeof path !== 'string' || path === '') throw new Error('path is required')
          const signal = AbortSignal.timeout(10_000)

          // Absolute paths go through the host-path mapping; a relative path is
          // resolved against the session workspace root the sandbox policy knows.
          let target: unknown
          if (isAbsolute(path)) {
            const mapped = ctx.fs.processPathFromHostPath(path)
            if (mapped === undefined) throw new Error('path is outside the workspace')
            target = await ctx.fs.resolve(mapped, { signal })
          } else {
            let cwd: string | undefined
            try {
              const policy = sandbox?.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
              cwd = policy?.workspaceRoot ?? policy?.root
            } catch {
              // No policy: fall back to the service default.
            }
            target = await ctx.fs.resolve(path, cwd === undefined ? { signal } : { cwd, signal })
          }

          const info = await ctx.fs.stat(target, signal)
          const size = info?.size ?? 0
          const suffix = extname(path).slice(1).toLowerCase()

          if (suffix === 'csv' || suffix === 'tsv' || suffix === 'tab') {
            const length = Math.min(size, TEXT_BYTES)
            const head = await ctx.fs.readByteRange(target, { offset: 0, length }, signal)
            return inspectCsv(new Uint8Array(head), size > TEXT_BYTES, size)
          }

          const read: Reader = async (offset, length) =>
            new Uint8Array(await ctx.fs.readByteRange(target, { offset, length }, signal))

          if (suffix === 'jsonl' || suffix === 'ndjson') {
            const length = Math.min(size, TEXT_BYTES)
            return inspectJsonl(new Uint8Array(await read(0, length)), size > TEXT_BYTES)
          }

          if (suffix === 'zip') return inspectZip(size, read)

          if (suffix === 'sqlite' || suffix === 'sqlite3' || suffix === 'db' || suffix === 'db3') {
            return inspectSqlite(read)
          }

          if (suffix === '7z') return inspectSevenZip(read)

          if (suffix === 'safetensors') return inspectSafetensors(size, read)

          if (suffix === 'ipynb') {
            const length = Math.min(size, HEAD_BYTES)
            return inspectNotebook(new Uint8Array(await read(0, length)))
          }

          if (suffix === 'rst') {
            const length = Math.min(size, TEXT_BYTES)
            return inspectRst(new Uint8Array(await read(0, length)), size > TEXT_BYTES)
          }

          if (suffix === 'epub') return inspectEpub(size, read)

          if (suffix === 'gguf') {
            const length = Math.min(size, HEAD_BYTES)
            const head = await ctx.fs.readByteRange(target, { offset: 0, length }, signal)
            const bytes = new Uint8Array(head)
            if (!looksLikeGguf(bytes)) throw new Error('not a GGUF file (magic mismatch)')
            return inspectGguf(bytes)
          }

          throw new Error(`unsupported format: ${suffix === '' ? '(no extension)' : suffix}`)
        },
      })
    }, 'any-preview: preview_inspect tool')
  })
  return () => { dispose?.() }
}

// Exported for tests: pure, no fs involved.
export {
  detectDelimiter, inferType, inspectCsv, inspectGguf, inspectJsonl, inspectZip, inspectSqlite,
  inspectSafetensors, inspectRst, inspectNotebook, inspectEpub, inspectSevenZip,
}
