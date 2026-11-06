/**
 * The model viewer's WebGL lifecycle, extracted from the pane component.
 *
 * The hook owns everything that outlives a render: the lazy chunk, the
 * renderer scene, the whole-file read, decoding, framing, the on-demand render
 * loop and teardown. The component above it only renders words and buttons.
 *
 * Two cross-cutting rules live here:
 * - all visible state is keyed by `url#revision`, so a new file or a toolbar
 *   reload invalidates the previous load instead of mixing two files;
 * - the theme is not read once: `body[data-ds-dark-theme]` and the token
 *   variables on `body`/`html` are observed, and the canvas background, grid
 *   and wireframe colour follow a light/dark switch without reopening a file.
 */
import { PreviewError } from '../../kernel/errors.ts'
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
import type { GridSpec } from './frame.ts'
import { fileUrl } from '../../kernel/file-url.ts'
import { formatBytes } from '../../kernel/format.ts'
import { useDocument } from '../../kernel/useDocument.ts'
import type { ThreeBundle } from '../../../chunk/three.ts'
import type { PreviewBodyProps } from '../../kernel/types.ts'

/** Refuse models past this size: decoding costs several times the file size. */
const MAX_BYTES = LIMITS.modelBytes

/** Models whose geometry exceeds this are refused rather than frozen. */
const MAX_TRIANGLES = LIMITS.modelTriangles

/** Declared texture bytes accepted; decoded pixels can be several times larger. */
const MAX_TEXTURE_BYTES = LIMITS.modelTextureBytes

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
export interface ViewerSettings {
  readonly grid: boolean
  readonly wireframe: boolean
  readonly autoRotate: boolean
}

/** Defaults for a first open. */
const DEFAULT_SETTINGS: ViewerSettings = { grid: true, wireframe: false, autoRotate: false }

/** Imperative operations the toolbar drives. */
export interface ViewerHandle {
  apply(settings: ViewerSettings): void
  resetView(): void
}

