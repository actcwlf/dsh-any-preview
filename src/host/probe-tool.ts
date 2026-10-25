/**
 * Probe: can a user-installed plugin register an agent tool?
 *
 * Registers one tool that ignores the filesystem and returns a fixed payload,
 * so the answer is a single tool call rather than an experiment in the product
 * code. Remove this module once the question is answered.
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

/**
 * Register the probe tool when the profile provides a tool registry.
 * @param ctx - Host context.
 * @returns disposer, or a no-op when `tools` is unavailable.
 */
export function registerProbeTool(ctx: ProbeContext): () => void {
  let dispose: (() => void) | undefined
  ctx.inject?.(['tools'], (scope: never) => {
    const tools = (scope as { tools: ToolsLike }).tools
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
            ok: { type: 'boolean', required: true },
            plugin: { type: 'string', required: true },
            echo: { type: 'string', required: true },
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
  })
  return () => { dispose?.() }
}
