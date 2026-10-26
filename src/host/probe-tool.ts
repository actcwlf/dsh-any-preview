/**
 * Probe: can a user-installed plugin register an agent tool, and did it run?
 *
 * Registers one tool that ignores the filesystem and returns a fixed payload.
 * The outcome is also recorded in `probeState()` so a route can report whether
 * registration was attempted and whether the registry accepted it — without
 * needing to read Host logs.
 */
import type { RouteContext } from './contracts.ts'

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
  readonly path?: string
  readonly error?: string
}

let state: ProbeState = { attempted: false, registered: false }

/** @returns what the last registration attempt observed. */
export function probeState(): ProbeState {
  return state
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
  const attempt = (tools: ToolsLike, path: string): void => {
    try {
      dispose = tools.register({
        name: 'preview_probe',
        description: 'Return a fixed payload. Used to check whether a plugin-registered tool is '
          + 'reachable from the agent loop. It reads nothing and changes nothing.',
        parameters: {
          echo: { type: 'string', description: 'Any string; returned unchanged.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              plugin: { type: 'string' },
              echo: { type: 'string' },
            },
          },
          render: (_args: unknown, value: unknown): unknown[] => [
            { type: 'text', text: JSON.stringify(value) },
          ],
        },
        async execute(args: { echo?: string } | undefined) {
          return { ok: true, plugin: 'dsh-any-preview', echo: args?.echo ?? '' }
        },
      })
      state = { attempted: true, registered: true, path }
    } catch (error) {
      state = {
        attempted: true,
        registered: false,
        path,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  ctx.inject(['tools'], (scope: never) => { attempt((scope as { tools: ToolsLike }).tools, 'inject') })
  // Second path: some kernels expose the registry on the plugin context itself.
  try {
    const direct = (ctx as { tools?: ToolsLike }).tools
    if (direct !== undefined && !state.registered) attempt(direct, 'direct')
  } catch {
    // Reading an uninjected namespace throws by design; that is not a failure.
  }
  return () => { dispose?.() }
}
