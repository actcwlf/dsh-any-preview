/** Asset delivery: whitelist, URL choice, and the wasm loader contract. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assetBaseUrl, assetUrl, loadWasm } from '../src/client/kernel/assets.ts'

const PREFIX = '/any-preview/asset'

function withLocation(protocol, run) {
  const had = 'location' in globalThis
  const previous = globalThis.location
  globalThis.location = { protocol }
  return Promise.resolve(run()).finally(() => {
    if (had) globalThis.location = previous
    else delete globalThis.location
  })
}

// Smallest valid module: magic + version, no sections.
const EMPTY_WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])

test('only whitelisted names resolve', async () => {
  await withLocation('http:', async () => {
    assert.equal(await assetUrl('three-chunk.js'), `${PREFIX}/three-chunk.js`)
    await assert.rejects(assetUrl('payload.bin'), /unknown asset/u)
  })
})

test('a dsh-app page prefixes the loopback base', async () => {
  await withLocation('dsh-app:', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ base: 'http://127.0.0.1:1' }) })
    try {
      assert.equal(await assetUrl('lzma.wasm'), `http://127.0.0.1:1${PREFIX}/lzma.wasm`)
    } finally {
      globalThis.fetch = original
    }
  })
})

test('the asset base ends with a slash, so decoders can append file names', async () => {
  await withLocation('http:', async () => {
    assert.equal(await assetBaseUrl(), `${PREFIX}/`)
  })
  await withLocation('dsh-app:', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ base: 'http://127.0.0.1:1' }) })
    try {
      assert.equal(await assetBaseUrl(), `http://127.0.0.1:1${PREFIX}/`)
    } finally {
      globalThis.fetch = original
    }
  })
})

test('the decoder binaries are whitelisted with their real MIME types', async () => {
  await withLocation('http:', async () => {
    assert.equal(await assetUrl('draco_decoder.wasm'), `${PREFIX}/draco_decoder.wasm`)
    assert.equal(await assetUrl('basis_transcoder.js'), `${PREFIX}/basis_transcoder.js`)
    assert.equal(await assetUrl('model-extras-chunk.js'), `${PREFIX}/model-extras-chunk.js`)
  })
})

test('only .wasm names can be instantiated', async () => {
  await assert.rejects(loadWasm('three-chunk.js'), /not a wasm asset/u)
})

test('the wasm loader instantiates a served module', async () => {
  await withLocation('http:', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/wasm' },
      clone() { return this },
      arrayBuffer: async () => EMPTY_WASM.slice().buffer,
    })
    try {
      const instance = await loadWasm('lzma.wasm')
      assert.ok(instance instanceof WebAssembly.Instance)
    } finally {
      globalThis.fetch = original
    }
  })
})

test('a missing asset is reported, not silently ignored', async () => {
  await withLocation('http:', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 404 })
    try {
      await assert.rejects(loadWasm('lzma.wasm'), /unavailable \(404\)/u)
    } finally {
      globalThis.fetch = original
    }
  })
})
