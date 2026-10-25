/**
 * Plugin asset access: the lazy three.js chunk today, a decode wasm later.
 *
 * Assets ship in `lib/`, are served by a loopback route and fetched on demand,
 * so nothing here grows the startup bundle. A missing asset is a capability
 * that is simply off: callers disable their feature instead of failing.
 */
import { ASSET_MIME, ASSET_PREFIX } from '../../shared/assets.ts'

export { ASSET_MIME, ASSET_PREFIX }

/** One asset name from the shared whitelist. */
export type AssetName = keyof typeof ASSET_MIME

/** Host route that reports the loopback origin. */
const BASE_PATH = '/api/any-preview/asset-base'

/**
 * Resolve an asset to a URL the page can fetch.
 * @param name - whitelisted asset name.
 * @returns same-origin on an http page, loopback on dsh-app.
 */
export async function assetUrl(name: AssetName): Promise<string> {
  if (!(name in ASSET_MIME)) throw new Error(`unknown asset: ${name}`)
  if (typeof location !== 'undefined' && location.protocol.startsWith('http')) {
    return `${ASSET_PREFIX}/${name}`
  }
  const response = await fetch(BASE_PATH)
  if (!response.ok) throw new Error('asset route unavailable')
  const body = await response.json() as { base?: unknown }
  if (typeof body.base !== 'string' || body.base === '') throw new Error('asset route unavailable')
  return `${body.base}${ASSET_PREFIX}/${name}`
}

/**
 * Fetch and instantiate a wasm asset.
 *
 * The decode backend this is meant for keeps archive bytes in JS and hands wasm
 * only the slice to transform, so the module needs no filesystem of its own.
 * @param name - whitelisted `.wasm` asset.
 * @param imports - import object the module expects.
 * @returns the instantiated module.
 */
export async function loadWasm(
  name: AssetName,
  imports: WebAssembly.Imports = {},
): Promise<WebAssembly.Instance> {
  if (!name.endsWith('.wasm')) throw new Error(`not a wasm asset: ${name}`)
  const url = await assetUrl(name)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`asset ${name} unavailable (${String(response.status)})`)
  // Streaming compilation needs `application/wasm`; a mislabelled response still
  // works through the buffer path, just without streaming.
  try {
    const result = await WebAssembly.instantiateStreaming(response.clone(), imports)
    return result.instance
  } catch {
    const bytes = await response.arrayBuffer()
    const result = await WebAssembly.instantiate(bytes, imports)
    return result.instance
  }
}
