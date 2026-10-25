/**
 * The Host-side contract both routes share.
 *
 * Each route declares only what it uses, but the Host entry composes them, so
 * the `fs` and `connection` shapes must be one identical type — two structurally
 * different declarations cannot be extended together.
 */

/** The Host filesystem surface these routes touch. */
export interface HostFileSystem {
  processPathFromHostPath(path: string): string | undefined
  processPath(target: unknown): string
  resolve(path: string, options: { signal: AbortSignal }): Promise<unknown>
  stat(target: unknown, signal: AbortSignal): Promise<{ type?: string, size?: number, displayPath?: string } | undefined>
  readByteRange(target: unknown, range: { offset: number, length: number }, signal: AbortSignal): Promise<Uint8Array>
  readBytes(target: unknown, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
}

/** One route registration on the authenticated Fetch carrier. */
export interface RouteRegistration {
  readonly path: string
  readonly methods: string[]
  readonly requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}

/** What a route needs from the Host context. */
export interface RouteContext {
  readonly fs: HostFileSystem
  readonly connection: {
    readonly fetch: {
      register(route: RouteRegistration): () => void
    }
  }
}
