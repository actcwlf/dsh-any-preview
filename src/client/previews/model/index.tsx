/**
 * 3D model preview: three.js renderer with orbit controls.
 *
 * `loading: 'renderer'` because a model needs the whole file; the bytes come
 * from the shared file route (kernel/file-url.ts) rather than the byte pipeline,
 * which would hand them over as base64.
 *
 * Everything the pane shows is keyed by the file and its content revision: a
 * new file, or the toolbar's reload, starts a fresh load instead of painting the
 * previous model under a new header, and a failed load can be retried in place.
 *
 * Decoders are a second lazy chunk: only a model that declares Draco/KTX2/
 * meshopt (or names an OBJ material library) loads it, and the wasm they need
 * is fetched from the asset route only when that decoder runs.
 */
import { PreviewError, errorText } from '../../kernel/errors.ts'
import { useLocale } from '../../useLocale.ts'
import { t } from '../../i18n.ts'
import { LIMITS } from '../../../shared/limits.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { readRange } from '../../kernel/zip.ts'
import { claimsFile } from '../dispatch.ts'
import { isChunkEnabled } from '../../kernel/chunk-policy.ts'
import { loadThree } from '../../kernel/three-loader.ts'
import { loadModelExtras } from '../../kernel/model-extras-loader.ts'
import { assetBaseUrl } from '../../kernel/assets.ts'
import { directoryOf, modelNeeds } from './resources.ts'
import { disposeObject, parseModel, readBody, summarize } from './decode.ts'
import type { ModelExtras } from './decode.ts'
import { frameForSphere, gridForBox } from './frame.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { PANE_FILL, PANE_ROOT } from '../../kernel/layout.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import type { ThreeBundle } from '../../../chunk/three.ts'
import type { PreviewBodyProps, PreviewModule } from '../../kernel/types.ts'

/** Refuse models past this size: decoding costs several times the file size. */
const MAX_BYTES = LIMITS.modelBytes

/** Models whose geometry exceeds this are refused rather than frozen. */
const MAX_TRIANGLES = LIMITS.modelTriangles

/** Unit direction the camera sits along, measured from the model's centre. */
const VIEW = ((): { x: number; y: number; z: number } => {
  const x = 1
  const y = 0.75
  const z = 1
  const length = Math.hypot(x, y, z)
  return { x: x / length, y: y / length, z: z / length }
})()

/** `.obj` names two formats; this is the head we probe. */
const PROBE_BYTES = 1023

/** Last progress update, so a fast stream does not re-render every chunk. */
const PROGRESS_INTERVAL_MS = 120

/** What the viewport can toggle without rebuilding the scene. */
interface ViewerSettings {
  readonly grid: boolean
  readonly wireframe: boolean
  readonly autoRotate: boolean
}

/** Defaults for a first open. */
const DEFAULT_SETTINGS: ViewerSettings = { grid: true, wireframe: false, autoRotate: false }

/** Imperative operations the toolbar drives. */
interface ViewerHandle {
  apply(settings: ViewerSettings): void
  resetView(): void
}

/** The `.obj`/COFF answer, tied to the URL it was read for. */
interface Probe {
  readonly url: string
  readonly ok: boolean
}

/** What the pane shows for one file and revision; a different key is not shown. */
interface ViewState {
  readonly key: string
  readonly status: 'loading' | 'ready' | 'error'
  readonly detail: string
  readonly triangles: number
  readonly vertices: number
  readonly materials: number
  readonly width: number
  readonly height: number
  readonly depth: number
  /** A non-fatal caveat, such as a material library that would not load. */
  readonly note: string
  /** Whether retrying could change the outcome (a size limit cannot). */
  readonly retryable: boolean
}

/** Bytes read so far, tied to the file they belong to. */
interface Progress {
  readonly key: string
  readonly loaded: number
  readonly total: number | undefined
}

/** No file yet, or one this run has not settled: the pane is loading. */
const IDLE: ViewState = {
  key: '', status: 'loading', detail: '', triangles: 0, vertices: 0, materials: 0,
  width: 0, height: 0, depth: 0, note: '', retryable: true,
}

