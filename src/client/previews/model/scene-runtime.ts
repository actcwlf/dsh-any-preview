/**
 * Renderer, scene, camera, controls, lighting and grid for one model pane.
 *
 * The React hook keeps the loading and animation state; this class owns the
 * imperative WebGL lifecycle. Keeping it outside the hook makes teardown and
 * background/theme changes testable and keeps the viewer effect from growing
 * into a renderer, a theme controller and an animation controller at once.
 */
import type { ThreeBundle } from '../../../chunk/three.ts'
import { disposeObject } from './decode.ts'
import { frameForSphere, gridForBox } from './frame.ts'
import type { GridSpec } from './frame.ts'
import { sameTheme, sceneThemeFor, themeOf } from './theme.ts'
import type { BackgroundMode, SceneTheme } from './theme.ts'

/** View-only settings the toolbar can change without rebuilding the scene. */
export interface SceneSettings {
  readonly grid: boolean
  readonly wireframe: boolean
  readonly autoRotate: boolean
  readonly background: BackgroundMode
}

/** Callbacks the viewer hook supplies to the render loop. */
export interface SceneRuntimeOptions {
  /** Fired once when WebGL loses its context. */
  onContextLost(): void
  /** Whether an animation still needs frames. */
  isAnimating(): boolean
  /** Advance animation state before each rendered frame. */
  onFrame(delta: number): void
}

/** Unit direction the camera sits along, measured from the model's centre. */
const VIEW = ((): { x: number; y: number; z: number } => {
  const x = 1
  const y = 0.75
  const z = 1
  const length = Math.hypot(x, y, z)
  return { x: x / length, y: y / length, z: z / length }
})()

/** Owns everything needed to draw a model until the pane is torn down. */
export class ModelSceneRuntime {
  readonly scene: any
  readonly camera: any
  readonly renderer: any
  readonly controls: any

  private readonly THREE: ThreeBundle['THREE']
  private readonly host: HTMLElement
  private readonly options: SceneRuntimeOptions
  private readonly environment: any
  private readonly originalMaterials = new WeakMap<any, any>()
  private wireMaterial: any
  private grid: any
  private gridSpec: GridSpec | undefined
  private model: any
  private radius = 0
  private currentTheme: SceneTheme
  private contextLost = false
  private running = false
  private framed = true
  private lastFrame = 0
  private observer: ResizeObserver | undefined

  /**
   * Build the renderer and its theme-matched scene.
   * @param THREE - three.js module.
   * @param bundle - three.js loaders/addons for this build.
   * @param host - element the canvas is appended to.
   * @param options - context-loss and frame callbacks.
   */
  constructor(
    THREE: ThreeBundle['THREE'],
    bundle: ThreeBundle,
    host: HTMLElement,
    options: SceneRuntimeOptions,
  ) {
    this.THREE = THREE
    this.host = host
    this.options = options
    this.scene = new THREE.Scene()
    this.currentTheme = themeOf(THREE, host)
    this.scene.background = this.currentTheme.background

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.display = 'block'
    host.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000)
    this.controls = new bundle.OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.autoRotateSpeed = 1.6
    this.controls.addEventListener('start', this.stopFraming)
    this.controls.addEventListener('change', this.requestRender)

