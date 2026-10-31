/**
 * 3D model preview: three.js renderer with orbit controls.
 *
 * `loading: 'renderer'` because a model needs the whole file; the bytes come
 * from the shared file route (kernel/file-url.ts) rather than the byte pipeline,
 * which would hand them over as base64.
 */
import { PreviewError, errorText } from '../../kernel/errors.ts'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { LIMITS } from '../../../shared/limits.ts'
import { useEffect, useRef, useState } from 'react'
import { readRange } from '../../kernel/zip.ts'
import { claimsFile } from '../dispatch.ts'
import { isChunkEnabled } from '../../kernel/chunk-policy.ts'
import { loadThree } from '../../kernel/three-loader.ts'
import type { ThreeBundle } from '../../../chunk/three.ts'

// Filled by `loadThree()` before any model code runs.
let THREE: ThreeBundle['THREE']
let OrbitControls: ThreeBundle['OrbitControls']
let GLTFLoader: ThreeBundle['GLTFLoader']
let OBJLoader: ThreeBundle['OBJLoader']
let STLLoader: ThreeBundle['STLLoader']

/** three.js ships no typings in this package; these keep the signatures readable. */
type Object3D = any
type BufferGeometry = any
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'

/** Refuse models past this size: decoding costs several times the file size. */
const MAX_BYTES = LIMITS.modelBytes

/** Models whose geometry exceeds this are refused rather than frozen. */
const MAX_TRIANGLES = LIMITS.modelTriangles

const VIEWER_EXTENSIONS = ['glb', 'gltf', 'obj', 'stl'] as const

function extensionOf(path: string): string {
  const name = path.replaceAll('\\', '/')
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Build the scene object for one decoded file. */
async function parseModel(extension: string, bytes: ArrayBuffer): Promise<Object3D> {
  if (extension === 'glb' || extension === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(bytes, '')
    return gltf.scene
  }
  if (extension === 'obj') {
    return new OBJLoader().parse(new TextDecoder().decode(bytes))
  }
  if (extension === 'stl') {
    const geometry = new STLLoader().parse(bytes)
    geometry.computeVertexNormals()
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xbfc4cc, metalness: 0.1, roughness: 0.7 }))
  }
  throw new PreviewError('model.unsupported', { ext: extension })
}

/** Count triangles so an oversized mesh can be refused after parsing. */
function triangleCount(object: Object3D): number {
  let total = 0
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const geometry = child.geometry as BufferGeometry
    const index = geometry.getIndex()
    const position = geometry.getAttribute('position')
    total += index !== null ? index.count / 3 : (position?.count ?? 0) / 3
  })
  return Math.round(total)
}

/** Release every GPU resource the object owns. */
function disposeObject(root: Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.geometry.dispose()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      for (const value of Object.values(material as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) (value as { dispose(): void }).dispose()
      }
      material.dispose()
    }
  })
}