/** Scene colours read from the host's theme tokens. */
interface SceneTheme {
  readonly background: any
  readonly gridMajor: any
  readonly gridMinor: any
  /** Wireframe lines: unlit, so they need a fixed contrast against the surface. */
  readonly wire: any
}

/**
 * Lowercase suffix of a path.
 * @param path - absolute path, either separator.
 * @returns suffix without the dot, or an empty string.
 */
function extensionOf(path: string): string {
  const name = path.replaceAll('\\', '/')
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Final path segment for display.
 * @param path - absolute path, either separator.
 * @returns the file name.
 */
function basenameOf(path: string): string {
  const name = path.replaceAll('\\', '/')
  return name.slice(name.lastIndexOf('/') + 1)
}

/**
 * Resolve one theme custom property to a CSS colour.
 *
 * `getComputedStyle` only substitutes `var()` for a real declaration, so a
 * throwaway element carries the token and the canvas follows the same light or
 * dark surface as the pane around it.
 * @param host - element whose inherited tokens to read.
 * @param property - custom property name, including `--`.
 * @param fallback - colour used when the token is absent.
 * @returns a CSS colour string.
 */
function resolveColor(host: HTMLElement, property: string, fallback: string): string {
  const view = host.ownerDocument.defaultView
  if (view === null) return fallback
  const probe = host.ownerDocument.createElement('span')
  probe.style.color = `var(${property}, ${fallback})`
  probe.style.display = 'none'
  host.appendChild(probe)
  const color = view.getComputedStyle(probe).color
  probe.remove()
  return color === '' ? fallback : color
}

/**
 * Pick a viewport that belongs to the host's current theme.
 * @param THREE - three.js module.
 * @param host - element whose tokens decide the surface.
 * @returns background and grid colours.
 */
function themeOf(THREE: ThreeBundle['THREE'], host: HTMLElement): SceneTheme {
  const background = new THREE.Color(resolveColor(host, '--dsw-alias-bg-base', '#101216'))
  // Colour components are linear here, so the threshold is on linear luminance.
  const luminance = background.r * 0.2126 + background.g * 0.7152 + background.b * 0.0722
  const light = luminance > 0.4
  // Fixed rather than derived from the surface: a background-relative grid
  // stayed a few percent off white in the light theme and read as almost gone.
  return {
    background,
    gridMajor: new THREE.Color(light ? 0x9aa1aa : 0x5f6672),
    gridMinor: new THREE.Color(light ? 0xd2d6db : 0x363c46),
    wire: new THREE.Color(light ? 0x2b3038 : 0xe3e7ec),
  }
}

/**
 * Compact length for the info bar; units are whatever the file uses.
 * @param value - model-space length.
 * @returns a short decimal string.
 */
function measure(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 100) return value.toFixed(0)
  if (abs >= 1) return value.toFixed(2).replace(/\.?0+$/u, '')
  if (abs >= 0.01) return value.toFixed(3).replace(/\.?0+$/u, '')
  return value.toExponential(1)
}

