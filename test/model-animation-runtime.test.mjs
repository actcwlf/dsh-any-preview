/** AnimationRuntime: default layering, play/pause and seek without a renderer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AnimationRuntime } from '../src/client/previews/model/animation-runtime.ts'

class FakeMixer {
  constructor(root) {
    this.root = root
    this.actions = []
  }

  clipAction(clip) {
    const action = {
      clip,
      time: 0,
      playing: false,
      reset() {
        this.time = 0
        this.playing = true
        return this
      },
      play() {
        this.playing = true
        return this
      },
      stop() {
        this.playing = false
        return this
      },
    }
    this.actions.push(action)
    return action
  }

  update() {}

  stopAllAction() {
    for (const action of this.actions) action.playing = false
  }

  uncacheRoot() {}
}

const THREE = { AnimationMixer: FakeMixer }

function clip(name, duration, tracks) {
  return { name, duration, tracks: tracks.map((trackName) => ({ name: trackName })) }
}

function build() {
  const root = { name: 'root' }
  const runtime = new AnimationRuntime(THREE, root, [
    clip('body', 10, ['root.quaternion', 'arm.quaternion', 'leg.quaternion']),
    clip('face', 10, ['mesh.morphTargetInfluences']),
  ])
  return runtime
}

test('body and facial clips start together', () => {
  const runtime = build()
  const snapshot = runtime.snapshot()
  assert.deepEqual(snapshot.active, [0, 1])
  assert.equal(snapshot.primary, 0)
  assert.equal(snapshot.playing, true)
  assert.equal(runtime.isPlaying, true)
})

test('seek moves every active action but reports the primary time', () => {
  const runtime = build()
  runtime.seek(4.5)
  assert.equal(runtime.snapshot().time, 4.5)
  runtime.toggle()
  assert.equal(runtime.isPlaying, false)
  runtime.toggle()
  assert.equal(runtime.isPlaying, true)
})

test('disabling the last clip stops playback', () => {
  const runtime = build()
  runtime.toggleClip(1)
  assert.deepEqual(runtime.snapshot().active, [0])
  runtime.toggleClip(0)
  const snapshot = runtime.snapshot()
  assert.deepEqual(snapshot.active, [])
  assert.equal(snapshot.playing, false)
  runtime.toggle()
  assert.equal(runtime.snapshot().playing, false)
})
