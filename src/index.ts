/**
 * Host half: contribute the authenticated file route the binary renderers read
 * from, and the archive-extraction route that makes a member openable by the
 * standard preview. Formats that only need text or whole bytes read entirely in
 * the browser and need nothing here.
 */
import { registerExtractRoute } from './host/extract-route.ts'
import type { ExtractRouteContext } from './host/extract-route.ts'
import { registerLanRoute } from './host/lan-route.ts'
import { createLanSecret } from './host/lan-url.ts'
import { registerMediaRoute } from './host/media-route.ts'
import type { MediaRouteContext } from './host/media-route.ts'
import { checkHostContracts } from './host/self-check.ts'
import { reportContractIssues } from './shared/contracts.ts'

/** Both routes need the Fetch carrier and the Host filesystem policy. */
export const inject = ['connection', 'fs']

interface HostContext extends MediaRouteContext, ExtractRouteContext {
  effect(run: () => () => void, label?: string): unknown
}

export function apply(ctx: HostContext): void {
  // A renamed capability would otherwise fail silently at request time.
  reportContractIssues('host', checkHostContracts(ctx))
  const lanSecret = createLanSecret()
  ctx.effect(() => registerMediaRoute(ctx, lanSecret), 'any-preview: media route')
  ctx.effect(() => registerLanRoute(ctx, lanSecret), 'any-preview: loopback media route')
  ctx.effect(() => registerExtractRoute(ctx), 'any-preview: extract route')
}
