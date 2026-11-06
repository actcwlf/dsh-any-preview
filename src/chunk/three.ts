/**
 * The lazy 3D chunk.
 *
 * three.js and its addons are the bulk of this package's client bundle, and a
 * reader who never opens a model should not pay for them at startup. This entry
 * is built as its own ESM file and imported at runtime from the loopback asset
 * route (the same signed-URL transport the media preview uses).
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/** Everything the base model viewer needs, in one module instance. */
export interface ThreeBundle {
  readonly THREE: typeof THREE
  readonly OrbitControls: typeof OrbitControls
  readonly GLTFLoader: typeof GLTFLoader
  readonly OBJLoader: typeof OBJLoader
  readonly STLLoader: typeof STLLoader
  /** OBJ material libraries; small enough to ride with the base chunk. */
  readonly MTLLoader: typeof MTLLoader
  /** Neutral studio environment, so PBR metal is not black without an HDR file. */
  readonly RoomEnvironment: typeof RoomEnvironment
}

export { OrbitControls, GLTFLoader, OBJLoader, STLLoader, MTLLoader, RoomEnvironment, THREE }
