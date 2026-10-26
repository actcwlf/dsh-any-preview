/**
 * `preview_inspect`: let the agent read a file's structure, not its bytes.
 *
 * The parsers behind the sidebar previews are pure functions over a byte range,
 * which makes them usable here: the tool reads only the window a format needs
 * and answers with a bounded summary. The model gets "what is in this file" in
 * one call instead of pulling a model file into context.
 *
 * Scope: workspace files, read through the same fs service the previews use.
 * Known gap (see docs/security-notes.md): that service accepts host paths
 * outside the session workspace, so this tool is only as narrow as its own
 * summary — a workspace-root check is still to be added.
 */
import { extname, isAbsolute, join } from 'node:path'
import type { HostFileSystem, RouteContext } from './contracts.ts'
import { looksLikeGguf, parseGguf } from '../client/previews/gguf/parse.ts'

/** Header window for binary formats. */
const HEAD_BYTES = 4 * 1024 * 1024

/** Text window for delimited files. */
const TEXT_BYTES = 1 * 1024 * 1024

/** How many keys, tensors, rows or columns a summary may name. */
const MAX_ITEMS = 20

/** Parameters: object root, closed, no required on the scalar. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'Absolute path of the file to inspect.' },
  },
} as const

/** Output: object root, closed, scalars without required. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    summary: { type: 'string' },
    truncated: { type: 'boolean' },
  },
} as const

/** The `tools` service as this tool uses it. */
interface SandboxPolicyLike {
  resolve(input: { session?: unknown }): { workspaceRoot?: string, root?: string }
}

interface ToolsLike {
  register(tool: unknown): () => void
}

/** Context with the optional inject used to reach `tools`. */
interface InspectContext extends RouteContext {
  fs: HostFileSystem
  inject?(deps: readonly string[], callback: (scope: never) => void): unknown
}

/** Render a GGUF header as a compact, bounded summary. */
export function summariseGguf(bytes: Uint8Array): { kind: string, summary: string, truncated: boolean } {
  const header = parseGguf(bytes)
  const kv = header.kv ?? []
  const tensors = header.tensors ?? []
  const lines: string[] = [`GGUF v${String(header.version)}`]
  lines.push(`metadata: ${String(kv.length)} keys, tensors: ${String(tensors.length)}`)
  for (const entry of kv.slice(0, MAX_ITEMS)) lines.push(`  ${entry.key} = ${String(entry.value)}`)
  for (const tensor of tensors.slice(0, MAX_ITEMS)) {
    lines.push(`  ${tensor.name} ${tensor.type} [${tensor.dims.join('×')}] ${String(tensor.params)} params`)
  }
  const truncated = kv.length > MAX_ITEMS || tensors.length > MAX_ITEMS
  if (truncated) lines.push(`… truncated (${String(kv.length)} keys, ${String(tensors.length)} tensors)`)
  return { kind: 'gguf', summary: lines.join('\n'), truncated }
}

/** Pick the delimiter that appears most on the first line. */
export function detectDelimiter(line: string): string {
  const candidates = [',', '\t', ';', '|']
  let best = ','
  let bestCount = 0
  for (const candidate of candidates) {
    const count = line.split(candidate).length - 1
    if (count > bestCount) { best = candidate; bestCount = count }
  }
  return best
}

/** Describe a delimited text file from its first bytes. */
export function summariseCsv(bytes: Uint8Array, truncatedRead: boolean): { kind: string, summary: string, truncated: boolean } {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const lines = text.split(/\r?\n/u).filter((line) => line !== '')
  if (lines.length === 0) throw new Error('file is empty')
  const first = lines[0] ?? ''
  const delimiter = detectDelimiter(first)
  const columns = first.split(delimiter)
  const rows = lines.slice(1, 11)
  const out: string[] = []
  out.push(`delimited text: delimiter ${JSON.stringify(delimiter === '\t' ? 'tab' : delimiter)}, ${String(columns.length)} columns`)
  out.push(`columns: ${columns.slice(0, MAX_ITEMS).join(' | ')}`)
  out.push(`first ${String(rows.length)} rows:`)
  for (const row of rows) out.push(`  ${row.slice(0, 200)}`)
  const truncated = truncatedRead || columns.length > MAX_ITEMS
  if (truncated) out.push('… truncated: more content, more columns, or both')
  return { kind: 'csv', summary: out.join('\n'), truncated }
}

/**
 * Register the inspect tool when the profile provides a tool registry.
 * @param ctx - Host context carrying `fs` and optionally `tools`.
 * @returns disposer, or a no-op when `tools` is unavailable.
 */
export function registerInspectTool(ctx: InspectContext): () => void {
  let dispose: (() => void) | undefined
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
        description: 'Describe the structure of a workspace file instead of its bytes. '
          + 'Supports GGUF model headers (version, metadata, tensor table) and delimited text '
          + '(CSV/TSV: delimiter, columns, first rows).',
        parameters: PARAMETERS,
        output: {
          schema: OUTPUT_SCHEMA,
          render: (_args: unknown, value: { summary?: string }): unknown[] => [
            { type: 'text', text: value.summary ?? '' },
          ],
        },
        async execute(args: { path?: string } | undefined, exec?: { agent?: { session?: unknown } }) {
          const path = args?.path
          if (typeof path !== 'string' || path === '') throw new Error('path is required')
          const signal = AbortSignal.timeout(10_000)
          // Absolute paths go through the host-path mapping. A relative path is
          // handed to the fs service as-is: it is the layer that knows where the
          // session workspace is, and it resolves workspace-relative names.
          let target: unknown
          if (isAbsolute(path)) {
            const mapped = ctx.fs.processPathFromHostPath(path)
            if (mapped === undefined) throw new Error('path is outside the workspace')
            target = await ctx.fs.resolve(mapped, { signal })
          } else {
            try {
              let cwd: string | undefined
            try {
              const policy = sandbox?.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
              cwd = policy?.workspaceRoot ?? policy?.root
            } catch {
              // No policy: fall through to the service default.
            }
            target = await ctx.fs.resolve(path, cwd === undefined ? { signal } : { cwd, signal })
            } catch {
              // Last resort: the application's cwd, which is what used to happen.
              const mapped = ctx.fs.processPathFromHostPath(join(process.cwd(), path))
              if (mapped === undefined) throw new Error('path is outside the workspace')
              target = await ctx.fs.resolve(mapped, { signal })
            }
          }
          const info = await ctx.fs.stat(target, signal)
          const size = info?.size ?? 0
          const suffix = extname(path).slice(1).toLowerCase()

          if (suffix === 'csv' || suffix === 'tsv' || suffix === 'tab') {
            const length = Math.min(size, TEXT_BYTES)
            const head = await ctx.fs.readByteRange(target, { offset: 0, length }, signal)
            return summariseCsv(new Uint8Array(head), size > TEXT_BYTES)
          }

          if (suffix === 'gguf') {
            const length = Math.min(size, HEAD_BYTES)
            const head = await ctx.fs.readByteRange(target, { offset: 0, length }, signal)
            const bytes = new Uint8Array(head)
            if (!looksLikeGguf(bytes)) throw new Error('not a GGUF file (magic mismatch)')
            return summariseGguf(bytes)
          }

          throw new Error(`unsupported format: ${suffix === '' ? '(no extension)' : suffix}`)
        },
      })
    }, 'any-preview: preview_inspect tool')
  })
  return () => { dispose?.() }
}
