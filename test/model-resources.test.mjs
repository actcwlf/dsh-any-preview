/** Model resource sandbox and the extension/needs detection it feeds. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  declaredImageBytes,
  directoryOf,
  externalReferences,
  gltfExtensions,
  gltfJson,
  modelNeeds,
  mtllibNames,
  resolveResource,
  resourceBase,
  resourceTarget,
  unsafeGltfReference,
} from '../src/client/previews/model/resources.ts'

const encoder = new TextEncoder()

/**
 * A GLB whose only chunk is the JSON document.
 * @param {object} document - glTF JSON.
 * @returns {ArrayBuffer} the container bytes.
 */
function glbOf(document) {
  const json = encoder.encode(JSON.stringify(document))
  const pad = (4 - (json.length % 4)) % 4
  const length = json.length + pad
  const bytes = new Uint8Array(12 + 8 + length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x46546c67, true) // 'glTF'
  view.setUint32(4, 2, true)
  view.setUint32(8, bytes.byteLength, true)
  view.setUint32(12, length, true)
  view.setUint32(16, 0x4e4f534a, true) // 'JSON'
  bytes.set(json, 20)
  bytes.fill(0x20, 20 + json.length)
  return bytes.buffer
}

test('a path\'s directory keeps its separator style out of the way', () => {
  assert.equal(directoryOf('C:\\models\\x.glb'), 'C:/models')
  assert.equal(directoryOf('/models/x.glb'), '/models')
  assert.equal(directoryOf('/x.glb'), '/')
  assert.equal(directoryOf('x.glb'), '')
})

test('relative references resolve inside the directory', () => {
  assert.equal(resolveResource('C:/models', 'textures/a.png'), 'C:/models/textures/a.png')
  assert.equal(resolveResource('C:/models', './a.bin'), 'C:/models/a.bin')
  assert.equal(resolveResource('C:/models', 'a/../b.bin'), 'C:/models/b.bin')
  assert.equal(resolveResource('C:/models', 'a b.png'), 'C:/models/a b.png')
  assert.equal(resolveResource('C:/models', 'a%20b.png'), 'C:/models/a b.png')
  assert.equal(resolveResource('C:/models', 'scene.bin?x=1'), 'C:/models/scene.bin')
  assert.equal(resolveResource('/', 'a.bin'), '/a.bin')
})

test('references that leave the directory are refused', () => {
  for (const uri of [
    '../secret.bin',
    'a/../../secret.bin',
    '..%2Fsecret.bin',
    '%2e%2e/secret.bin',
    'http://example.com/x.bin',
    'https://example.com/x.bin',
    '//example.com/x.bin',
    'C:/Windows/x.bin',
    '\\\\server\\share\\x.bin',
    '/etc/passwd',
    '',
    '#fragment',
    'a%00b.png',
  ]) {
    assert.equal(resolveResource('C:/models', uri), undefined, uri)
  }
})

test('the sentinel base ends with one slash', () => {
  assert.equal(resourceBase('C:/models/'), 'dsh-model-res://C:/models/')
  assert.equal(resourceBase('/'), 'dsh-model-res:///')
})

test('a resolved URL is classified, not trusted', () => {
  const base = resourceBase('/models')
  assert.deepEqual(resourceTarget(`${base}textures/a.png`, base, '/models'), { kind: 'absolute', path: '/models/textures/a.png' })
  assert.deepEqual(resourceTarget(`${base}../x.bin`, base, '/models'), { kind: 'blocked' })
  assert.deepEqual(resourceTarget('data:application/octet-stream;base64,AA', base, '/models'), { kind: 'verbatim' })
  assert.deepEqual(resourceTarget('blob:http://host/x', base, '/models'), { kind: 'verbatim' })
  assert.deepEqual(resourceTarget('https://example.com/x.bin', base, '/models'), { kind: 'blocked' })
  assert.deepEqual(resourceTarget('/models/x.bin', base, '/models'), { kind: 'blocked' })
})

