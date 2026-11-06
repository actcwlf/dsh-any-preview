/**
 * Model resource resolution: where an untrusted model may read from, and what
 * it needs before it can be decoded.
 *
 * glTF buffers/images and OBJ material libraries are references inside a file
 * that anyone can author. They are resolved against the model's own directory
 * and nothing above it: absolute URLs, drive letters, `..` segments and
 * percent-encoded traversal are all refused. The same rules are enforced in the
 * loader's URL modifier and unit-tested here.
 */

/** Scheme that stands in for the model's directory while three resolves URIs. */
export const RESOURCE_SCHEME = 'dsh-model-res://'

/** What one external reference resolves to. */
export type ResourceTarget =
  /** A path inside the model's directory, to be served by the file route. */
  | { readonly kind: 'absolute'; readonly path: string }
  /** A data or blob URI, which needs no file access. */
  | { readonly kind: 'verbatim' }
  /** Anything else: remote, absolute, or escaping the directory. */
  | { readonly kind: 'blocked' }

/** One external reference a file declares. */
interface Reference {
  readonly uri: unknown
}

/**
 * Directory-style parent of a path, with either separator.
 * @param path - absolute file path.
 * @returns the parent with forward slashes and no trailing slash, or an empty string.
 */
export function directoryOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const cut = normalized.lastIndexOf('/')
  if (cut < 0) return ''
  if (cut === 0) return '/'
  return normalized.slice(0, cut)
}

/**
 * Base three should resolve relative URIs against.
 * @param directory - the model's own directory.
 * @returns a sentinel prefix ending in `/`.
 */
export function resourceBase(directory: string): string {
  return `${RESOURCE_SCHEME}${directory.replaceAll('\\', '/').replace(/\/+$/u, '')}/`
}

/**
 * Resolve one relative reference inside a directory.
 * @param directory - directory the reference must stay under.
 * @param uri - reference as written in the model.
 * @returns the absolute path, or undefined when it is absolute or escapes.
 */
