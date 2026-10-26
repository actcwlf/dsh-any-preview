/**
 * Probe: can a plugin register an agent tool with a *compiled* schema?
 *
 * The previous attempt sent the author-side DSL directly to `tools.register`,
 * which the registry does not compile — the provider then saw `type: null` and
 * rejected the whole tool list. This version hands over finished JSON Schema:
 * an object root for parameters, and no `required` on scalar output fields.
 *
 * The exact schemas are exported so a route can report what would be sent.
 */
import type { RouteContext } from './contracts.ts'

/** Parameter schema: object root, closed, no `required` on the scalar. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    echo: { type: 'string', description: 'Any string; returned unchanged.' },
  },
} as const

/** Output schema: object root, closed, scalars without `required`. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    echo: { type: 'string' },
  },
} as const

/** The `tools` service as this probe uses it. */
interface ToolsLike {
  register(tool: unknown): () => void
}

/** Context with the optional inject used to reach `tools`. */
interface ProbeContext extends RouteContext {
  inject?(deps: readonly string[], callback: (scope: never) => void): unknown
}

/** What the last registration attempt observed. */
export interface ProbeState {
  readonly attempted: boolean
  readonly registered: boolean
  readonly error?: string
}

let state: ProbeState = { attempted: false, registered: false }

/** @returns what the last registration attempt observed. */
export function probeState(): ProbeState {
  return state
}

/** @returns the exact schemas this probe would send to the provider. */
export function probeSchema(): { parameters: unknown, output: unknown } {
  return { parameters: PARAMETERS, output: OUTPUT_SCHEMA }
}

/**
 * Register the probe tool when the profile provides a tool registry.
 * @param ctx - Host context.
 * @returns disposer, or a no-op when `tools` is unavailable.
 */
export function registerProbeTool(ctx: ProbeContext): () => void {
  state = { attempted: false, registered: false }
  let dispose: (() => void) | undefined
  if (ctx.inject === undefined) {
    state = { attempted: true, registered: false, error: 'host context has no inject' }
    return () => {}
  }
  ctx.inject(['tools'], (scope: never) => {
    const tools = (scope as { tools: ToolsLike }).tools
    try {
      dispose = tools.register({
        name: 'preview_probe',
        description: 'Return a fixed payload. Used to check whether a plugin-registered tool is '
          + 'reachable from the agent loop. It reads nothing and changes nothing.',
        parameters: PARAMETERS,
        output: {
          schema: OUTPUT_SCHEMA,
          render: (_args: unknown, value: unknown): unknown[] => [
            { type: 'text', text: JSON.stringify(value) },
          ],
        },
        async execute(args: { echo?: string } | undefined) {
          return { ok: true, echo: args?.echo ?? '' }
        },
      })
      state = { attempted: true, registered: true }
    } catch (error) {
      state = {
        attempted: true,
        registered: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
  return () => { dispose?.() }
}