test('a GLB JSON chunk parses without a binary chunk', () => {
  const bytes = glbOf({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] })
  assert.deepEqual(gltfJson(bytes, 'glb'), { asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] })
  assert.deepEqual(gltfJson(encoder.encode('{"a":1}').buffer, 'gltf'), { a: 1 })
  assert.equal(gltfJson(encoder.encode('not json').buffer, 'gltf'), undefined)
  assert.equal(gltfJson(new ArrayBuffer(8), 'glb'), undefined)
})

test('extensions come from both used and required lists', () => {
  assert.deepEqual(
    gltfExtensions({ extensionsUsed: ['A', 'B'], extensionsRequired: ['B', 'C'] }),
    ['A', 'B', 'C'],
  )
})

test('needs follow the declared extensions, not the loader defaults', () => {
  const compressed = modelNeeds('glb', glbOf({
    extensionsUsed: ['KHR_draco_mesh_compression', 'KHR_texture_basisu'],
    extensionsRequired: ['EXT_meshopt_compression'],
  }))
  assert.deepEqual(compressed, { draco: true, ktx2: true, meshopt: true, materials: false })

  const plain = modelNeeds('gltf', encoder.encode('{"asset":{"version":"2.0"}}').buffer)
  assert.deepEqual(plain, { draco: false, ktx2: false, meshopt: false, materials: false })
})

test('an OBJ needs materials only when it names a library', () => {
  assert.equal(modelNeeds('obj', new ArrayBuffer(0), 'v 0 0 0\nmtllib a.mtl\n').materials, true)
  assert.equal(modelNeeds('obj', new ArrayBuffer(0), 'v 0 0 0\nf 1 1 1\n').materials, false)
  assert.equal(modelNeeds('obj', encoder.encode('mtllib a.mtl\n').buffer).materials, true)
  assert.equal(modelNeeds('obj', encoder.encode('o box\n').buffer).materials, false)
})

test('mtllib keeps names with spaces and ignores comments', () => {
  assert.deepEqual(
    mtllibNames('mtllib a.mtl\n# mtllib no.mtl\n  mtllib  b.v2.mtl  \nMTLLIB c.mtl\n'),
    ['a.mtl', 'b.v2.mtl', 'c.mtl'],
  )
  assert.deepEqual(mtllibNames('mtllib my material.mtl\n'), ['my material.mtl'])
})

test('the glTF pre-check names the offending reference', () => {
  const safe = { buffers: [{ uri: 'a.bin' }, { uri: 'data:application/octet-stream;base64,AA' }], images: [{ uri: 'tex/a.png' }] }
  assert.equal(unsafeGltfReference(safe, '/models'), undefined)
  assert.equal(unsafeGltfReference({ buffers: [{ uri: '../a.bin' }] }, '/models'), '../a.bin')
  assert.equal(unsafeGltfReference({ images: [{ uri: 'http://example.com/a.png' }] }, '/models'), 'http://example.com/a.png')
  // Without a base directory there is nothing to confine a reference to.
  assert.equal(unsafeGltfReference({ buffers: [{ uri: '../a.bin' }] }, undefined), undefined)
})

test('external references skip embedded data and blob URLs', () => {
  assert.deepEqual(
    externalReferences({
      buffers: [
        { uri: 'a.bin' },
        { uri: 'data:application/octet-stream;base64,AA' },
      ],
      images: [
        { uri: 'tex/a.png' },
        { bufferView: 0 },
        { uri: 'blob:http://host/x' },
      ],
    }),
    [
      { uri: 'a.bin', kind: 'buffer' },
      { uri: 'tex/a.png', kind: 'image' },
    ],
  )
  assert.deepEqual(externalReferences(undefined), [])
})

test('declared image bytes cover buffer views and data URIs', () => {
  const document = {
    bufferViews: [{ byteLength: 100 }, { byteLength: 50 }],
    images: [
      { bufferView: 0 },
      { uri: `data:image/png;base64,${'A'.repeat(40)}` },
      { uri: 'tex/a.png' },
      { bufferView: 1 },
    ],
  }
  // 100 (view) + 30 (40 base64 chars) + 0 (external) + 50 (view)
  assert.equal(declaredImageBytes(document), 180)
  assert.equal(declaredImageBytes(undefined), 0)
})