export function resolveResource(directory: string, uri: string): string | undefined {
  if (directory === '' || uri === '') return undefined
  // A fragment or query is not part of a file name.
  const [pathPart = ''] = uri.split(/[?#]/u)
  if (pathPart === '') return undefined
  // Absolute URLs and Windows drive letters both look like `scheme:`.
  if (/^[a-z][a-z0-9+.-]*:/iu.test(pathPart)) return undefined
  if (pathPart.startsWith('/') || pathPart.startsWith('\\')) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(pathPart)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  const segments: string[] = []
  for (const part of decoded.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // Popping past the start would leave the model's directory.
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(part)
  }
  if (segments.length === 0) return undefined
  const base = directory.replaceAll('\\', '/').replace(/\/+$/u, '')
  return `${base}/${segments.join('/')}`
}

/**
 * Classify a URL three resolved against the sentinel base.
 * @param url - URL handed to the loading manager.
 * @param base - sentinel prefix from {@link resourceBase}.
 * @param directory - the model's own directory.
 * @returns what the URL may read.
 */
export function resourceTarget(url: string, base: string, directory: string): ResourceTarget {
  if (url.startsWith('data:') || url.startsWith('blob:')) return { kind: 'verbatim' }
  if (!url.startsWith(base)) return { kind: 'blocked' }
  const path = resolveResource(directory, url.slice(base.length))
  return path === undefined ? { kind: 'blocked' } : { kind: 'absolute', path }
}

/**
 * Parse the JSON a glTF/GLB carries.
 * @param bytes - the whole file.
 * @param extension - `gltf` or `glb`.
 * @returns the parsed document, or undefined when it is not valid JSON.
 */
export function gltfJson(bytes: ArrayBuffer, extension: string): Record<string, any> | undefined {
  try {
    if (extension === 'gltf') {
      return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, any>
    }
    if (bytes.byteLength < 20) return undefined
    const view = new DataView(bytes)
    if (view.getUint32(0, true) !== 0x46546c67) return undefined // 'glTF'
    const length = view.getUint32(12, true)
    const type = view.getUint32(16, true)
    if (type !== 0x4e4f534a) return undefined // 'JSON'
    const start = 20
    const end = Math.min(bytes.byteLength, start + length)
    const text = new TextDecoder().decode(bytes.slice(start, end)).replace(/[\u0000\s]+$/u, '')
    return JSON.parse(text) as Record<string, any>
  } catch {
    return undefined
  }
}

/**
 * Extensions a glTF declares, required or merely used.
 * @param json - parsed glTF document.
 * @returns extension names, deduplicated.
 */
export function gltfExtensions(json: Record<string, any> | undefined): readonly string[] {
  const names = new Set<string>()
  for (const field of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list = json?.[field]
    if (!Array.isArray(list)) continue
    for (const name of list) {
      if (typeof name === 'string') names.add(name)
    }
  }
  return [...names]
}

/** Whether each optional capability is needed to decode a file. */
export interface ModelNeeds {
  readonly draco: boolean
  readonly ktx2: boolean
  readonly meshopt: boolean
  readonly materials: boolean
}

/** Nothing beyond the base three chunk is needed. */
export const NO_NEEDS: ModelNeeds = { draco: false, ktx2: false, meshopt: false, materials: false }

/**
 * What a model needs before it can be decoded.
 * @param extension - lowercase suffix without the dot.
 * @param bytes - the whole file (used for GLB/GLTF JSON and as an OBJ fallback).
 * @param text - decoded OBJ text, when the caller already has it.
 * @returns the required capabilities.
 */
export function modelNeeds(extension: string, bytes: ArrayBuffer, text?: string): ModelNeeds {
  if (extension === 'glb' || extension === 'gltf') {
    const extensions = new Set(gltfExtensions(gltfJson(bytes, extension)))
    return {
      draco: extensions.has('KHR_draco_mesh_compression'),
      ktx2: extensions.has('KHR_texture_basisu'),
      meshopt: extensions.has('EXT_meshopt_compression'),
      materials: false,
    }
  }
  if (extension === 'obj') {
    const materials = text !== undefined ? mtllibNames(text).length > 0 : containsAscii(bytes, 'mtllib')
    return { ...NO_NEEDS, materials }
  }
  return NO_NEEDS
}

/**
 * Material libraries an OBJ names.
 *
 * `mtllib` takes the rest of the line as a file name, so names with spaces are
 * kept whole; comments are ignored.
 * @param text - OBJ source.
 * @returns library names, in file order.
 */
export function mtllibNames(text: string): readonly string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    const stripped = line.replace(/#.*$/u, '').trim()
    const match = /^mtllib\s+(.+)$/iu.exec(stripped)
    const name = match?.[1]?.trim()
    if (name !== undefined && name !== '') names.push(name)
  }
  return names
}

/**
 * Whether an OBJ names a material library, without decoding the whole file.
 * @param bytes - OBJ bytes.
 * @param needle - ASCII text to look for.
 * @returns true when the byte sequence occurs.
 */
function containsAscii(bytes: ArrayBuffer, needle: string): boolean {
  const source = new Uint8Array(bytes)
  const target = new Uint8Array(needle.length)
  for (let index = 0; index < needle.length; index += 1) target[index] = needle.charCodeAt(index)
  const last = source.length - target.length
  for (let start = 0; start <= last; start += 1) {
    let matched = true
    for (let offset = 0; offset < target.length; offset += 1) {
      if (source[start + offset] !== target[offset]) { matched = false; break }
    }
    if (matched) return true
  }
  return false
}

/**
 * Find the first glTF reference that would read outside the model's directory.
 * @param json - parsed glTF document.
 * @param directory - the model's own directory; undefined means no sandbox.
 * @returns the offending URI, or undefined when every reference is safe.
 */
export function unsafeGltfReference(
  json: Record<string, any> | undefined,
  directory: string | undefined,
): string | undefined {
  if (json === undefined || directory === undefined) return undefined
  const lists = [json.buffers, json.images]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const entry of list as Reference[]) {
      const uri = entry?.uri
      if (typeof uri !== 'string' || uri === '') continue
      if (uri.startsWith('data:') || uri.startsWith('blob:')) continue
      if (resolveResource(directory, uri) === undefined) return uri
    }
  }
  return undefined
}
