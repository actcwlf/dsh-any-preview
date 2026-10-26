/**
 * `preview_inspect`: let the agent read a file's structure, not its bytes.
 *
 * The parsers behind the sidebar previews are pure functions over a byte range,
 * which makes them usable here: the tool reads only the header window a format
 * needs and answers with a bounded summary. The model gets "what is in this
 * file" in one call instead of pulling a model file into context.
 *
 * Scope: workspace only, through the same fs service the previews use.
 */
import { isAbsolute, join } from 'node:path'
import type { HostFileSystem, RouteContext } from './contracts.ts'
import { looksLikeGguf, parseGguf } from '../client/previews/gguf/parse.ts'

/** Header window a GGUF file needs; real payloads are gigabytes. */
const HEAD_BYTES = 4 * 1024 * 1024

/** How many keys and tensors a summary may name. */
const MAX_ITEMS = 20

/** Parameters: object root, closed, no required on the scalar. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'Workspace path of the file to inspect.' },
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
interface ToolsLike {
  register(tool: unknown): () => void
}

/** Context with the optional inject used to reach `tools`. */
interface InspectContext extends RouteContext {
  fs: HostFileSystem
  inject?(deps: readonly string[], callback: (scope: never) => void): unknown
}

/** Render a GGUF header as a compact, bounded summary. */
function summarise(header: ReturnType<typeof parseGguf>): { summary: string, truncated: boolean } {
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
  return { summary: lines.join('\n'), truncated }
}

/**
 * Register the inspect tool when the profile provides a tool registry.
 * @param ctx - Host context carrying `fs` and optionally `tools`.
 * @returns disposer, or a no-op when `tools` is unavailable.
 */
export function registerInspectTool(ctx: InspectContext): () => void {
  let dispose: (() => void) | undefined
  ctx.inject?.(['tools'], (scope: never) => {
    const toolsCtx = scope as unknown as {
      tools: ToolsLike
      effect(fn: () => void, label: string): unknown
    }
    toolsCtx.effect(() => {
      dispose = toolsCtx.tools.register({
        name: 'preview_inspect',
        description: 'Describe the structure of a workspace file instead of its bytes. '
          + 'Currently supports GGUF model files: returns the version, metadata keys and tensor table.',
        parameters: PARAMETERS,
        output: {
          schema: OUTPUT_SCHEMA,
          render: (_args: unknown, value: { summary?: string }): unknown[] => [
            { type: 'text', text: value.summary ?? '' },
          ],
        },
        async execute(args: { path?: string } | undefined) {
          const path = args?.path
          if (typeof path !== 'string' || path === '') throw new Error('path is required')
          const signal = AbortSignal.timeout(10_000)
          // Accept a workspace-relative path as well as an absolute one: the
          // model usually knows the file by its relative name.
          const hostPath = isAbsolute(path) ? path : join(process.cwd(), path)
          const mapped = ctx.fs.processPathFromHostPath(hostPath)
          if (mapped === undefined) throw new Error('path is outside the workspace')
          const target = await ctx.fs.resolve(mapped, { signal })
          const head = await ctx.fs.readByteRange(target, { offset: 0, length: HEAD_BYTES }, signal)
          const bytes = new Uint8Array(head)
          if (!looksLikeGguf(bytes)) throw new Error('not a GGUF file (magic mismatch)')
          const { summary, truncated } = summarise(parseGguf(bytes))
          return { kind: 'gguf', summary, truncated }
        },
      })
    }, 'any-preview: preview_inspect tool')
  })
  return () => { dispose?.() }
}