export function ModelBody({ content, resourceAddress, useResource }: PreviewBodyProps) {
  useLocale()
  const { meta, absolutePath } = useDocument(content, resourceAddress, useResource)
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<ViewState>(IDLE)
  const [probe, setProbe] = useState<Probe | null>(null)
  const [progress, setProgress] = useState<Progress | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [settings, setSettings] = useState<ViewerSettings>(DEFAULT_SETTINGS)
  const settingsRef = useRef<ViewerSettings>(DEFAULT_SETTINGS)
  const viewerRef = useRef<ViewerHandle | null>(null)

  const url = typeof absolutePath === 'string' ? fileUrl(absolutePath) : undefined
  const extension = typeof absolutePath === 'string' ? extensionOf(absolutePath) : ''
  const size = meta?.size ?? 0
  const revision = content.kind === 'renderer' ? content.revision : 0
  const key = `${url ?? ''}#${String(revision)}`
  const shown = view.key === key ? view : IDLE
  const formatOk = extension === 'obj'
    ? (probe !== null && probe.url === url ? probe.ok : null)
    : true
  const shownProgress = progress?.key === key ? progress : undefined

  // `.obj` also names a COFF object file; decide before parsing anything.
  useEffect(() => {
    if (url === undefined || extension !== 'obj' || probe?.url === url) return
    let alive = true
    const controller = new AbortController()
    void readRange(url, 0, PROBE_BYTES, controller.signal)
      .then((head) => {
        if (alive) setProbe({ url, ok: claimsFile('obj', head) })
      })
      .catch(() => {
        // A failed probe keeps the Wavefront path: the parse error is the better report.
        if (alive) setProbe({ url, ok: true })
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [url, extension, probe?.url])

  // Toolbar settings reach a viewer that may not exist yet; keep the latest.
  // The toggle handler applies immediately, so there is no second render here.
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    const host = mountRef.current
    if (host === null || url === undefined || formatOk === null) return

    const fail = (detail: string, retryable = true): void => {
      setProgress(undefined)
      setView({
        ...IDLE, key, status: 'error', detail, retryable,
      })
    }
    if (formatOk === false) {
      fail(t('model.notWavefront'), false)
      return
    }
    if (size > MAX_BYTES) {
      fail(t('model.tooLarge', { size: formatBytes(size), limit: formatBytes(MAX_BYTES) }), false)
      return
    }
    if (!isChunkEnabled('three')) {
      fail(t('model.disabled'), false)
      return
    }

    let alive = true
    let torndown = false
    let renderer: any
    let shutdown: (() => void) | undefined
    const controller = new AbortController()
    let lastProgress = 0

    const teardown = (): void => {
      if (torndown) return
      torndown = true
      if (shutdown !== undefined) {
        shutdown()
        return
      }
      // Setup stopped before the full shutdown was installed; still drop the canvas.
      renderer?.dispose?.()
      renderer?.forceContextLoss?.()
      renderer?.domElement?.remove?.()
    }

    void (async () => {
      let bundle: ThreeBundle
      try {
        bundle = await loadThree()
      } catch {
        // The chunk is a capability: say it is unavailable, not that the model is bad.
        if (alive) fail(t('model.chunkUnavailable'))
        return
      }
      if (!alive) return
      const THREE = bundle.THREE

      try {
        renderer = new THREE.WebGLRenderer({ antialias: true })
      } catch {
        // No context is a normal outcome on remote desktops and blocklisted GPUs.
        // Throwing here would crash the slot entry and blank every later model.
        fail(t('model.webglUnavailable'))
        return
      }

      const scene = new THREE.Scene()
      const theme = themeOf(THREE, host)
      scene.background = theme.background
      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      renderer.domElement.style.display = 'block'
      host.appendChild(renderer.domElement)

      // A neutral studio environment makes PBR metal and roughness read without
      // asking the user for an HDR file; it is optional, never fatal.
      let environment: any
      try {
        const pmrem = new THREE.PMREMGenerator(renderer)
        const room = new bundle.RoomEnvironment()
        const target = pmrem.fromScene(room, 0.04)
        scene.environment = target.texture
        pmrem.dispose()
        disposeObject(room)
        environment = target
      } catch {
        environment = undefined
      }

      const controls = new bundle.OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.autoRotateSpeed = 1.6
      // Lighting stays independent of the surface: the viewport colour follows
      // the theme, but a cool ground fill keeps shading readable on either one.
      scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.6))
      const keyLight = new THREE.DirectionalLight(0xffffff, 2)
      keyLight.position.set(3, 5, 4)
      scene.add(keyLight)

      let model: any
      let grid: any
      let radius = 0
      let framed = true
      let observer: ResizeObserver | undefined
      let running = false
      /** Unlit wire material, created on first use and shared by every mesh. */
      let wireMaterial: any
      /** Materials replaced while wireframe is on, so turning it off restores them. */
      const originalMaterials = new WeakMap<any, any>()

      /**
       * Swap every mesh's material for an unlit wireframe one.
       *
       * `material.wireframe` draws lines through the lit material, so a light
       * model on the light theme produced near-white one-device-pixel lines that
       * read as faint or dashed. An unlit material with a fixed contrast colour
       * renders the same pure-wireframe view, crisply.
       * @param on - whether wireframe is shown.
       */
      const setWireframe = (on: boolean): void => {
        if (model === undefined) return
        if (on) {
          wireMaterial ??= new THREE.MeshBasicMaterial({
            color: theme.wire,
            wireframe: true,
            toneMapped: false,
          })
          model.traverse((child: any) => {
            if (child.isMesh !== true || child.material === undefined) return
            if (!originalMaterials.has(child)) originalMaterials.set(child, child.material)
            child.material = Array.isArray(child.material)
              ? child.material.map(() => wireMaterial)
              : wireMaterial
          })
          return
        }
        model.traverse((child: any) => {
          const original = originalMaterials.get(child)
          if (original === undefined) return
          child.material = original
          originalMaterials.delete(child)
        })
      }

      /**
       * Render one frame and stop when damping/auto-rotation has settled.
       *
       * The pane used to run a 60 fps loop forever, even with the pointer at
       * rest; now a frame is only requested by a change.
       */
      const frame = (): void => {
        const changed = controls.update()
        renderer.render(scene, camera)
        if (!changed) {
          running = false
          renderer.setAnimationLoop(null)
        }
      }

      const invalidate = (): void => {
        if (running) return
        running = true
        renderer.setAnimationLoop(frame)
      }

      const fit = (): void => {
        if (radius <= 0) return
        const framing = frameForSphere(radius, camera.fov, camera.aspect)
        camera.position.set(VIEW.x * framing.distance, VIEW.y * framing.distance, VIEW.z * framing.distance)
        camera.near = framing.near
        camera.far = framing.far
        camera.updateProjectionMatrix()
        controls.target.set(0, 0, 0)
        controls.minDistance = radius * 1.1
        controls.maxDistance = framing.distance * 8
        controls.update()
        invalidate()
      }

      const resize = (): void => {
        const width = Math.max(1, host.clientWidth)
        const height = Math.max(1, host.clientHeight)
        renderer.setSize(width, height, false)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        // Refit only while the reader has not chosen a view of their own.
        if (framed) fit()
        else invalidate()
      }

      let viewer: ViewerHandle | undefined

      /**
       * Apply a toolbar toggle to the live scene.
       * @param next - the settings to show.
       */
      const apply = (next: ViewerSettings): void => {
        if (grid !== undefined) grid.visible = next.grid
        setWireframe(next.wireframe)
        controls.autoRotate = next.autoRotate
        invalidate()
      }

      viewer = {
        apply,
        resetView: (): void => {
          framed = true
          fit()
        },
      }

      resize()
      // Paint the themed surface once, even before a model exists.
      invalidate()
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(resize)
        observer.observe(host)
      }
      const stopFraming = (): void => { framed = false }
      controls.addEventListener('start', stopFraming)
      controls.addEventListener('change', invalidate)

      shutdown = (): void => {
        running = false
        renderer.setAnimationLoop(null)
        observer?.disconnect()
        controls.removeEventListener('start', stopFraming)
        controls.removeEventListener('change', invalidate)
        controls.dispose()
        // Restore the real materials first, so disposing the model frees them
        // rather than the wireframe stand-in.
        setWireframe(false)
        wireMaterial?.dispose?.()
        wireMaterial = undefined
        if (model !== undefined) disposeObject(model)
        if (grid !== undefined) disposeObject(grid)
        scene.environment = null
        environment?.dispose?.()
        scene.clear()
        renderer.dispose()
        renderer.forceContextLoss()
        renderer.domElement.remove()
        if (viewerRef.current === viewer) viewerRef.current = null
      }

      try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new PreviewError('common.httpError', { status: response.status })
        const bytes = await readBody(response, (loaded, total) => {
          if (!alive) return
          const now = performance.now()
          if (loaded !== total && now - lastProgress < PROGRESS_INTERVAL_MS) return
          lastProgress = now
          setProgress({ key, loaded, total })
        })
        if (!alive) return
        // The metadata size can be absent; the bytes themselves cannot lie.
        if (bytes.byteLength > MAX_BYTES) {
          throw new PreviewError('model.tooLarge', {
            size: formatBytes(bytes.byteLength), limit: formatBytes(MAX_BYTES),
          })
        }
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const text = extension === 'obj' ? new TextDecoder().decode(buffer) : undefined
        const needs = modelNeeds(extension, buffer, text)
        const baseDir = absolutePath === undefined ? undefined : directoryOf(absolutePath) || undefined

        let extras: ModelExtras | undefined
        let assetBase: string | undefined
        if (needs.draco || needs.ktx2 || needs.meshopt) {
          if (!isChunkEnabled('model-extras')) throw new PreviewError('model.decoderDisabled')
          try {
            extras = await loadModelExtras()
            assetBase = await assetBaseUrl()
          } catch (error) {
            console.warn('[dsh-any-preview] model decoders unavailable', error)
            throw new PreviewError('model.decoderUnavailable')
          }
        }

        const object = await parseModel(bundle, extension, buffer, {
          text,
          baseDir,
          extras,
          decoders: needs,
          assetBase,
          renderer,
          loadText: async (path) => {
            const fileSource = fileUrl(path)
            if (fileSource === undefined) throw new PreviewError('common.fileUrl')
            const textResponse = await fetch(fileSource, { signal: controller.signal })
            if (!textResponse.ok) throw new PreviewError('common.httpError', { status: textResponse.status })
            return textResponse.text()
          },
        })
        if (!alive) {
          disposeObject(object)
          return
        }
        const stats = summarize(object)
        if (stats.triangles > MAX_TRIANGLES) {
          disposeObject(object)
          throw new PreviewError('model.tooManyTriangles', {
            count: stats.triangles.toLocaleString('en-US'),
          })
        }

        // Centre the object and frame its bounding sphere, not its diagonal.
        const box = new THREE.Box3().setFromObject(object)
        const sphere = box.getBoundingSphere(new THREE.Sphere())
        object.position.sub(sphere.center)
        radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 0.5
        model = object
        scene.add(object)
        const extents = box.getSize(new THREE.Vector3())

        if (Number.isFinite(box.min.y)) {
          const spec = gridForBox(extents.x, extents.z, box.min.y - sphere.center.y)
          grid = new THREE.GridHelper(spec.size, spec.divisions, theme.gridMajor, theme.gridMinor)
          grid.position.y = spec.y
          // Grid colours are picked for contrast, not tone-mapped into the scene.
          grid.material.toneMapped = false
          scene.add(grid)
        }

        viewerRef.current = viewer
        fit()
        apply(settingsRef.current)
        invalidate()
        setProgress(undefined)
        setView({
          key,
          status: 'ready',
          detail: '',
          triangles: stats.triangles,
          vertices: stats.vertices,
          materials: stats.materials,
          width: extents.x,
          height: extents.y,
          depth: extents.z,
          note: object.userData.materialsUnavailable === true ? t('model.materialsFailed') : '',
          retryable: true,
        })
      } catch (error) {
        if (!alive || controller.signal.aborted) return
        teardown()
        fail(errorText(error, 'model.parseFailed'))
      }
    })()

    return () => {
      alive = false
      controller.abort()
      teardown()
    }
  }, [url, extension, size, key, formatOk, attempt])

  const retry = useCallback((): void => {
    setProbe(null)
    setProgress(undefined)
    setView({ ...IDLE, key })
    setAttempt((count) => count + 1)
  }, [key])

  const toggle = (field: keyof ViewerSettings): void => {
    const next = { ...settingsRef.current, [field]: !settingsRef.current[field] }
    settingsRef.current = next
    setSettings(next)
    viewerRef.current?.apply(next)
  }

  const ready = shown.status === 'ready'
  const loadingText = shownProgress === undefined
    ? t('model.loading')
    : shownProgress.total === undefined
      ? t('model.loadingBytes', { loaded: formatBytes(shownProgress.loaded) })
      : t('model.loadingProgress', {
        loaded: formatBytes(shownProgress.loaded),
        total: formatBytes(shownProgress.total),
      })
  const statsText = ready
    ? [
      shown.triangles > 0 ? t('model.triangles', { count: shown.triangles.toLocaleString('en-US') }) : '',
      shown.vertices > 0 ? t('model.vertices', { count: shown.vertices.toLocaleString('en-US') }) : '',
      shown.materials > 0 ? t('model.materials', { count: String(shown.materials) }) : '',
      shown.width > 0
        ? t('model.dimensions', { x: measure(shown.width), y: measure(shown.height), z: measure(shown.depth) })
        : '',
    ].join('')
    : ''
  const noteText = shown.note

  return (
    <div style={PANE_ROOT} data-model-status={shown.status}>
      <style>{TOOL_CSS}</style>
      <div style={barStyle}>
        <span style={titleStyle} title={typeof absolutePath === 'string' ? absolutePath : undefined}>
          {typeof absolutePath === 'string' ? basenameOf(absolutePath) : t('model.title')}
        </span>
        {statsText !== '' && <span style={statsStyle}>{statsText}</span>}
        <span style={toolsStyle}>
          <button
            type="button" className="dsh-model-tool" style={toolStyle} disabled={!ready}
            onClick={() => viewerRef.current?.resetView()}
            title={t('model.resetView')} data-model-tool="reset"
          >
            {t('model.resetView')}
          </button>
          <button
            type="button" className="dsh-model-tool" style={toolStyle} disabled={!ready}
            onClick={() => toggle('grid')}
            title={t('model.grid')} aria-pressed={settings.grid} data-model-tool="grid"
          >
            {t('model.grid')}
          </button>
          <button
            type="button" className="dsh-model-tool" style={toolStyle} disabled={!ready}
            onClick={() => toggle('wireframe')}
            title={t('model.wireframe')} aria-pressed={settings.wireframe} data-model-tool="wireframe"
          >
            {t('model.wireframe')}
          </button>
          <button
            type="button" className="dsh-model-tool" style={toolStyle} disabled={!ready}
            onClick={() => toggle('autoRotate')}
            title={t('model.autoRotate')} aria-pressed={settings.autoRotate} data-model-tool="auto-rotate"
          >
            {t('model.autoRotate')}
          </button>
        </span>
      </div>
      {noteText !== '' && <div style={noteStyle}>{noteText}</div>}
      <div
        style={{ position: 'relative', flex: '1 1 auto', minHeight: 0 }}
        title={t('model.hint')}
        aria-label={t('model.title')}
        role="group"
      >
        <div ref={mountRef} style={{ position: 'absolute', inset: 0 }} />
        {shown.status !== 'ready' && (
          // Transparent on purpose: the canvas (or the pane surface, before it
          // exists) is already the themed background the text was designed for.
          <div style={{ ...PANE_FILL, background: 'transparent' }}>
            {shown.status === 'loading'
              ? <span>{loadingText}</span>
              : (
                <div style={failureStyle} data-model-failure={shown.detail}>
                  <span style={failureTextStyle}>{t('common.error', { detail: shown.detail })}</span>
                  {shown.retryable && (
                    <button type="button" style={retryStyle} onClick={retry}>
                      {t('model.retry')}
                    </button>
                  )}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  )
}

const barStyle = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
  padding: '5px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const titleStyle = {
  minWidth: 0, maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis',
  whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary)',
} as const

const statsStyle = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  color: 'var(--dsw-alias-label-tertiary)', fontSize: 11,
} as const