    // A neutral studio environment makes PBR metal and roughness read without
    // asking the user for an HDR file; it is optional, never fatal.
    let environment: any
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer)
      const room = new bundle.RoomEnvironment()
      const target = pmrem.fromScene(room, 0.04)
      this.scene.environment = target.texture
      pmrem.dispose()
      disposeObject(room)
      environment = target
    } catch {
      environment = undefined
    }
    this.environment = environment

    // Lighting stays independent of the surface: the viewport colour follows
    // the theme, but a cool ground fill keeps shading readable on either one.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.6))
    const keyLight = new THREE.DirectionalLight(0xffffff, 2)
    keyLight.position.set(3, 5, 4)
    this.scene.add(keyLight)
    // OBJ/MTL keep native Phong materials, which do not receive the scene
    // environment; without a fill, a downward face has only the dark
    // hemisphere ground term and reads as black.
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
    fillLight.position.set(0, -4, 2)
    this.scene.add(fillLight)

    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost)
    this.resize()
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize())
      this.observer.observe(host)
    }
    this.requestRender()
  }

  /** Attach the parsed object and size the floor grid to its initial box. */
  attachModel(model: any, box: any, sphere: any): void {
    this.model = model
    this.scene.add(model)
    this.setBounds(box, sphere)
  }

  /**
   * Recompute radius and grid from a bounding box. The hook calls this again
   * after sampling animation poses so animated limbs are not framed away.
   */
  setBounds(box: any, sphere: any): void {
    this.radius = Number.isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 0.5
    const extents = box.getSize(new this.THREE.Vector3())
    if (Number.isFinite(box.min.y)) {
      this.gridSpec = gridForBox(extents.x, extents.z, box.min.y - sphere.center.y)
      this.rebuildGrid()
    }
  }

  /** Apply the toolbar settings, including the three-state background. */
  applySettings(settings: SceneSettings): void {
    this.applyTheme(sceneThemeFor(this.THREE, this.host, settings.background))
    if (this.grid !== undefined) this.grid.visible = settings.grid
    this.setWireframe(settings.wireframe)
    this.controls.autoRotate = settings.autoRotate
    this.requestRender()
  }

  /** Apply a new theme snapshot (host theme change or explicit backdrop). */
  applyTheme(next: SceneTheme): void {
    if (sameTheme(this.currentTheme, next)) return
    this.currentTheme = next
    this.scene.background = next.background
    this.rebuildGrid()
    this.wireMaterial?.color?.copy?.(next.wire)
    this.requestRender()
  }

  /** Fit the camera to the current bounding sphere. */
  fit(): void {
    if (this.radius <= 0) return
    const framing = frameForSphere(this.radius, this.camera.fov, this.camera.aspect)
    this.camera.position.set(VIEW.x * framing.distance, VIEW.y * framing.distance, VIEW.z * framing.distance)
    this.camera.near = framing.near
    this.camera.far = framing.far
    this.camera.updateProjectionMatrix()
    this.controls.target.set(0, 0, 0)
    this.controls.minDistance = this.radius * 1.1
    this.controls.maxDistance = framing.distance * 8
    this.controls.update()
    this.requestRender()
  }

  /** Reset the framing flag and fit, used by the toolbar reset button. */
  resetView(): void {
    this.framed = true
    this.fit()
  }

  /** Whether WebGL context loss already failed this pane. */
  isContextLost(): boolean {
    return this.contextLost
  }

  /** Request one render, starting the on-demand loop when needed. */
  requestRender = (): void => {
    if (this.contextLost || this.running) return
    this.running = true
    this.renderer.setAnimationLoop(this.frame)
  }

  /** Remove and return the attached model so the hook can release its blobs. */
  detachModel(): any {
    const model = this.model
    if (model !== undefined) {
      // Restore real materials before the hook disposes the object; otherwise
      // the shared wireframe material is what gets disposed and the originals
      // leak with the detached mesh.
      this.setWireframe(false)
      this.scene.remove(model)
    }
    this.model = undefined
    return model
  }

  /** Stop loops, dispose GPU resources and remove the canvas. */
  dispose(): void {
    this.running = false
    this.renderer.setAnimationLoop(null)
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost)
    this.observer?.disconnect()
    this.observer = undefined
    this.controls.removeEventListener('start', this.stopFraming)
    this.controls.removeEventListener('change', this.requestRender)
    this.controls.dispose()
    this.setWireframe(false)
    this.wireMaterial?.dispose?.()
    this.wireMaterial = undefined
    if (this.grid !== undefined) {
      this.scene.remove(this.grid)
      disposeObject(this.grid)
      this.grid = undefined
    }
    this.scene.environment = null
    this.environment?.dispose?.()
    this.scene.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }

  private handleContextLost = (event: Event): void => {
    // Keep the browser from trying to restore a context we cannot use; the
    // pane offers Retry, which rebuilds the renderer from scratch.
    event.preventDefault()
    this.contextLost = true
    this.running = false
    this.renderer.setAnimationLoop(null)
    console.warn('[dsh-any-preview] WebGL context lost')
    this.options.onContextLost()
  }

  private stopFraming = (): void => {
    this.framed = false
  }

  private frame = (time?: number): void => {
    const now = typeof time === 'number' ? time : performance.now()
    const delta = this.lastFrame === 0 ? 0 : Math.min((now - this.lastFrame) / 1000, 0.1)
    this.lastFrame = now
    const animating = this.options.isAnimating()
    if (animating) this.options.onFrame(delta)
    const changed = this.controls.update()
    this.renderer.render(this.scene, this.camera)
    // Auto-rotate's first step is below OrbitControls' change epsilon, so
    // `changed` can be false on the frame that starts it. Keep the loop alive
    // while rotation or an animation is requested; stop only when both are off
    // and the camera has settled.
    if (!changed && !this.controls.autoRotate && !this.options.isAnimating()) {
      this.running = false
      this.lastFrame = 0
      this.renderer.setAnimationLoop(null)
    }
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth)
    const height = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    // Refit only while the reader has not chosen a view of their own.
    if (this.framed) this.fit()
    else this.requestRender()
  }

  private rebuildGrid(): void {
    if (this.gridSpec === undefined) return
    const visible = this.grid?.visible ?? true
    if (this.grid !== undefined) {
      this.scene.remove(this.grid)
      disposeObject(this.grid)
    }
    const next = new this.THREE.GridHelper(
      this.gridSpec.size,
      this.gridSpec.divisions,
      this.currentTheme.gridMajor,
      this.currentTheme.gridMinor,
    )
    next.position.y = this.gridSpec.y
    next.material.toneMapped = false
    next.visible = visible
    this.scene.add(next)
    this.grid = next
  }

  private setWireframe(on: boolean): void {
    if (this.model === undefined) return
    if (on) {
      this.wireMaterial ??= new this.THREE.MeshBasicMaterial({
        color: this.currentTheme.wire,
        wireframe: true,
        toneMapped: false,
      })
      this.model.traverse((child: any) => {
        if (child.isMesh !== true || child.material === undefined) return
        if (!this.originalMaterials.has(child)) this.originalMaterials.set(child, child.material)
        child.material = Array.isArray(child.material)
          ? child.material.map(() => this.wireMaterial)
          : this.wireMaterial
      })
      return
    }
    this.model.traverse((child: any) => {
      const original = this.originalMaterials.get(child)
      if (original === undefined) return
      child.material = original
      this.originalMaterials.delete(child)
    })
  }
}