export function ModelBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  useLocale()
  const { meta, absolutePath } = useDocument(content, resourceAddress, useResource)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState('')
  const [triangles, setTriangles] = useState(0)
  const [chunkReady, setChunkReady] = useState(false)
  // .obj names two formats; null means the head has not been read yet.
  const [formatOk, setFormatOk] = useState<boolean | null>(null)
  const mountRef = useRef<HTMLDivElement | null>(null)

  const url = typeof absolutePath === 'string' ? fileUrl(absolutePath) : undefined
  const extension = typeof absolutePath === 'string' ? extensionOf(absolutePath) : ''
  const size = meta?.size ?? 0

  useEffect(() => {
    const host = mountRef.current
    if (host === null || url === undefined) return
      if (extension === 'obj' && formatOk === null) {
        void (async () => {
          try {
            setFormatOk(claimsFile('obj', await readRange(url, 0, 1023)))
          } catch {
            setFormatOk(true)
          }
        })()
        return
      }
      if (formatOk === false) {
        setStatus('error')
        setDetail(t('model.notWavefront'))
        return
      }

    if (size > MAX_BYTES) {
      setStatus('error')
      setDetail(t('model.tooLarge', { size: formatBytes(size), limit: formatBytes(MAX_BYTES) }))
      return
    }

    let alive = true
    // Gate on THREE itself: the assignments in .then happen before React
    // re-renders, so no state flag is needed and none can race.
    if (!isChunkEnabled('three')) {
      setStatus('error')
      setDetail(t('model.disabled'))
      return
    }
    if (THREE === undefined) {
      void loadThree()
        .then((three) => {
          THREE = three.THREE
          OrbitControls = three.OrbitControls
          GLTFLoader = three.GLTFLoader
          OBJLoader = three.OBJLoader
          STLLoader = three.STLLoader
          setChunkReady(true)
        })
        .catch((error: unknown) => {
          setStatus('error')
          setDetail(error instanceof Error ? error.message : String(error))
        })
      return
    }
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x14161c)
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 2)
    key.position.set(3, 5, 4)
    scene.add(key)
    const grid = new THREE.GridHelper(10, 10, 0x3a3f4b, 0x272b33)
    scene.add(grid)

    const resize = (): void => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize)
    observer?.observe(host)

    renderer.setAnimationLoop(() => {
      controls.update()
      renderer.render(scene, camera)
    })

    let model: Object3D | undefined
    const fail = (message: string): void => {
      if (!alive) return
      setStatus('error')
      setDetail(message)
    }

    void (async () => {
      try {
        const three = await loadThree()
        THREE = three.THREE
        OrbitControls = three.OrbitControls
        GLTFLoader = three.GLTFLoader
        OBJLoader = three.OBJLoader
        STLLoader = three.STLLoader
        const response = await fetch(url)
        if (!response.ok) throw new PreviewError('common.httpError', { status: response.status })
        const bytes = await response.arrayBuffer()
        if (!alive) return
        const object = await parseModel(extension, bytes)
        if (!alive) {
          disposeObject(object)
          return
        }
        const count = triangleCount(object)
        if (count > MAX_TRIANGLES) {
          disposeObject(object)
          throw new PreviewError('model.tooManyTriangles', { count: count.toLocaleString('en-US') })
        }
        model = object
        scene.add(object)

        // Frame the model: centre its bounding box and pull the camera back.
        const box = new THREE.Box3().setFromObject(object)
        const centre = box.getCenter(new THREE.Vector3())
        const extent = box.getSize(new THREE.Vector3()).length() || 1
        object.position.sub(centre)
        grid.position.y = -box.getSize(new THREE.Vector3()).y / 2
        camera.position.set(extent * 0.9, extent * 0.7, extent * 0.9)
        camera.near = Math.max(0.001, extent / 1000)
        camera.far = Math.max(1000, extent * 20)
        camera.updateProjectionMatrix()
        controls.target.set(0, 0, 0)
        controls.update()

        setTriangles(count)
        setStatus('ready')
      } catch (error) {
        fail(errorText(error, 'model.parseFailed'))
      }
    })()

    return () => {
      alive = false
      renderer.setAnimationLoop(null)
      observer?.disconnect()
      controls.dispose()
      if (model !== undefined) disposeObject(model)
      scene.clear()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }, [url, extension, size, chunkReady, formatOk])

  return (
    <div style={PANE_ROOT}>
      <div style={barStyle}>
        <span>
          {typeof absolutePath === 'string' ? absolutePath.replaceAll('\\', '/').split('/').pop() : t('model.title')}
          {triangles > 0 && t('model.triangles', { count: triangles.toLocaleString('en-US') })}
        </span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{t('model.hint')}</span>
      </div>
      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }}>
        <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
        {status !== 'ready' && (
          <div style={{ ...PANE_FILL, background: 'transparent' }}>
            {status === 'loading' ? t('model.loading') : t('common.error', { detail })}
          </div>
        )}
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

/** One module per extension so the toolbar can still offer the text view. */
function module_(id: string, extensions: readonly string[], binary: readonly string[] | undefined, title: () => string): PreviewModule {
  return {
    id,
    extensions,
    ...(binary === undefined ? {} : { binary }),
    load: 'renderer',
    wrap: false,
    title,
    Body: ModelBody,
  }
}

export const glbPreview = module_('dsh-any-preview/glb', ['glb'], ['glb'], () => t('model.title'))
export const gltfPreview = module_('dsh-any-preview/gltf', ['gltf'], undefined, () => t('model.title'))
export const objPreview = module_('dsh-any-preview/obj', ['obj'], undefined, () => t('model.title'))
export const stlPreview = module_('dsh-any-preview/stl', ['stl'], undefined, () => t('model.title'))
