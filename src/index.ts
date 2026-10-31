/**
 * Host half: contribute the authenticated routes the renderers read from —
 * media bytes, line-aligned text slices for the CSV index, and archive
 * extraction — plus the inspect tool. Formats that only need the text the
 * document owner already delivered read entirely in the browser.
 */
import { registerExtractRoute } from './host/extract-route.ts'
import type { ExtractRouteContext } from './host/extract-route.ts'
import { registerLanRoute } from './host/lan-route.ts'
import { createLanSecret } from './host/lan-url.ts'
import { registerAssetBaseRoute, registerMediaRoute } from './host/media-route.ts'
import { registerTextRoute } from './host/text-route.ts'
import { registerInspectTool } from './host/inspect-tool.ts'
import type { MediaRouteContext } from './host/media-route.ts'
import { checkHostContracts } from './host/self-check.ts'
import { reportContractIssues } from './shared/contracts.ts'

/** Every route needs the Fetch carrier and the Host filesystem policy. */
export const inject = ['connection', 'fs']

interface HostContext extends MediaRouteContext, ExtractRouteContext {
  effect(run: () => () => void, label?: string): unknown
}

export function apply(ctx: HostContext): void {
  // A renamed capability would otherwise fail silently at request time.
  reportContractIssues('host', checkHostContracts(ctx))
  const lanSecret = createLanSecret()
  ctx.effect(() => registerMediaRoute(ctx, lanSecret), 'any-preview: media route')
  ctx.effect(() => registerTextRoute(ctx), 'any-preview: text route')
  ctx.effect(() => registerAssetBaseRoute(ctx), 'any-preview: asset base route')
  ctx.effect(() => registerInspectTool(ctx), 'any-preview: inspect tool')
  ctx.effect(() => registerLanRoute(ctx, lanSecret), 'any-preview: loopback media route')
  ctx.effect(() => registerExtractRoute(ctx), 'any-preview: extract route')
}