/** What the pane shows for one file and revision; a different key is not shown. */
export interface ModelViewState {
  readonly status: 'loading' | 'ready' | 'error'
  /** Reading the file, or decoding/uploading it after the bytes arrived. */
  readonly phase: 'reading' | 'decoding'
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
export interface ModelProgress {
  readonly loaded: number
  readonly total: number | undefined
}

/** What the component above the hook receives. */
export interface ModelViewer {
  readonly view: ModelViewState
  readonly progress: ModelProgress | undefined
  readonly absolutePath: string | undefined
  readonly mountRef: { current: HTMLDivElement | null }
  readonly settings: ViewerSettings
  resetView(): void
  toggle(field: keyof ViewerSettings): void
  retry(): void
}

/** The `.obj`/COFF answer, tied to the URL it was read for. */
interface Probe {
  readonly url: string
  readonly ok: boolean
}

/** The view state plus the file identity it belongs to. */
interface KeyedView extends ModelViewState {
  readonly key: string
}

/** Progress plus the file identity it belongs to. */
interface KeyedProgress extends ModelProgress {
  readonly key: string
}

/** No file yet, or one this run has not settled: the pane is loading. */
const IDLE: ModelViewState = {
  status: 'loading', phase: 'reading', detail: '', triangles: 0, vertices: 0, materials: 0,
  width: 0, height: 0, depth: 0, note: '', retryable: true,
}

/** The empty keyed state. */
const EMPTY_VIEW: KeyedView = { key: '', ...IDLE }

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
 * Resolve one theme custom property to a CSS colour.
 *
 * `getComputedStyle` only substitutes `var()` for a real declaration, so a
 * throwaway element carries the token and the canvas follows the same surface
 * as the pane around it.
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
 * Read the viewport colours for the host's current theme.
 * @param THREE - three.js module.
 * @param host - element whose inherited tokens decide the surface.
 * @returns background and grid/wire colours.
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
 * Compare two theme snapshots by their rendered colours.
 * @param left - previous snapshot.
 * @param right - candidate snapshot.
 * @returns whether every colour is unchanged.
 */
function sameTheme(left: SceneTheme, right: SceneTheme): boolean {
  return left.background.getHexString() === right.background.getHexString()
    && left.gridMajor.getHexString() === right.gridMajor.getHexString()
    && left.gridMinor.getHexString() === right.gridMinor.getHexString()
    && left.wire.getHexString() === right.wire.getHexString()
}

/**
 * Turn any load failure into a localized sentence for the pane.
 *
 * The console keeps the original error (and its original language); the UI is
 * always localized, so an English three.js message never appears next to a
 * Chinese toolbar.
 * @param error - whatever the loader rejected with.
 * @returns a translation key's text.
 */
function failureText(error: unknown): string {
  if (error instanceof PreviewError) return t(error.key, error.params)
  const message = error instanceof Error ? error.message : String(error)
  if (/worker/iu.test(message)) return t('model.decoderWorkerBlocked')
  if (/draco|ktx2|basis|meshopt/iu.test(message)) return t('model.decoderUnavailable')
  if (/fetch|network|http|load(?:ing)?\s+(?:buffer|image|texture)/iu.test(message)) {
    return t('model.resourceFailed')
  }
  return t('model.parseFailed')
}

/**
 * Mount, load and tear down one model viewer.
 * @param content - what the document owner handed the body.
 * @param resourceAddress - address of the previewed file.
 * @param useResource - the owner's metadata hook, when available.
 * @returns the current view state plus the imperative toolbar operations.
 */
export function useModelViewer(
  content: PreviewBodyProps['content'],
  resourceAddress: string,
  useResource?: PreviewBodyProps['useResource'],
): ModelViewer {
  const { meta, absolutePath } = useDocument(content, resourceAddress, useResource)
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<KeyedView>(EMPTY_VIEW)
  const [probe, setProbe] = useState<Probe | null>(null)
  const [progress, setProgress] = useState<KeyedProgress | undefined>(undefined)
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
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    const host = mountRef.current
    if (host === null || url === undefined || formatOk === null) return

    const fail = (detail: string, retryable = true): void => {
      setProgress(undefined)
      setView({ ...IDLE, key, status: 'error', detail, retryable })
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
      } catch (error) {
        // The chunk is a capability: say it is unavailable, not that the model is bad.
        console.error('[dsh-any-preview] three chunk unavailable', error)
        if (alive) fail(t('model.chunkUnavailable'))
        return
      }
      if (!alive) return
      const THREE = bundle.THREE

      try {
        renderer = new THREE.WebGLRenderer({ antialias: true })
      } catch (error) {
        // No context is a normal outcome on remote desktops and blocklisted GPUs.
        // Throwing here would crash the slot entry and blank every later model.
        console.error('[dsh-any-preview] WebGL renderer creation failed', error)
        fail(t('model.webglUnavailable'))
        return
      }

      const scene = new THREE.Scene()
      let currentTheme = themeOf(THREE, host)
      scene.background = currentTheme.background
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
      // OBJ/MTL keep their native Phong materials, which do not receive the
      // scene environment; without a fill, a downward face has only the dark
      // hemisphere ground term and reads as black. A weak light from below
      // keeps undersides readable without flattening the key light.
      const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
      fillLight.position.set(0, -4, 2)
      scene.add(fillLight)

      let model: any
      let grid: any
      let gridSpec: GridSpec | undefined
      let radius = 0
      let framed = true
      let observer: ResizeObserver | undefined
      let themeObserver: MutationObserver | undefined
      let running = false
      let contextLost = false
      /** Unlit wire material, created on first use and shared by every mesh. */
      let wireMaterial: any
      /** Materials replaced while wireframe is on, so turning it off restores them. */
      const originalMaterials = new WeakMap<any, any>()

      const onContextLost = (event: Event): void => {
        // Keep the browser from trying to restore a context we cannot use; the
        // pane offers Retry, which rebuilds the renderer from scratch.
        event.preventDefault()
        contextLost = true
        running = false
        renderer.setAnimationLoop(null)
        console.warn('[dsh-any-preview] WebGL context lost')
        if (alive) fail(t('model.contextLost'))
      }
      renderer.domElement.addEventListener('webglcontextlost', onContextLost)

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
            color: currentTheme.wire,
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
        // Auto-rotate's first step is below OrbitControls' change epsilon, so
        // `changed` can be false on the frame that starts it. Keep the loop
        // alive while rotation is requested; stop only when it is off and the
        // camera has settled.
        if (!changed && !controls.autoRotate) {
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

      /**
       * Build (or rebuild) the floor grid from the current theme.
       * @param spec - extent, divisions and height measured from the model.
       * @returns the grid object added to the scene.
       */
      const buildGrid = (spec: GridSpec): any => {
        const next = new THREE.GridHelper(spec.size, spec.divisions, currentTheme.gridMajor, currentTheme.gridMinor)
        next.position.y = spec.y
        // Grid colours are picked for contrast, not tone-mapped into the scene.
        next.material.toneMapped = false
        scene.add(next)
        return next
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

      /**
       * Follow a light/dark switch while the pane is open.
       *
       * The host projects theme onto `body[data-ds-dark-theme]` plus token
       * variables on `body`/`html`; every one of those writes mutates an
       * attribute, so one observer covers a palette switch and a theme plugin.
       */
      const retheme = (): void => {
        const next = themeOf(THREE, host)
        if (sameTheme(currentTheme, next)) return
        currentTheme = next
        scene.background = next.background
        if (grid !== undefined && gridSpec !== undefined) {
          const visible = grid.visible
          scene.remove(grid)
          disposeObject(grid)
          grid = buildGrid(gridSpec)
          grid.visible = visible
        }
        wireMaterial?.color?.copy?.(next.wire)
        invalidate()
      }
      if (typeof MutationObserver !== 'undefined') {
        themeObserver = new MutationObserver(retheme)
        const html = host.ownerDocument.documentElement
        const body = host.ownerDocument.body
        themeObserver.observe(html, {
          attributes: true, attributeFilter: ['style', 'class', 'data-ds-theme-source'],
        })
        if (body !== null) {
          themeObserver.observe(body, {
            attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'],
          })
        }
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
        renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
        observer?.disconnect()
        themeObserver?.disconnect()
        controls.removeEventListener('start', stopFraming)
        controls.removeEventListener('change', invalidate)
        controls.dispose()
        // Restore the real materials first, so disposing the model frees them
        // rather than the wireframe stand-in.
        setWireframe(false)
        wireMaterial?.dispose?.()
        wireMaterial = undefined
        model?.userData?.releaseBlobs?.()
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
        // The download is done; from here the wait is decode and GPU upload,
        // which has no byte progress but is still worth naming.
        setProgress(undefined)
        setView({ ...IDLE, key, status: 'loading', phase: 'decoding' })
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

        const loadBinary = async (path: string): Promise<Blob> => {
          const fileSource = fileUrl(path)
          if (fileSource === undefined) throw new PreviewError('common.fileUrl')
          const binaryResponse = await fetch(fileSource, { signal: controller.signal })
          if (!binaryResponse.ok) {
            throw new PreviewError('common.httpError', { status: binaryResponse.status })
          }
          return binaryResponse.blob()
        }

        const object = await parseModel(bundle, extension, buffer, {
          text,
          baseDir,
          extras,
          decoders: needs,
          assetBase,
          renderer,
          loadBinary,
          loadText: async (path) => (await loadBinary(path)).text(),
          textureBudget: MAX_TEXTURE_BYTES,
        })
        if (!alive || contextLost) {
          object.userData?.releaseBlobs?.()
          disposeObject(object)
          return
        }
        const stats = summarize(object)
        if (stats.triangles > MAX_TRIANGLES) {
          object.userData?.releaseBlobs?.()
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
          gridSpec = gridForBox(extents.x, extents.z, box.min.y - sphere.center.y)
          grid = buildGrid(gridSpec)
        }

        viewerRef.current = viewer
        fit()
        apply(settingsRef.current)
        invalidate()
        setProgress(undefined)
        setView({
          key,
          status: 'ready',
          phase: 'reading',
          detail: '',
          triangles: stats.triangles,
          vertices: stats.vertices,
          materials: stats.materials,
          width: extents.x,
          height: extents.y,
          depth: extents.z,
          note: object.userData.texturesUnavailable === true
            ? t('model.texturesFailed')
            : object.userData.materialsUnavailable === true ? t('model.materialsFailed') : '',
          retryable: true,
        })
      } catch (error) {
        if (!alive || controller.signal.aborted) return
        // The console keeps the loader's original wording and language; the
        // pane only ever shows a localized sentence.
        console.error('[dsh-any-preview] model load failed', error)
        teardown()
        if (!contextLost) fail(failureText(error))
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

  const toggle = useCallback((field: keyof ViewerSettings): void => {
    const next = { ...settingsRef.current, [field]: !settingsRef.current[field] }
    settingsRef.current = next
    setSettings(next)
    viewerRef.current?.apply(next)
  }, [])

  const resetView = useCallback((): void => {
    viewerRef.current?.resetView()
  }, [])

  return {
    view: shown,
    progress: shownProgress,
    absolutePath,
    mountRef,
    settings,
    resetView,
    toggle,
    retry,
  }
}
