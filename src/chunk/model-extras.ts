/**
 * The lazy decoder chunk.
 *
 * Draco, KTX2 and OBJ material support are needed by a minority of models, and
 * the loaders plus their support code are ~100 KB, so they get their own ESM
 * file next to the three.js chunk. The wasm decoders themselves are fetched by
 * these loaders at runtime from the asset base (`ASSET_MIME`), never bundled.
 */
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

/** Everything the model viewer needs beyond the base three chunk. */
export interface ModelExtrasBundle {
  readonly DRACOLoader: typeof DRACOLoader
  readonly KTX2Loader: typeof KTX2Loader
  readonly MeshoptDecoder: typeof MeshoptDecoder
}

export { DRACOLoader, KTX2Loader, MeshoptDecoder }
