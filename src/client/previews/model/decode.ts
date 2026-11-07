/**
 * Model decoding, shared by the preview and its tests.
 *
 * three.js and its loaders are passed in rather than imported: the client
 * bundle loads them lazily from a separate chunk (chunk/three.ts), and a test
 * can hand in the real module from Node without paying for that chunk.
 *
 * External references are sandboxed to the model's own directory: glTF
 * buffers/images and OBJ material libraries go through `resources.ts`, which
 * rejects absolute URLs and `..` escapes before anything is fetched.
 */
import type { ThreeBundle } from '../../../chunk/three.ts'
import type { ModelExtrasBundle } from '../../../chunk/model-extras.ts'
import { PreviewError } from '../../kernel/errors.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import {
  declaredImageBytes,
  externalReferences,
  gltfJson,
  mtllibNames,
  resourceBase,
  resourceTarget,
  resolveResource,
  unsafeGltfReference,
} from './resources.ts'
import type { ModelNeeds } from './resources.ts'

/** The loaders one decode needs. */
export type ModelBundle = Pick<ThreeBundle, 'THREE' | 'GLTFLoader' | 'OBJLoader' | 'STLLoader' | 'MTLLoader'>

/** Optional decoders, present only when the chunk was loaded. */
export type ModelExtras = Partial<Pick<ModelExtrasBundle, 'DRACOLoader' | 'KTX2Loader' | 'MeshoptDecoder'>>

/** The optional capabilities one file needs. */
export type ModelDecoders = Pick<ModelNeeds, 'draco' | 'ktx2' | 'meshopt'>

/** Context one decode needs beyond the bytes. */
export interface ParseOptions {
  /** Already decoded OBJ text, to avoid decoding a large file twice. */
  readonly text?: string
  /** Directory external references are resolved against and confined to. */
  readonly baseDir?: string
  /** Decoder loaders, when the file needs them. */
  readonly extras?: ModelExtras
  /** Which decoders to install. */
  readonly decoders?: ModelDecoders
  /** Asset base the decoders fetch their wasm from. */
  readonly assetBase?: string
  /** Renderer KTX2 support probing needs. */
  readonly renderer?: any
  /** Read one sandboxed text file (a material library). */
  readonly loadText?: (absolutePath: string) => Promise<string>
  /** Read one sandboxed binary file, so external loads can be aborted. */
  readonly loadBinary?: (absolutePath: string) => Promise<Blob>
  /** Declared image bytes accepted before decoding. */
  readonly textureBudget?: number
}

/** three.js objects are opaque here; their real types live in the lazy chunk. */
export type Object3D = any

/** Progress of a body read: bytes delivered, and the announced total when there is one. */
type Progress = (loaded: number, total: number | undefined) => void

/**
 * Files fetched ahead of three's loaders, kept as blob URLs.
 *
 * three's FileLoader/TextureLoader have no request signal, so a parse that is
 * abandoned halfway otherwise leaves network requests running. Reading the
 * external files through `loadBinary` (which is abortable) and handing three a
 * blob URL makes every external fetch cancellable, and lets a texture budget be
 * enforced before the GPU allocates anything.
 */
class Prefetch {
  private readonly urls = new Map<string, string>()
  private readonly load: ((absolutePath: string) => Promise<Blob>) | undefined
  private readonly budget: number | undefined
  private bytes = 0
  private disposed = false

  constructor(load: ((absolutePath: string) => Promise<Blob>) | undefined, budget: number | undefined) {
    this.load = load
    this.budget = budget
  }

  /**
   * The blob URL for a file already fetched.
   * @param path - absolute path inside the model directory.
   * @returns a blob URL, or undefined when the file was not prefetched.
   */
  get(path: string): string | undefined {
    return this.urls.get(path)
  }

  /**
   * Fetch one file and keep it alive as a blob URL.
   * @param path - absolute path inside the model directory.
   * @param image - whether the bytes count against the texture budget.
   */
  async add(path: string, image: boolean): Promise<void> {
    if (this.load === undefined || this.urls.has(path)) return
    const blob = await this.load(path)
    if (image && this.budget !== undefined) {
      this.bytes += blob.size
      if (this.bytes > this.budget) throw new PreviewError('model.texturesTooLarge')
    }
    this.urls.set(path, URL.createObjectURL(blob))
  }

