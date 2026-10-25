/**
 * 3D model preview: three.js renderer with orbit controls.
 *
 * `loading: 'renderer'` because a model needs the whole file; the bytes come
 * from the shared file route (kernel/file-url.ts) rather than the byte pipeline,
 * which would hand them over as base64.
 */
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { fileUrl } from '../../kernel/file-url.ts'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'

/** Refuse models past this size: decoding costs several times the file size. */
const MAX_BYTES = 100 * 1024 * 1024

/** Models whose geometry exceeds this are refused rather than frozen. */
const MAX_TRIANGLES = 3_000_000

const VIEWER_EXTENSIONS = ['glb', 'gltf', 'obj', 'stl'] as const

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]!}`
}

function extensionOf(path: string): string {
  const name = path.replaceAll('\\', '/')
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Build the scene object for one decoded file. */
async function parseModel(extension: string, bytes: ArrayBuffer): Promise<THREE.Object3D> {
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
  throw new Error(`不支持的模型格式 .${extension}`)
}

/** Count triangles so an oversized mesh can be refused after parsing. */
function triangleCount(object: THREE.Object3D): number {
  let total = 0
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const geometry = child.geometry as THREE.BufferGeometry
    const index = geometry.getIndex()
    const position = geometry.getAttribute('position')
    total += index !== null ? index.count / 3 : (position?.count ?? 0) / 3
  })
  return Math.round(total)
}

/** Release every GPU resource the object owns. */
function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.geometry.dispose()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose()
      }
      material.dispose()
    }
  })
}

export function ModelBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  const meta = useResource?.(resourceAddress)?.value
  const absolutePath = meta?.absolutePath
  const version = meta?.version
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detail, setDetail] = useState('')
  const [triangles, setTriangles] = useState(0)
  const mountRef = useRef<HTMLDivElement | null>(null)
  const reported = useRef<string | undefined>(undefined)

  // Tell the owner the renderer has what it needs, once per version.
  useEffect(() => {
    if (content.kind !== 'renderer' || version === undefined) return
    if (reported.current === version) return
    reported.current = version
    content.loaded(version)
  }, [content, version])

  const url = typeof absolutePath === 'string' ? fileUrl(absolutePath) : undefined
  const extension = typeof absolutePath === 'string' ? extensionOf(absolutePath) : ''
  const size = meta?.size ?? 0

  useEffect(() => {
    const host = mountRef.current
    if (host === null || url === undefined) return
    if (size > MAX_BYTES) {
      setStatus('error')
      setDetail(`文件 ${formatBytes(size)} 超过 ${formatBytes(MAX_BYTES)} 上限`)
      return
    }

    let alive = true
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

    let model: THREE.Object3D | undefined
    const fail = (message: string): void => {
      if (!alive) return
      setStatus('error')
      setDetail(message)
    }

    void (async () => {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`读取失败（HTTP ${String(response.status)}）`)
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
          throw new Error(`网格约 ${count.toLocaleString('en-US')} 个三角形，超过预览上限`)
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
        fail(error instanceof Error ? error.message : '模型解析失败')
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
  }, [url, extension, size])

  return (
    <div style={PANE_ROOT}>
      <div style={barStyle}>
        <span>
          {typeof absolutePath === 'string' ? absolutePath.replaceAll('\\', '/').split('/').pop() : '3D 模型'}
          {triangles > 0 && ` · ${triangles.toLocaleString('en-US')} 三角形`}
        </span>
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>拖拽旋转 · 滚轮缩放</span>
      </div>
      <div style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }}>
        <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
        {status !== 'ready' && (
          <div style={{ ...PANE_FILL, background: 'transparent' }}>
            {status === 'loading' ? '正在加载模型…' : `无法预览：${detail}`}
          </div>
        )}
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
  padding: '6px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

/** One module per extension so the toolbar can still offer the text view. */
function module_(id: string, extensions: readonly string[], binary: readonly string[] | undefined, title: string): PreviewModule {
  return {
    id,
    extensions,
    ...(binary === undefined ? {} : { binary }),
    load: 'renderer',
    wrap: false,
    title: () => title,
    Body: ModelBody,
  }
}

export const glbPreview = module_('dsh-any-preview/glb', ['glb'], ['glb'], '3D 模型')
export const gltfPreview = module_('dsh-any-preview/gltf', ['gltf'], undefined, '3D 模型')
export const objPreview = module_('dsh-any-preview/obj', ['obj'], undefined, '3D 模型')
export const stlPreview = module_('dsh-any-preview/stl', ['stl'], undefined, '3D 模型')
