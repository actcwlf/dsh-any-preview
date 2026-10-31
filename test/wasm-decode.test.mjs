/** The decode wasm: exports, and one real LZMA1 round trip. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const wasmPath = join(root, 'lib', 'lzma.wasm')
const fixturePath = join(root, 'test', 'fixtures', 'lzma1.json')

/** The artifact is built by `pnpm build:wasm`; tests must pass without it. */
const skip = existsSync(wasmPath) ? false : 'lib/lzma.wasm is not built'

function hexBytes(hex) {
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}

test('the decode module exports its ABI', { skip }, async () => {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {})
  for (const name of ['memory', 'malloc', 'free', 'reset_heap', 'lzma_decode', 'lzma2_decode', 'crc32_buf']) {
    assert.equal(typeof instance.exports[name] === 'undefined', false, `${name} is exported`)
  }
})

test('a raw LZMA1 stream decodes to the original bytes', { skip }, async () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {})
  const api = instance.exports

  const props = hexBytes(fixture.props)
  const input = hexBytes(fixture.input)
  const expected = hexBytes(fixture.plain)
  const pProps = api.malloc(props.length)
  const pInput = api.malloc(input.length)
  const pOutput = api.malloc(expected.length + 64)

  const memory = () => new Uint8Array(api.memory.buffer)
  memory().set(props, pProps)
  memory().set(input, pInput)

  const written = api.lzma_decode(pProps, props.length, pInput, input.length, pOutput, expected.length + 64)
  assert.equal(written, expected.length)

  const output = memory().slice(pOutput, pOutput + written)
  assert.deepEqual(Array.from(output), Array.from(expected))
})

test('corrupt input is reported instead of returning bytes', { skip }, async () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {})
  const api = instance.exports
  const props = hexBytes(fixture.props)
  const input = hexBytes(fixture.input)
  input[Math.floor(input.length / 2)] ^= 0xFF

  const pProps = api.malloc(props.length)
  const pInput = api.malloc(input.length)
  const pOutput = api.malloc(4096)
  const memory = () => new Uint8Array(api.memory.buffer)
  memory().set(props, pProps)
  memory().set(input, pInput)

  const written = api.lzma_decode(pProps, props.length, pInput, input.length, pOutput, 4096)
  assert.ok(written < 0, `expected a negative code, got ${written}`)
})
