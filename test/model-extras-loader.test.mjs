/** The decoder chunk loader shares the generic chunk cache. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extrasChunkUrl, loadModelExtras } from '../src/client/kernel/model-extras-loader.ts'
import { resetChunks } from '../src/client/kernel/chunk-loader.ts'

const CHUNK = '/any-preview/asset/model-extras-chunk.js'

function withLocation(protocol, run) {
  const had = 'location' in globalThis
  const previous = globalThis.location
  globalThis.location = { protocol }
  return Promise.resolve(run()).finally(() => {
    if (had) globalThis.location = previous
    else delete globalThis.location
  })
}

test('the decoder chunk addresses the guarded asset route', async () => {
  await withLocation('http:', async () => {
    assert.equal(await extrasChunkUrl(), CHUNK)
  })
})

test('concurrent decoder loads share a promise and a failure clears it', async () => {
  resetChunks()
  await withLocation('dsh-app:', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
    try {
      const first = loadModelExtras()
      const second = loadModelExtras()
      assert.equal(first, second, 'the second caller reuses the first promise')
      await assert.rejects(first)
      const third = loadModelExtras()
      assert.notEqual(third, first, 'a failure clears the cache so it can retry')
      await assert.rejects(third)
    } finally {
      globalThis.fetch = original
      resetChunks()
    }
  })
})
