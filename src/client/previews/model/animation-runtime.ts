/**
 * One glTF animation clip the pane can play.
 */
export interface ModelAnimationInfo {
  readonly name: string
  readonly duration: number
}

/** Snapshot published to the animation bar. */
export interface AnimationSnapshot {
  readonly clips: readonly ModelAnimationInfo[]
  /** Active clip indexes, primary first where possible. */
  readonly active: readonly number[]
  readonly primary: number
  readonly playing: boolean
  /** Time of the primary clip. */
  readonly time: number
}

import { selectDefaultClips } from './animation.ts'
import { computeAnimatedBounds } from './animated-bounds.ts'

/**
 * Owns the mixer, actions, active set and playback clock for one model.
 *
 * The viewer hook only publishes snapshots and drives the render loop; keeping
 * the mutable animation state here makes it possible to test and to swap the
 * renderer without rebuilding the animation rules.
 */
export class AnimationRuntime {
  private mixer: any
  private readonly root: any
  private readonly actions: any[]
  private readonly clips: readonly ModelAnimationInfo[]
  private readonly active = new Set<number>()
  private primary = 0
  private playing = false

  /**
   * Build the runtime from raw glTF clips.
   * @param THREE - three.js module.
   * @param root - object the mixer binds to (the loaded glTF scene).
   * @param rawClips - three.js AnimationClip objects.
   */
  constructor(THREE: any, root: any, rawClips: readonly any[]) {
    this.root = root
    this.clips = rawClips.map((clip) => ({
      name: typeof clip?.name === 'string' ? clip.name : '',
      duration: Number.isFinite(clip?.duration) ? clip.duration : 0,
    }))
    this.mixer = new THREE.AnimationMixer(root)
    this.actions = rawClips.map((clip) => this.mixer.clipAction(clip))
    const trackSets = rawClips.map((clip) => Array.isArray(clip?.tracks)
      ? clip.tracks.map((track: any) => String(track?.name ?? ''))
      : [])
    const defaults = selectDefaultClips(trackSets)
    for (const index of defaults) this.active.add(index)
    this.primary = defaults[0] ?? 0
    this.playing = defaults.some((index) => (this.clips[index]?.duration ?? 0) > 0)
    for (const index of defaults) this.actions[index]?.reset().play()
    this.mixer.update(0)
  }

  /** Whether any active clip still has time to advance. */
  get isPlaying(): boolean {
    return this.playing
  }

  /** Whether any clip is selected at all. */
  get hasActive(): boolean {
    return this.active.size > 0
  }

  /** Current state for the UI. */
  snapshot(): AnimationSnapshot {
    this.ensurePrimary()
    return {
      clips: this.clips,
      active: [...this.active],
      primary: this.primary,
      playing: this.playing,
      time: this.actions[this.primary]?.time ?? 0,
    }
  }

  /** Advance every active action. */
  update(delta: number): void {
    this.mixer.update(delta)
  }

  /** Stop advancing without changing the active selection. */
  pause(): void {
    this.playing = false
  }

  /** Enable or disable one clip, keeping the current primary time. */
  toggleClip(index: number): void {
    if (this.actions[index] === undefined) return
    if (this.active.has(index)) {
      this.active.delete(index)
      this.actions[index].stop()
    } else {
      const resumeTime = this.active.size > 0 ? this.actions[this.primary]?.time ?? 0 : 0
      this.active.add(index)
      const action = this.actions[index]
      action.reset().play()
      action.time = Math.min(resumeTime, this.clips[index]?.duration ?? 0)
    }
    if (this.active.size === 0) {
      this.playing = false
    } else {
      this.ensurePrimary()
      if (this.playing && this.activeDuration() <= 0) this.playing = false
    }
    this.mixer.update(0)
  }

  /** Flip play/pause when at least one clip has a duration. */
  toggle(): void {
    if (this.active.size === 0 || this.activeDuration() <= 0) return
    this.playing = !this.playing
  }

  /** Seek every active clip; shorter clips clamp at their own end. */
  seek(time: number): void {
    if (this.active.size === 0) return
    const clamped = Math.min(
      Math.max(0, Number.isFinite(time) ? time : 0),
      this.activeDuration(),
    )
    for (const index of this.active) {
      const action = this.actions[index]
      if (action !== undefined) action.time = Math.min(clamped, this.clips[index]?.duration ?? 0)
    }
    this.mixer.update(0)
  }

  /**
   * Sample the active clips at their start, middle and end and return the
   * union of the deformed bounds. The original action times are restored.
   * @param THREE - three.js module, used by the bounds walker.
   * @param root - loaded model root.
   * @returns a box in root-parent space, or undefined without active clips.
   */
  sampleBounds(THREE: any, root: any): any | undefined {
    if (this.active.size === 0) return undefined
    const saved = new Map<number, number>()
    for (const index of this.active) {
      const action = this.actions[index]
      if (action !== undefined) saved.set(index, action.time)
    }
    const wasPlaying = this.playing
    let bounds: any
    try {
      const times = new Set<number>([0])
      for (const index of this.active) {
        const duration = this.clips[index]?.duration ?? 0
        if (duration <= 0) continue
        times.add(duration * 0.5)
        times.add(duration * 0.999)
      }
      for (const time of times) {
        for (const index of this.active) {
          const action = this.actions[index]
          if (action !== undefined) {
            action.time = Math.min(time, this.clips[index]?.duration ?? 0)
          }
        }
        this.mixer.update(0)
        const next = computeAnimatedBounds(THREE, root)
        bounds = bounds === undefined ? next : bounds.union(next)
      }
    } finally {
      for (const [index, time] of saved) {
        const action = this.actions[index]
        if (action !== undefined) action.time = time
      }
      this.mixer.update(0)
      this.playing = wasPlaying
    }
    return bounds
  }

  /** Longest duration among active clips. */
  private activeDuration(): number {
    let duration = 0
    for (const index of this.active) {
      duration = Math.max(duration, this.clips[index]?.duration ?? 0)
    }
    return duration
  }

  /** Keep the primary index pointing at an active clip. */
  private ensurePrimary(): void {
    if (this.active.has(this.primary)) return
    const first = this.active.values().next().value
    this.primary = first ?? 0
  }

  /** Release actions and the mixer; safe to call more than once. */
  dispose(): void {
    this.mixer?.stopAllAction?.()
    this.mixer?.uncacheRoot?.(this.root)
    this.actions.length = 0
    this.active.clear()
    this.playing = false
    this.mixer = undefined
  }
}