  /** Revoke every blob URL; safe to call more than once. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
  }
}

/** Whether a rejection is an aborted fetch rather than a model problem. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'name' in error && (error as { name?: unknown }).name === 'AbortError'
}

/**
 * Build a loading manager that maps every external reference through the
 * sandbox. A blocked reference is an error: loading the geometry but silently
 * dropping textures would hide a file that tried to read outside its directory.
 * @param bundle - three.js module.
 * @param directory - the model's own directory.
 * @param prefetch - blob URLs to hand three instead of the file route.
 * @returns a manager for the model's loaders.
 */
function sandboxManager(bundle: ModelBundle, directory: string, prefetch?: Prefetch): any {
  const manager = new bundle.THREE.LoadingManager()
  const base = resourceBase(directory)
  manager.setURLModifier((url: string) => {
    const target = resourceTarget(url, base, directory)
    if (target.kind === 'blocked') throw new PreviewError('model.resourceOutside')
    if (target.kind === 'verbatim') return url
    const cached = prefetch?.get(target.path)
    if (cached !== undefined) return cached
    const resolved = fileUrl(target.path)
    if (resolved === undefined) throw new PreviewError('common.fileUrl')
    return resolved
  })
  return manager
}

/**
 * Install the decoders one glTF asked for.
 * @param loader - GLTF loader to configure.
 * @param options - decode context.
 * @param disposables - receives decoders that own workers.
 */
function configureDecoders(loader: any, options: ParseOptions, disposables: Array<{ dispose?: () => void }>): void {
  const extras = options.extras
  const needs = options.decoders
  if (extras === undefined || needs === undefined) return
  if (needs.meshopt && extras.MeshoptDecoder !== undefined) {
    loader.setMeshoptDecoder(extras.MeshoptDecoder)
  }
  if (needs.draco && extras.DRACOLoader !== undefined && options.assetBase !== undefined) {
    const decoder = new extras.DRACOLoader()
    decoder.setDecoderPath(options.assetBase)
    loader.setDRACOLoader(decoder)
    disposables.push(decoder)
  }
  if (needs.ktx2 && extras.KTX2Loader !== undefined && options.assetBase !== undefined && options.renderer !== undefined) {
    const transcoder = new extras.KTX2Loader()
    transcoder.setTranscoderPath(options.assetBase)
    transcoder.detectSupport(options.renderer)
    loader.setKTX2Loader(transcoder)
    disposables.push(transcoder)
  }
}

/**
 * Decode a glTF/GLB, sandboxing external buffers and textures.
 * @param bundle - three.js and the base loaders.
 * @param extension - `gltf` or `glb`.
 * @param bytes - the whole file.
 * @param options - decode context.
 * @returns the scene to add to the viewer.
 */
async function parseGltf(
  bundle: ModelBundle,
  extension: string,
  bytes: ArrayBuffer,
  options: ParseOptions,
): Promise<Object3D> {
  const directory = options.baseDir
  const json = gltfJson(bytes, extension)
  if (directory !== undefined) {
    // Fail before three starts fetching, so the pane can say what happened.
    const offending = unsafeGltfReference(json, directory)
    if (offending !== undefined) throw new PreviewError('model.resourceOutside')
  }
  if (options.textureBudget !== undefined && declaredImageBytes(json) > options.textureBudget) {
    throw new PreviewError('model.texturesTooLarge')
  }
  const prefetch = new Prefetch(options.loadBinary, options.textureBudget)
  const manager = directory === undefined ? undefined : sandboxManager(bundle, directory, prefetch)
  const loader = manager === undefined ? new bundle.GLTFLoader() : new bundle.GLTFLoader(manager)
  const disposables: Array<{ dispose?: () => void }> = []
  try {
    if (directory !== undefined && options.loadBinary !== undefined) {
      for (const reference of externalReferences(json)) {
        const resolved = resolveResource(directory, reference.uri)
        if (resolved === undefined) throw new PreviewError('model.resourceOutside')
        try {
          await prefetch.add(resolved, reference.kind === 'image')
        } catch (error) {
          // A missing texture should not reject the model; three still gets a
          // chance to load it through the normal route. A missing buffer is
          // fatal, and so is exceeding the texture budget.
          if (reference.kind === 'buffer'
            || isAbortError(error)
            || (error instanceof PreviewError && error.key === 'model.texturesTooLarge')) {
            throw error
          }
          console.warn('[dsh-any-preview] texture prefetch failed', resolved, error)
        }
      }
    }
    configureDecoders(loader, options, disposables)
    const path = directory === undefined ? '' : resourceBase(directory)
    const gltf = await loader.parseAsync(bytes, path)
    // glTF animations belong to the scene, but the parser returns them next to
    // it. Keep them on the root so the viewer can build a mixer without
    // changing the parse result type used by every other format.
    if (Array.isArray(gltf.animations) && gltf.animations.length > 0) {
      gltf.scene.userData.animations = gltf.animations
    }
    return gltf.scene
  } finally {
    prefetch.dispose()
    for (const decoder of disposables) {
      try {
        decoder.dispose?.()
      } catch {
        /* a decoder that already terminated its workers is fine */
      }
    }
  }
}

/**
 * Texture paths an MTL creator declared, for prefetching before it starts loads.
 * @param info - merged `materialsInfo` table.
 * @returns relative texture paths without duplicates.
 */
function mtlTexturePaths(info: any): readonly string[] {
  const paths = new Set<string>()
  const materials = info !== null && typeof info === 'object' ? Object.values(info) : []
  for (const material of materials) {
    if (material === null || typeof material !== 'object') continue
    for (const [key, value] of Object.entries(material as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      if (!/^(?:map_|bump|norm|disp|decal|refl)/iu.test(key)) continue
      const path = value.trim().replace(/^"(.*)"$/u, '$1')
      // Option-prefixed values (`-bm 1 file.png`) are rare; leave them to
      // MTLLoader rather than guessing how many option arguments they take.
      if (path === '' || path.startsWith('-')) continue
      paths.add(path)
    }
  }
  return [...paths]
}

/** What the material library produced, including texture prefetch failures. */
interface LoadedMaterials {
  readonly creator: any
  readonly texturesUnavailable: boolean
}

/**
 * Load the material libraries an OBJ names, merged into one creator.
 * @param bundle - three.js and the base loaders (the MTL loader rides with them).
 * @param options - decode context; must carry `baseDir` and `loadText`.
 * @param text - OBJ source.
 * @param manager - loading manager used for the MTL textures.
 * @param prefetch - blob cache the manager resolves through.
 * @returns the creator and whether any texture could not be fetched.
 */
async function loadMaterials(
  bundle: ModelBundle,
  options: ParseOptions,
  text: string,
  manager: any,
  prefetch: Prefetch,
): Promise<LoadedMaterials | undefined> {
  const directory = options.baseDir
  if (directory === undefined) return undefined
  const names = mtllibNames(text)
  if (names.length === 0) return undefined
  const loader = new bundle.MTLLoader(manager)
  const base = resourceBase(directory)
  const creators: any[] = []
  for (const name of names) {
    const resolved = resolveResource(directory, name)
    if (resolved === undefined) throw new PreviewError('model.resourceOutside')
    if (options.loadText === undefined) throw new PreviewError('model.materialsFailed')
    creators.push(loader.parse(await options.loadText(resolved), base))
  }
  const first = creators[0]
  if (first === undefined) return undefined
  // OBJ allows more than one mtllib; MTLLoader's creator reads a merged table.
  for (const extra of creators.slice(1)) Object.assign(first.materialsInfo, extra.materialsInfo)
  let texturesUnavailable = false
  for (const name of mtlTexturePaths(first.materialsInfo)) {
    const resolved = resolveResource(directory, name)
    if (resolved === undefined) {
      texturesUnavailable = true
      continue
    }
    try {
      await prefetch.add(resolved, true)
    } catch (error) {
      if (isAbortError(error)
        || (error instanceof PreviewError && error.key === 'model.texturesTooLarge')) {
        throw error
      }
      console.warn('[dsh-any-preview] texture prefetch failed', resolved, error)
      texturesUnavailable = true
    }
  }
  first.preload()
  return { creator: first, texturesUnavailable }
}

/**
 * Render both faces of every mesh.
 *
 * OBJ carries no side convention and exporters disagree about winding: a
 * clockwise file would otherwise be culled into an inside-out shell (the
 * workspace's own `samples/cube.obj` is wound inward). STL has the same
 * problem on some exports. glTF states `doubleSided`, so it is left alone.
 * @param root - parsed object to walk.
 * @param three - three.js module.
 */
function showBothSides(root: Object3D, three: any): void {
  root.traverse((child: any) => {
    if (child.isMesh !== true) return
    const materials = Array.isArray(child.material)
      ? child.material
      : child.material === undefined ? [] : [child.material]
    for (const material of materials) {
      if (material !== null && typeof material === 'object' && 'side' in material) {
        material.side = three.DoubleSide
      }
    }
  })
}

/**
 * Decode an OBJ, applying its material library when one is reachable.
 *
 * A material library that cannot be read degrades to the default material and
 * leaves a note; the geometry is still worth showing.
 * @param bundle - three.js and the base loaders.
 * @param bytes - the whole file.
 * @param options - decode context.
 * @returns the parsed object.
 */
async function parseObj(bundle: ModelBundle, bytes: ArrayBuffer, options: ParseOptions): Promise<Object3D> {
  const text = options.text ?? new TextDecoder().decode(bytes)
  const directory = options.baseDir
  const prefetch = new Prefetch(options.loadBinary, options.textureBudget)
  const manager = directory === undefined ? undefined : sandboxManager(bundle, directory, prefetch)
  if (manager !== undefined) manager.onLoad = () => prefetch.dispose()
  const objLoader = manager === undefined ? new bundle.OBJLoader() : new bundle.OBJLoader(manager)
  let materials: any
  let materialsUnavailable = false
  let texturesUnavailable = false
  if (directory !== undefined) {
    try {
      const loaded = await loadMaterials(bundle, options, text, manager, prefetch)
      if (loaded !== undefined) {
        materials = loaded.creator
        texturesUnavailable = loaded.texturesUnavailable
      }
    } catch (error) {
      if (isAbortError(error)
        || (error instanceof PreviewError && error.key === 'model.texturesTooLarge')) {
        prefetch.dispose()
        throw error
      }
      materialsUnavailable = true
    }
  }
  try {
    if (materials !== undefined) objLoader.setMaterials(materials)
    const object = objLoader.parse(text)
    showBothSides(object, bundle.THREE)
    object.userData.releaseBlobs = () => prefetch.dispose()
    if (materialsUnavailable) object.userData.materialsUnavailable = true
    if (texturesUnavailable) object.userData.texturesUnavailable = true
    return object
  } catch (error) {
    prefetch.dispose()
    throw error
  }
}

/**
 * Decode one model file into a scene object.
 * @param bundle - three.js and the base loaders.
 * @param extension - lowercase suffix without the dot.
 * @param bytes - the whole file.
 * @param options - decode context; omit for a self-contained, uncompressed model.
 * @returns the object to add to the scene.
 */
export async function parseModel(
  bundle: ModelBundle,
  extension: string,
  bytes: ArrayBuffer,
  options: ParseOptions = {},
): Promise<Object3D> {
  if (extension === 'glb' || extension === 'gltf') return parseGltf(bundle, extension, bytes, options)
  if (extension === 'obj') return parseObj(bundle, bytes, options)
  if (extension === 'stl') {
    const { THREE } = bundle
    // Facet normals in STL are frequently zero or inconsistent between
    // exporters (the workspace's `samples/tetra.stl` has twelve zero normals),
    // and a zero normal makes the Standard shader normalize to NaN and render
    // black. Recompute from the triangle winding instead; STL geometry is
    // non-indexed, so this gives flat per-face normals as the format intends.
    const geometry = new bundle.STLLoader().parse(bytes)
    geometry.computeVertexNormals()
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0xbfc4cc, metalness: 0.1, roughness: 0.7, side: THREE.DoubleSide,
    }))
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

/** What a scene object contains, for the viewer's info bar. */
export interface ModelStats {
  readonly vertices: number
  readonly triangles: number
  readonly materials: number
}

/**
 * Summarize a scene object.
 *
 * `InstancedMesh` counts once, as before; that is a budget for the buffers the
 * preview allocates, not an exact draw-call count.
 * @param root - scene object to walk.
 * @returns vertex, triangle and distinct-material totals.
 */
export function summarize(root: Object3D): ModelStats {
  let vertices = 0
  let triangles = 0
  const materials = new Set<any>()
  visit(root, (child) => {
    const material = child.material
    for (const one of Array.isArray(material) ? material : material === undefined ? [] : [material]) {
      if (one !== null && typeof one === 'object') materials.add(one)
    }
    if (child.isMesh !== true || child.geometry === undefined) return
    const geometry = child.geometry
    const index = typeof geometry.getIndex === 'function' ? geometry.getIndex() : null
    const position = typeof geometry.getAttribute === 'function' ? geometry.getAttribute('position') : undefined
    vertices += position?.count ?? 0
    triangles += index === null ? (position?.count ?? 0) / 3 : index.count / 3
  })
  return { vertices, triangles: Math.round(triangles), materials: materials.size }
}

/**
 * Count the triangles a scene object would submit.
 * @param root - scene object to walk.
 * @returns rounded triangle total.
 */
export function countTriangles(root: Object3D): number {
  return summarize(root).triangles
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
    // A skinned mesh owns a bone texture through its skeleton; disposing only
    // the geometry leaves that GPU texture behind on every animation reload.
    if (child.isSkinnedMesh === true) child.skeleton?.dispose?.()
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
