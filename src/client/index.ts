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
import { setDirectoryPicker, setOpenResource } from './runtime.ts'
import { checkClientContracts } from './contracts.ts'
import { warmableChunks } from './kernel/chunk-policy.ts'
import { loadMux } from './kernel/mux-loader.ts'
import { loadThree } from './kernel/three-loader.ts'
import { refreshLocale, setTranslator } from './i18n.ts'
import { en, zh } from './locales.ts'
import { reportContractIssues } from '../shared/contracts.ts'

/** Copy namespace this package's dictionaries register under. */
const NS = 'anyPreview'

/** Loaders for every chunk the policy can name. */
const CHUNK_LOADERS: Readonly<Record<string, () => Promise<unknown>>> = {
  three: loadThree,
  mux: loadMux,
}

/** How the shell's locale service looks to this plugin. */
interface LocaleService {
  register(namespace: string, dictionaries: { zh: unknown, en: unknown }): unknown
  bind(namespace: string): (key: string, params?: Readonly<Record<string, string | number>>) => string
}

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
  // Turn a missing upstream capability into one diagnostic line instead of a
  // silently empty sidebar.
  reportContractIssues('client', checkClientContracts(ctx))
  // Warm the chunks whose policy says warm (three by default) while the page
  // is idle: the startup bundle stays small and opening a model shows no wait.
    // A 'never' chunk is not warmed and its preview reports itself disabled.
  try {
    const warm = (): void => {
      for (const id of warmableChunks()) {
        const load = CHUNK_LOADERS[id]
        if (load !== undefined) void load().catch(() => {})
      }
    }
    if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 })
    else setTimeout(warm, 1500)
  } catch {
    // Warm-up is best effort.
  }

  // Optional capabilities. A profile without them still renders every preview;
  // only the "open elsewhere" and "choose a directory" affordances are lost.
  //
  // Every step below is wrapped: the desktop shell treats a client entry that
  // fails to activate as a fatal boot error, so apply must never throw. In
  // particular, reading a property off the remote proxy resolves a namespace
  // and can throw when that namespace is not routed yet.
  const safe = (run: () => void, what: string): void => {
    try {
      run()
    } catch (error) {
      console.warn(`[dsh-any-preview] ${what} unavailable`, error)
    }
  }

  // Locale. The built-in packages inject `locale` as a hard dependency because
  // they ship with the app; a third-party plugin cannot — a profile without the
  // service would never activate. So it is injected optionally and the bundled
  // dictionaries answer whenever the service is absent.
  safe(() => {
    ctx.inject?.(['locale'], (scope: never) => {
      const locale = (scope as { locale: LocaleService }).locale
      safe(() => { locale.register(NS, { zh, en }) }, 'locale dictionaries')
      safe(() => { setTranslator(locale.bind(NS)) }, 'locale binding')
    })
  }, 'locale injection')

  // The shell sets <html lang> from the operator's preference; following it is
  // what re-renders the bundled fallback when the language switches.
  safe(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
    refreshLocale()
    const observer = new MutationObserver(() => { refreshLocale() })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    ctx.effect(() => () => { observer.disconnect() }, 'any-preview: locale observer')
  }, 'locale observer')

  const bindSidebar = (sidebar: unknown): void => {
    const api = sidebar as { openResource?(address: string): void } | undefined
    if (typeof api?.openResource === 'function') {
      setOpenResource(address => { api.openResource!(address) })
    }
  }
  const bindPicker = (remote: unknown): void => {
    const holder = remote as { directoryPicker?: { pick(lifetime: AbortSignal): Promise<string | null> } } | undefined
    const picker = holder?.directoryPicker
    if (picker !== undefined) setDirectoryPicker(signal => picker.pick(signal))
  }

  // `sidebarRight` is an ordinary service and safe to read immediately; the
  // remote proxy is not, so it is only reached through a deferred injection.
  safe(() => {
    const sidebar = (ctx as { get?(key: string, strict?: boolean): unknown }).get?.('sidebarRight', false)
    if (sidebar !== undefined) bindSidebar(sidebar)
  }, 'sidebar binding')

  safe(() => {
    ctx.inject?.(['sidebarRight'], (scope: never) => {
      safe(() => { bindSidebar((scope as { sidebarRight: unknown }).sidebarRight) }, 'sidebar binding')
    })
  }, 'sidebar injection')

  safe(() => {
    // The namespace must be named in the injection: reading
    // `remote.directoryPicker` from a scope that injected only `remote` throws
    // "cannot get property … without inject".
    ctx.inject?.(['remote', 'remote.directoryPicker'], (scope: never) => {
      const remote = (scope as { remote: unknown }).remote
      safe(() => { bindPicker(remote) }, 'directory picker')
    })
  }, 'remote injection')

  for (const module of PREVIEWS) registerPreview(ctx, module)
}
