/**
 * Model decoding, shared by the preview and its tests.
 *
 * three.js and its loaders are passed in rather than imported: the client
 * bundle loads them lazily from a separate chunk (chunk/three.ts), and a test
 * can hand in the real module from Node without paying for that chunk.
 */
import type { ThreeBundle } from '../../../chunk/three.ts'
import { PreviewError } from '../../kernel/errors.ts'

/** The loaders one decode needs. */
export type ModelBundle = Pick<ThreeBundle, 'THREE' | 'GLTFLoader' | 'OBJLoader' | 'STLLoader'>

/** three.js objects are opaque here; their real types live in the lazy chunk. */
export type Object3D = any

/** Progress of a body read: bytes delivered, and the announced total when there is one. */
type Progress = (loaded: number, total: number | undefined) => void

/**
 * Decode one model file into a scene object.
 * @param bundle - three.js and the loaders.
 * @param extension - lowercase suffix without the dot.
 * @param bytes - the whole file.
 * @returns the object to add to the scene.
 */
export async function parseModel(bundle: ModelBundle, extension: string, bytes: ArrayBuffer): Promise<Object3D> {
  const { THREE } = bundle
  if (extension === 'glb' || extension === 'gltf') {
    const gltf = await new bundle.GLTFLoader().parseAsync(bytes, '')
    return gltf.scene
  }
  if (extension === 'obj') {
    return new bundle.OBJLoader().parse(new TextDecoder().decode(bytes))
  }
  if (extension === 'stl') {
    // STLLoader already writes per-face normals; recomputing them here only
    // burned CPU on the largest meshes and changed nothing on screen.
    const geometry = new bundle.STLLoader().parse(bytes)
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xbfc4cc, metalness: 0.1, roughness: 0.7 }))
  }
  throw new PreviewError('model.unsupported', { ext: extension })
}

/** Visit every node without letting one odd child abort the walk. */
function visit(root: Object3D, callback: (child: any) => void): void {
  if (root === null || root === undefined || typeof root.traverse !== 'function') return
  root.traverse((child: any) => {
    try {
      callback(child)
    } catch {
      /* teardown and counting must finish even with a malformed node */
    }
  })
}

/**
 * Count the triangles a scene object would submit.
 *
 * `InstancedMesh` counts once, as before; that is a budget for the buffers the
 * preview allocates, not an exact draw-call count.
 * @param root - scene object to walk.
 * @returns rounded triangle total.
 */
export function countTriangles(root: Object3D): number {
  let total = 0
  visit(root, (child) => {
    if (child.isMesh !== true || child.geometry === undefined) return
    const geometry = child.geometry
    const index = typeof geometry.getIndex === 'function' ? geometry.getIndex() : null
    const position = typeof geometry.getAttribute === 'function' ? geometry.getAttribute('position') : undefined
    total += index === null ? (position?.count ?? 0) / 3 : index.count / 3
  })
  return Math.round(total)
}

/**
 * Release every GPU resource an object owns.
 *
 * The old walk only disposed `Mesh` nodes, so a glTF line or point cloud kept
 * its buffers alive on every open; this covers any node carrying geometry or a
 * material, including the preview's own grid.
 * @param root - scene object to dispose.
 */
export function disposeObject(root: Object3D): void {
  visit(root, (child) => {
    if (typeof child.geometry?.dispose === 'function') child.geometry.dispose()
    const material = child.material
    const materials = Array.isArray(material) ? material : material === undefined ? [] : [material]
    for (const one of materials) {
      if (one === null || typeof one !== 'object') continue
      for (const value of Object.values(one)) {
        const maybeTexture = value as { isTexture?: boolean; dispose?: () => void } | null
        if (maybeTexture !== null && typeof maybeTexture === 'object' && maybeTexture.isTexture === true) {
          maybeTexture.dispose?.()
        }
      }
      if (typeof one.dispose === 'function') one.dispose()
    }
  })
}

/**
 * Read a fetch body into one buffer while reporting progress.
 *
 * `arrayBuffer()` gives no progress and no way to see how much is left, which
 * on a 100 MB model is the difference between a spinner and a byte count.
 * @param response - response whose body is read once.
 * @param onProgress - called per chunk; the total is absent when the transport
 *   does not announce a length (the desktop proxy strips `Content-Length`).
 * @returns exactly the bytes read.
 */
export async function readBody(response: Response, onProgress?: Progress): Promise<Uint8Array> {
  const announced = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  const total = Number.isFinite(announced) && announced > 0 ? announced : undefined
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    onProgress?.(bytes.byteLength, total ?? bytes.byteLength)
    return bytes
  }
  const reader = response.body.getReader()
  // Allocate the announced size once. A transport that hides the length (the
  // desktop proxy does) starts empty and collects chunks instead.
  let buffer = total === undefined ? new Uint8Array(0) : new Uint8Array(total)
  let chunks: Uint8Array[] | undefined
  let loaded = 0
  const append = (value: Uint8Array): void => {
    if (chunks !== undefined) {
      chunks.push(value)
      loaded += value.byteLength
      return
    }
    if (loaded + value.byteLength <= buffer.byteLength) {
      buffer.set(value, loaded)
      loaded += value.byteLength
      return
    }
    // The stream is longer than announced: keep what was copied, then collect.
    chunks = [buffer.subarray(0, loaded), value]
    loaded += value.byteLength
    buffer = new Uint8Array(0)
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    append(value)
    onProgress?.(loaded, total)
  }
  if (chunks !== undefined) {
    const bytes = new Uint8Array(loaded)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    buffer = bytes
  } else if (loaded !== buffer.byteLength) {
    buffer = buffer.subarray(0, loaded)
  }
  onProgress?.(loaded, total ?? loaded)
  return buffer
}
