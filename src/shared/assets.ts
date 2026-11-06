/**
 * Package assets both halves must agree on.
 *
 * The Host serves exactly these names from `lib/`; the client fetches them
 * through the loopback route. Keeping the list in one place means a new asset
 * cannot be served without being fetchable, or vice versa.
 */

/** Whitelisted asset name to response content type. */
export const ASSET_MIME: Readonly<Record<string, string>> = {
  'three-chunk.js': 'text/javascript; charset=utf-8',
  'model-extras-chunk.js': 'text/javascript; charset=utf-8',
  'lzma.wasm': 'application/wasm',
  'mux-chunk.js': 'text/javascript; charset=utf-8',
  // Decoders three ships for glTF: the loaders fetch these by name from the
  // asset base, so the wasm needs its real MIME for streaming instantiation.
  'draco_wasm_wrapper.js': 'text/javascript; charset=utf-8',
  'draco_decoder.wasm': 'application/wasm',
  'basis_transcoder.js': 'text/javascript; charset=utf-8',
  'basis_transcoder.wasm': 'application/wasm',
}

/** Path prefix the assets are served under. */
export const ASSET_PREFIX = '/any-preview/asset'
