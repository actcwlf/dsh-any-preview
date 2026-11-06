/**
 * Model decoding: parse, triangle budget, teardown, and progress.
 *
 * The loaders are the real three r0.180 addons, resolved from this package's
 * dev dependencies; the sample `.glb` is used when this machine has it, and a
 * generated one covers the same path everywhere else.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { countTriangles, disposeObject, parseModel, readBody } from '../src/client/previews/model/decode.ts'

const bundle = { THREE, GLTFLoader, OBJLoader, STLLoader }

/** The real Blender export, when this workspace has the fixture. */
const sampleGlb = new URL('../../samples/tetra.glb', import.meta.url)
const sampleAvailable = existsSync(sampleGlb)

const encoder = new TextEncoder()

/**
 * A one-triangle GLB: header, JSON chunk, BIN chunk.
 * @returns the file bytes.
 */
function minimalGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 1, 2])
  const bin = new Uint8Array(44)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), 36)

  const json = encoder.encode(JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  }))
  const jsonPad = (4 - (json.length % 4)) % 4
  const jsonLength = json.length + jsonPad
  const total = 12 + 8 + jsonLength + 8 + bin.length

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(json, 20)
  out.fill(0x20, 20 + json.length, 20 + jsonLength)
  const binStart = 20 + jsonLength
  view.setUint32(binStart, bin.length, true)
  view.setUint32(binStart + 4, 0x004e4942, true) // 'BIN'
  out.set(bin, binStart + 8)
  return out.buffer
}

/**
 * A one-triangle binary STL.
 * @returns the file bytes.
 */
function binaryStl() {
  const out = new Uint8Array(84 + 50)
  const view = new DataView(out.buffer)
  view.setUint32(80, 1, true)
  const values = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0]
  values.forEach((value, index) => { view.setFloat32(84 + index * 4, value, true) })
  return out.buffer
}

test('a glb decodes into a scene with its triangles counted', async () => {
  const scene = await parseModel(bundle, 'glb', minimalGlb())
  assert.equal(scene.isObject3D, true)
  assert.equal(countTriangles(scene), 1)
})

test('an obj decodes and its faces are triangulated', async () => {
  const obj = encoder.encode('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n')
  const scene = await parseModel(bundle, 'obj', obj.buffer)
  assert.equal(countTriangles(scene), 2)
})

test('an stl decodes as a mesh with the material the viewer draws', async () => {
  const object = await parseModel(bundle, 'stl', binaryStl())
  assert.equal(object.isMesh, true)
  assert.equal(countTriangles(object), 1)
  assert.equal(object.material.type, 'MeshStandardMaterial')
})

test('a real Blender glb parses', { skip: !sampleAvailable }, async () => {
  const bytes = readFileSync(sampleGlb)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const scene = await parseModel(bundle, 'glb', buffer)
  assert.equal(countTriangles(scene), 4)
})

test('an unsupported suffix reports the localized key, not a three.js message', async () => {
  await assert.rejects(
    parseModel(bundle, 'ply', new ArrayBuffer(0)),
    (error) => error.key === 'model.unsupported',
  )
})

test('the triangle count ignores point and line nodes', () => {
  const group = new THREE.Group()
  const geometry = new THREE.BufferGeometry().setAttribute(
    'position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  )
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.geometry.setIndex([0, 1, 2])
  group.add(mesh)
  group.add(new THREE.Points(mesh.geometry.clone(), new THREE.PointsMaterial()))
  group.add(new THREE.Line(mesh.geometry.clone(), new THREE.LineBasicMaterial()))
  assert.equal(countTriangles(group), 1)
})

test('teardown releases every node, not just meshes', () => {
  const geometry = new THREE.BufferGeometry().setAttribute(
    'position', new THREE.Float32BufferAttribute([0, 0, 0], 3),
  )
  const texture = new THREE.Texture()
  const material = new THREE.MeshBasicMaterial({ map: texture })
  const points = new THREE.Points(geometry, material)

  let geometries = 0
  let materials = 0
  let textures = 0
  const originalGeometry = geometry.dispose.bind(geometry)
  geometry.dispose = () => { geometries += 1; originalGeometry() }
  const originalMaterial = material.dispose.bind(material)
  material.dispose = () => { materials += 1; originalMaterial() }
  const originalTexture = texture.dispose.bind(texture)
  texture.dispose = () => { textures += 1; originalTexture() }

  disposeObject(points)
  assert.equal(geometries, 1)
  assert.equal(materials, 1)
  assert.equal(textures, 1)
})

test('teardown tolerates a malformed node and a missing object', () => {
  assert.doesNotThrow(() => disposeObject(undefined))
  assert.doesNotThrow(() => disposeObject({ traverse: (visit) => visit({ geometry: {}, material: null }) }))
})

test('a body read reports progress and returns exactly the bytes', async () => {
  const response = new Response(new Uint8Array([1, 2, 3, 4, 5]), {
    headers: { 'content-length': '5' },
  })
  const ticks = []
  const bytes = await readBody(response, (loaded, total) => ticks.push([loaded, total]))
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5])
  assert.ok(ticks.length > 0)
  assert.deepEqual(ticks.at(-1), [5, 5])
  assert.ok(ticks.every(([, total]) => total === 5))
})

test('a body without a length still reports what has arrived', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([7]))
      controller.enqueue(new Uint8Array([8]))
      controller.close()
    },
  })
  const response = new Response(stream)
  assert.equal(response.headers.get('content-length'), null)
  const ticks = []
  const bytes = await readBody(response, (loaded, total) => ticks.push([loaded, total]))
  assert.deepEqual([...bytes], [7, 8])
  assert.deepEqual(ticks.at(-1), [2, 2], 'the final tick falls back to the bytes read')
})

test('a body shorter than its announced length returns what arrived', async () => {
  const response = new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '5' } })
  const bytes = await readBody(response)
  assert.deepEqual([...bytes], [1, 2])
})

test('a body longer than its announced length keeps every byte', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]))
      controller.enqueue(new Uint8Array([3, 4]))
      controller.close()
    },
  })
  const response = new Response(stream, { headers: { 'content-length': '2' } })
  const bytes = await readBody(response)
  assert.deepEqual([...bytes], [1, 2, 3, 4])
})

test('an empty body settles without a stream', async () => {
  const ticks = []
  const bytes = await readBody(new Response(null), (loaded, total) => ticks.push([loaded, total]))
  assert.equal(bytes.byteLength, 0)
  assert.deepEqual(ticks.at(-1), [0, 0])
})
