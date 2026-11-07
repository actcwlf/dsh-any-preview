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
import { directoryOf } from './resources.ts'
import { modelNeedsFor } from './format.ts'
import { AnimationRuntime } from './animation-runtime.ts'
import type { AnimationSnapshot, ModelAnimationInfo } from './animation-runtime.ts'
import { ModelSceneRuntime } from './scene-runtime.ts'
import { enforceTextureBudget } from './texture-budget.ts'
import { themeOf } from './theme.ts'
import type { BackgroundMode } from './theme.ts'
import { disposeObject, parseModel, readBody, summarize } from './decode.ts'
import type { ModelExtras } from './decode.ts'
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

/** Decoded-image limits applied before three uploads a texture. */
const TEXTURE_BUDGET = {
  maxDimension: LIMITS.modelTextureDimension,
  maxPixels: LIMITS.modelTexturePixels,
}

/** `.obj` names two formats; this is the head we probe. */
const PROBE_BYTES = 1023

/** Last progress update, so a fast stream does not re-render every chunk. */
const PROGRESS_INTERVAL_MS = 120

/** The backdrop follows the host theme unless the reader overrides it. */
export type { BackgroundMode } from './theme.ts'

/** Boolean viewport toggles; background is a three-state cycle instead. */
export type ViewerToggle = 'grid' | 'wireframe' | 'autoRotate'

/** What the viewport can toggle without rebuilding the scene. */
export interface ViewerSettings {
  readonly grid: boolean
  readonly wireframe: boolean
  readonly autoRotate: boolean
  readonly background: BackgroundMode
}

/** Defaults for a first open. */
const DEFAULT_SETTINGS: ViewerSettings = {
  grid: true,
  wireframe: false,
  autoRotate: false,
  background: 'theme',
}

