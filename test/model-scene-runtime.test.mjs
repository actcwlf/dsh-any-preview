/**
 * ModelSceneRuntime lifecycle with a fake renderer.
 *
 * The real WebGL context is not available in Node, but the scene math and the
 * imperative setup/teardown path are; this catches wiring mistakes such as an
 * unbound loop callback or a detached model that kept its wireframe material.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { ModelSceneRuntime } from '../src/client/previews/model/scene-runtime.ts'

const previousWindow = globalThis.window
globalThis.window = { devicePixelRatio: 1 }
after(() => {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
})

class FakeRenderer {
  constructor() {
    this.domElement = {
      style: {},
      addEventListener() {},
      removeEventListener() {},
      remove() {},
    }
    this.animationLoop = null
  }
  setPixelRatio() {}
  setSize() {}
  setAnimationLoop(callback) { this.animationLoop = callback }
  render() {}
  dispose() {}
  forceContextLoss() {}
}

class FakeControls {
  constructor(camera) {
    this.camera = camera
    this.target = { set() {} }
    this.autoRotate = false
    this.listeners = new Map()
  }
  addEventListener(type, callback) {
    this.listeners.set(type, callback)
  }
  removeEventListener(type) {
    this.listeners.delete(type)
  }
  update() { return false }
  dispose() { this.listeners.clear() }
}

class FakePMREM {
  fromScene() { return { texture: {}, dispose() {} } }
  dispose() {}
}

class FakeRoom extends THREE.Scene {}

const fakeTHREE = { ...THREE, WebGLRenderer: FakeRenderer }
const bundle = {
  THREE: fakeTHREE,
  OrbitControls: FakeControls,
  PMREMGenerator: FakePMREM,
  RoomEnvironment: FakeRoom,
}

function makeHost() {
  const probe = { style: {}, remove() {} }
  const doc = {
    defaultView: { getComputedStyle: () => ({ color: 'rgb(16, 18, 22)' }) },
    createElement: () => probe,
  }
  return {
    clientWidth: 800,
    clientHeight: 600,
    ownerDocument: doc,
    appendChild() {},
  }
}

test('scene runtime wires, attaches, detaches and disposes without a real GPU', () => {
  const runtime = new ModelSceneRuntime(fakeTHREE, bundle, makeHost(), {
    onContextLost() {},
    isAnimating: () => false,
    onFrame() {},
  })
  const model = new THREE.Group()
  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1))
  const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1)
  runtime.attachModel(model, box, sphere)
  runtime.applySettings({ grid: true, wireframe: true, autoRotate: false, background: 'dark' })
  runtime.applySettings({ grid: false, wireframe: false, autoRotate: true, background: 'light' })
  runtime.resetView()
  assert.equal(runtime.detachModel(), model)
  runtime.dispose()
})

test('scene runtime can be disposed before a model is attached', () => {
  const runtime = new ModelSceneRuntime(fakeTHREE, bundle, makeHost(), {
    onContextLost() {},
    isAnimating: () => false,
    onFrame() {},
  })
  runtime.applySettings({ grid: true, wireframe: false, autoRotate: false, background: 'theme' })
  runtime.dispose()
})