const toolsStyle = {
  display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', flexWrap: 'wrap',
} as const

const toolStyle = {
  padding: '2px 7px', fontSize: 11, lineHeight: '16px', borderRadius: 'var(--dsw-radius-xs)',
} as const

/**
 * Button states live in CSS: inline styles cannot express `:hover`,
 * `:focus-visible` or `:disabled`, and the old 14% active tint on a hairline
 * border was too subtle to read as a pressed toggle.
 */
const TOOL_CSS = `
.dsh-model-tool {
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dsh-model-tool:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
}
.dsh-model-tool:active:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 15%, transparent);
}
.dsh-model-tool:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 1px;
}
.dsh-model-tool:disabled {
  opacity: 0.45;
  cursor: default;
}
.dsh-model-tool[aria-pressed="true"] {
  border-color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);
  color: var(--dsw-alias-label-primary);
}
`

const noteStyle = {
  padding: '4px 10px', fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
} as const

const failureStyle = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
  maxWidth: 360, padding: 16,
} as const

const failureTextStyle = { textAlign: 'center', lineHeight: 1.5 } as const

const retryStyle = {
  padding: '4px 12px', fontSize: 12, borderRadius: 'var(--dsw-radius-xs)',
  border: '0.5px solid var(--dsw-alias-border-l2)', background: 'transparent',
  color: 'var(--dsw-alias-label-primary)', cursor: 'pointer',
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