/** Imperative operations the toolbar drives. */
export interface ViewerHandle {
  apply(settings: ViewerSettings): void
  resetView(): void
  toggleAnimationClip(index: number): void
  toggleAnimation(): void
  seekAnimation(time: number): void
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

/** One glTF animation clip the pane can play. */
export type { ModelAnimationInfo } from './animation-runtime.ts'

/** What the component above the hook receives. */
export interface ModelViewer {
  readonly view: ModelViewState
  readonly progress: ModelProgress | undefined
  readonly absolutePath: string | undefined
  readonly mountRef: { current: HTMLDivElement | null }
  readonly settings: ViewerSettings
  readonly animations: readonly ModelAnimationInfo[]
  /** Clip indexes currently playing, primary first. */
  readonly animationActive: readonly number[]
  readonly animationPlaying: boolean
  readonly animationTime: number
  resetView(): void
  toggle(field: ViewerToggle): void
  retry(): void
  cycleBackground(): void
  toggleAnimationClip(index: number): void
  toggleAnimation(): void
  seekAnimation(time: number): void
}

/** Animation state plus the file identity it belongs to. */
interface AnimationState extends AnimationSnapshot {
  readonly key: string
}

/** No clips yet, or one this run has not settled. */
const EMPTY_ANIMATION: AnimationState = {
  key: '', clips: [], active: [], primary: 0, playing: false, time: 0,
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
  const [animation, setAnimation] = useState<AnimationState>(EMPTY_ANIMATION)

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
  const shownAnimation = animation.key === key ? animation : EMPTY_ANIMATION

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
    setAnimation({ key, clips: [], active: [], primary: 0, playing: false, time: 0 })

    let alive = true
    let torndown = false
    let runtime: ModelSceneRuntime | undefined
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
      runtime?.dispose()
      runtime = undefined
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

      let animator: AnimationRuntime | undefined
      let themeObserver: MutationObserver | undefined
      let lastUiUpdate = 0

      try {
        runtime = new ModelSceneRuntime(THREE, bundle, host, {
          onContextLost: (): void => {
            if (alive) fail(t('model.contextLost'))
          },
          isAnimating: (): boolean => animator?.isPlaying ?? false,
          onFrame: (delta: number): void => {
            if (animator === undefined) return
            try {
              animator.update(delta)
            } catch (error) {
              // A malformed clip should freeze the animation, not the render loop.
              console.warn('[dsh-any-preview] animation update failed', error)
              animator.pause()
              setAnimation({ key, ...animator.snapshot() })
              return
            }
            const now = performance.now()
            if (now - lastUiUpdate <= 100) return
            lastUiUpdate = now
            const snapshot = animator.snapshot()
            setAnimation((previous) => previous.key === key
              ? { ...previous, ...snapshot }
              : previous)
          },
        })
      } catch (error) {
        // No context is a normal outcome on remote desktops and blocklisted GPUs.
        // Throwing here would crash the slot entry and blank every later model.
        console.error('[dsh-any-preview] WebGL renderer creation failed', error)
        fail(t('model.webglUnavailable'))
        return
      }

      /**
       * Publish the current animation state to the bar.
       * @param time - override the primary clip time, for a seek or clip switch.
       */
      const publishAnimation = (time?: number): void => {
        const snapshot = animator?.snapshot()
        if (snapshot === undefined) {
          setAnimation({ key, clips: [], active: [], primary: 0, playing: false, time: 0 })
          return
        }
        setAnimation({
          key,
          ...snapshot,
          time: time ?? snapshot.time,
        })
      }

      let viewer: ViewerHandle | undefined

      viewer = {
        apply: (next: ViewerSettings): void => {
          runtime?.applySettings(next)
        },
        resetView: (): void => {
          runtime?.resetView()
        },
        toggleAnimationClip: (index: number): void => {
          if (animator === undefined) return
          animator.toggleClip(index)
          lastUiUpdate = 0
          publishAnimation()
          runtime?.requestRender()
        },
        toggleAnimation: (): void => {
          if (animator === undefined) return
          animator.toggle()
          publishAnimation()
          runtime?.requestRender()
        },
        seekAnimation: (time: number): void => {
          if (animator === undefined) return
          animator.seek(time)
          publishAnimation()
          runtime?.requestRender()
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
        // An explicit backdrop wins until the reader cycles back to "theme".
        if (settingsRef.current.background !== 'theme') return
        runtime?.applyTheme(themeOf(THREE, host))
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

      // The runtime paints the themed surface in its constructor.

      shutdown = (): void => {
        themeObserver?.disconnect()
        themeObserver = undefined
        animator?.dispose()
        animator = undefined
        const model = runtime?.detachModel()
        model?.userData?.releaseBlobs?.()
        if (model !== undefined) disposeObject(model)
        runtime?.dispose()
        runtime = undefined
        if (viewerRef.current === viewer) viewerRef.current = null
      }

      try {
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new PreviewError('common.httpError', { status: response.status })
        const announced = Number.parseInt(response.headers.get('content-length') ?? '', 10)
        if (Number.isFinite(announced) && announced > MAX_BYTES) {
          throw new PreviewError('model.tooLarge', {
            size: formatBytes(announced), limit: formatBytes(MAX_BYTES),
          })
        }
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
        const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer as ArrayBuffer
          : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        const text = extension === 'obj' ? new TextDecoder().decode(buffer) : undefined
        const needs = modelNeedsFor(extension, buffer, text)
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
          renderer: runtime?.renderer,
          loadBinary,
          loadText: async (path) => (await loadBinary(path)).text(),
          textureBudget: MAX_TEXTURE_BYTES,
        })
        if (!alive || (runtime?.isContextLost() ?? false)) {
          object.userData?.releaseBlobs?.()
          disposeObject(object)
          return
        }
        let texturesDownscaled = false
        try {
          texturesDownscaled = await enforceTextureBudget(object, TEXTURE_BUDGET)
        } catch (error) {
          // Best effort: an old browser without canvas/bitmap support keeps the
          // original textures rather than losing the model.
          console.warn('[dsh-any-preview] texture budget unavailable', error)
        }
        if (!alive || (runtime?.isContextLost() ?? false)) {
          object.userData?.releaseBlobs?.()
          disposeObject(object)
          return
        }
        if (texturesDownscaled) object.userData.texturesDownscaled = true
        const stats = summarize(object)
        if (stats.triangles > MAX_TRIANGLES) {
          object.userData?.releaseBlobs?.()
          disposeObject(object)
          throw new PreviewError('model.tooManyTriangles', {
            count: stats.triangles.toLocaleString('en-US'),
          })
        }

        // A skinned mesh's bounding volume is computed at bind pose; an
        // animation can move it outside that box, so culling would pop it away.
        object.traverse((child: any) => {
          if (child.isSkinnedMesh === true) child.frustumCulled = false
        })
        const animated = Array.isArray(object.userData.animations) ? object.userData.animations : []
        if (animated.length > 0) {
          try {
            animator = new AnimationRuntime(THREE, object, animated)
          } catch (error) {
            // A malformed clip should not hide the model; fall back to a still
            // preview and keep the original error in the console.
            console.warn('[dsh-any-preview] animation setup failed', error)
            animator?.dispose()
            animator = undefined
          }
        }

        // Frame the animation's full range, not just the bind pose. The pivot
        // uses the sampled centre, so an animation that lifts a limb or moves
        // the root stays in view when fit() runs.
        const initialBox = new THREE.Box3().setFromObject(object)
        let frameBox = initialBox
        if (animator !== undefined) {
          try {
            frameBox = animator.sampleBounds(THREE, object) ?? initialBox
          } catch (error) {
            console.warn('[dsh-any-preview] animation bounds failed', error)
          }
        }
        const sphere = frameBox.getBoundingSphere(new THREE.Sphere())
        const pivot = new THREE.Group()
        pivot.position.copy(sphere.center).multiplyScalar(-1)
        pivot.add(object)
        runtime?.attachModel(pivot, frameBox, sphere)
        if (typeof object.userData.releaseBlobs === 'function') {
          pivot.userData.releaseBlobs = object.userData.releaseBlobs
        }
        const snapshot = animator?.snapshot()
        setAnimation({
          key,
          ...(snapshot ?? { clips: [], active: [], primary: 0, playing: false, time: 0 }),
        })
        const extents = initialBox.getSize(new THREE.Vector3())
        viewerRef.current = viewer
        runtime?.fit()
        runtime?.applySettings(settingsRef.current)
        runtime?.requestRender()
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
            : object.userData.materialsUnavailable === true
              ? t('model.materialsFailed')
              : texturesDownscaled ? t('model.texturesDownscaled') : '',
          retryable: true,
        })
      } catch (error) {
        if (!alive || controller.signal.aborted) return
        // The console keeps the loader's original wording and language; the
        // pane only ever shows a localized sentence.
        console.error('[dsh-any-preview] model load failed', error)
        teardown()
        if (!(runtime?.isContextLost() ?? false)) fail(failureText(error))
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
    setAnimation({ key, clips: [], active: [], primary: 0, playing: false, time: 0 })
    setAttempt((count) => count + 1)
  }, [key])

  const toggle = useCallback((field: ViewerToggle): void => {
    const next = { ...settingsRef.current, [field]: !settingsRef.current[field] }
    settingsRef.current = next
    setSettings(next)
    viewerRef.current?.apply(next)
  }, [])

  const cycleBackground = useCallback((): void => {
    const current = settingsRef.current.background
    const background: BackgroundMode = current === 'theme'
      ? 'light'
      : current === 'light' ? 'dark' : 'theme'
    const next = { ...settingsRef.current, background }
    settingsRef.current = next
    setSettings(next)
    viewerRef.current?.apply(next)
  }, [])

  const resetView = useCallback((): void => {
    viewerRef.current?.resetView()
  }, [])

  const toggleAnimationClip = useCallback((index: number): void => {
    viewerRef.current?.toggleAnimationClip(index)
  }, [])

  const toggleAnimation = useCallback((): void => {
    viewerRef.current?.toggleAnimation()
  }, [])

  const seekAnimation = useCallback((time: number): void => {
    viewerRef.current?.seekAnimation(time)
  }, [])

  return {
    view: shown,
    progress: shownProgress,
    absolutePath,
    mountRef,
    settings,
    animations: shownAnimation.clips,
    animationActive: shownAnimation.active,
    animationPlaying: shownAnimation.playing,
    animationTime: shownAnimation.time,
    resetView,
    toggle,
    retry,
    cycleBackground,
    toggleAnimationClip,
    toggleAnimation,
    seekAnimation,
  }
}
