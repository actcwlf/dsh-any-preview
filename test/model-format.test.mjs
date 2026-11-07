/** Format adapter registry: built-ins stay discoverable after the split. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/client/previews/model/decode.ts'
import {
  modelFormatExtensions,
  modelFormatFor,
  modelNeedsFor,
  registerModelFormat,
} from '../src/client/previews/model/format.ts'

test('the built-in formats are registered', () => {
  assert.deepEqual(modelFormatExtensions(), ['glb', 'gltf', 'obj', 'stl'])
  assert.equal(modelFormatFor('GLB')?.extensions.includes('glb'), true)
  assert.equal(modelFormatFor('obj')?.extensions.includes('obj'), true)
  assert.equal(modelFormatFor('stl')?.extensions.includes('stl'), true)
})

test('needs fall back to NO_NEEDS for a format without a detector', () => {
  registerModelFormat({
    extensions: ['faux'],
    parse: async () => ({ fake: true }),
  })
  assert.deepEqual(modelNeedsFor('faux', new ArrayBuffer(0)), {
    draco: false, ktx2: false, meshopt: false, materials: false,
  })
})
