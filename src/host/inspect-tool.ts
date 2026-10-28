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
export { detectDelimiter, inferType, inspectCsv, inspectGguf }
