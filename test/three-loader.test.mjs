/** The lazy 3D chunk loader: URL choice, one shared promise, retry after failure. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkUrl, loadThree } from '../src/client/kernel/three-loader.ts'

const CHUNK = '/any-preview/asset/three-chunk.js'

function withLocation(protocol, run) {
  const had = 'location' in globalThis
  const previous = globalThis.location
  globalThis.location = { protocol }
  return Promise.resolve(run()).finally(() => {
    if (had) globalThis.location = previous
    else delete globalThis.location
  })
}

test('an http page addresses the chunk on its own origin', async () => {
  await withLocation('http:', async () => {
    assert.equal(await chunkUrl(), CHUNK)
  })
})

test('a dsh-app page asks the host for the loopback base first', async () => {
  await withLocation('dsh-app:', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ base: 'http://127.0.0.1:1234' }),
    })
    try {
      assert.equal(await chunkUrl(), `http://127.0.0.1:1234${CHUNK}`)
    } finally {
      globalThis.fetch = original
    }
  })
})

test('an absent base means the asset route is unavailable', async () => {
  await withLocation('dsh-app:', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ base: '' }) })
    try {
      await assert.rejects(chunkUrl(), /unavailable/u)
    } finally {
      globalThis.fetch = original
    }
  })
})

test('concurrent callers share one promise, and a failure clears it', async () => {
  await withLocation('dsh-app:', async () => {
    const original = globalThis.fetch
    // No base: the load rejects, which is the retry path we care about.
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
    try {
      const first = loadThree()
      const second = loadThree()
      assert.equal(first, second, 'the second caller reuses the first promise')
      await assert.rejects(first)
      const third = loadThree()
      assert.notEqual(third, first, 'a failure clears the cache so it can retry')
      await assert.rejects(third)
    } finally {
      globalThis.fetch = original
    }
  })
})
