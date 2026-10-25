/**
 * Host half: contribute the authenticated byte-range route that the media
 * renderers stream from. Formats that only need text or whole bytes render
 * entirely in the browser and need nothing here.
 */
import { registerMediaRoute } from './host/media-route.ts'
import type { MediaRouteContext } from './host/media-route.ts'

/** The route needs the Fetch carrier and the Host filesystem policy. */
export const inject = ['connection', 'fs']

interface HostContext extends MediaRouteContext {
  effect(run: () => () => void, label?: string): unknown
}

export function apply(ctx: HostContext): void {
  ctx.effect(() => registerMediaRoute(ctx), 'any-preview: media route')
}
