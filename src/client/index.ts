/**
 * Client half: register every preview in `PREVIEWS`.
 *
 * Two registrations make one renderer: the metadata row in `documentPreviews`
 * (which suffixes it claims and how content is delivered), and the keyed
 * component in the `sidebar.right.tab.document` seat. Each format is registered
 * independently so one broken declaration cannot take the package down.
 */
import type { PreviewModule } from './kernel/types.ts'
import { PREVIEWS } from './previews/index.ts'
import { setDirectoryPicker, setOpenResource, setRemoteLookup } from './runtime.ts'

interface DocumentPreviewDefinition {
  readonly id: string
  readonly extensions: readonly string[]
  readonly binaryExtensions?: readonly string[]
  readonly priority?: 'builtin' | 'extension'
  readonly title: () => string
  readonly loading: 'text-pages' | 'bytes-complete' | 'renderer'
  readonly wrap?: boolean
}

/** The slice of the client Cordis context this plugin touches. */
interface ClientContext {
  effect(run: () => () => void, label?: string): unknown
  inject?(deps: readonly string[], callback: (scope: never) => void): unknown
  readonly documentPreviews: { register(definition: DocumentPreviewDefinition): () => void }
  readonly slots: {
    inject(key: string, run: () => () => void): () => void
    register(entry: { readonly name: string, readonly key: string }, component: unknown): () => void
  }
}

// Wait for the document owner's registry and the slot system before applying.
export const inject = ['slots', 'documentPreviews']

/**
 * Register one format's metadata and body.
 * @param ctx - client root context.
 * @param module - the format to register.
 */
function registerPreview(ctx: ClientContext, module: PreviewModule): void {
  try {
    const definition: DocumentPreviewDefinition = {
      id: module.id,
      extensions: module.extensions,
      ...(module.binary !== undefined && module.binary.length > 0
        ? { binaryExtensions: module.binary }
        : {}),
      priority: 'extension',
      title: module.title,
      loading: module.load,
      ...(module.wrap === undefined ? {} : { wrap: module.wrap }),
    }
    ctx.effect(() => ctx.documentPreviews.register(definition), `${module.id}: metadata`)
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
      { name: 'sidebar.right.tab.document', key: module.id },
      module.Body,
    )), `${module.id}: body`)
  } catch (error) {
    // A malformed format loses only itself; the rest of the package stays live.
    console.error(`[dsh-any-preview] cannot register ${module.id}`, error)
  }
}

export function apply(ctx: ClientContext): void {
  // Optional capabilities. A profile without them still renders every preview;
  // only the "open elsewhere" and "choose a directory" affordances are lost.
  // Each is resolved twice: immediately when already active, and again through
  // a deferred injection for services that come up after this plugin.
  const get = (name: string): unknown =>
    (ctx as { get?(key: string, strict?: boolean): unknown }).get?.(name, false)

  const bindSidebar = (sidebar: unknown): void => {
    const api = sidebar as { openResource?(address: string): void } | undefined
    if (typeof api?.openResource === 'function') {
      setOpenResource(address => { api.openResource!(address) })
    }
  }
  const bindPicker = (remote: unknown): void => {
    const api = (remote as { directoryPicker?: { pick(lifetime: AbortSignal): Promise<string | null> } } | undefined)
      ?.directoryPicker
    if (api !== undefined) setDirectoryPicker(signal => api.pick(signal))
  }

  if (get('sidebarRight') !== undefined) bindSidebar(get('sidebarRight'))
  if (get('remote') !== undefined) bindPicker(get('remote'))

  ctx.inject?.(['sidebarRight'], (scope: never) => { bindSidebar((scope as { sidebarRight: unknown }).sidebarRight) })
  ctx.inject?.(['remote', 'remote.directoryPicker'], (scope: never) => {
    bindPicker((scope as { remote: unknown }).remote)
    setRemoteLookup(() => (scope as { remote: unknown }).remote)
  })
  for (const module of PREVIEWS) registerPreview(ctx, module)
}
