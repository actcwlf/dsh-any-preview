/** The streaming session API: many small pushes must equal one decode. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const wasmPath = join(root, 'lib', 'lzma.wasm')
const fixturePath = join(root, 'test', 'fixtures', 'lzma1.json')
const skip = existsSync(wasmPath) ? false : 'lib/lzma.wasm is not built'

const hexBytes = hex => Uint8Array.from(Buffer.from(hex, 'hex'))

async function open() {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {})
  return instance.exports
}

/** Decode the fixture through the session API in chunks of `chunk` bytes. */
async function stream(chunk) {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const api = await open()
  const props = hexBytes(fixture.props)
  const input = hexBytes(fixture.input)
  const expected = hexBytes(fixture.plain)

  const propsPtr = api.malloc(props.length)
  const inPtr = api.malloc(input.length)
  const outCap = expected.length + 64
  const outPtr = api.malloc(outCap)
  const consumedPtr = api.malloc(4)
  const memory = () => new Uint8Array(api.memory.buffer)
  memory().set(props, propsPtr)

  const handle = api.dec_open(propsPtr, props.length, 0)
  assert.ok(handle >= 0, 'a session is available')

  const produced = []
  for (let offset = 0; offset < input.length; offset += chunk) {
    const slice = input.subarray(offset, Math.min(offset + chunk, input.length))
    memory().set(slice, inPtr)
    let consumed = 0
    let guard = 0
    // Feed until this slice is fully consumed, draining output as it appears.
    while (consumed < slice.length && guard++ < 10000) {
      const written = api.dec_push(handle, inPtr + consumed, slice.length - consumed, outPtr, outCap, consumedPtr)
      assert.ok(written >= 0, `dec_push returned ${written}`)
      consumed += new Uint32Array(api.memory.buffer, consumedPtr, 1)[0]
      if (written > 0) produced.push(...new Uint8Array(api.memory.buffer, outPtr, written))
    }
  }

  const tail = api.dec_finish(handle, outPtr, outCap)
  if (tail > 0) produced.push(...new Uint8Array(api.memory.buffer, outPtr, tail))
  api.dec_close(handle)
  return { produced: Uint8Array.from(produced), expected }
}

test('one byte at a time produces the same bytes as one shot', { skip }, async () => {
  const { produced, expected } = await stream(1)
  assert.deepEqual(Array.from(produced), Array.from(expected))
})

test('awkward chunk sizes produce the same bytes as one shot', { skip }, async () => {
  for (const chunk of [3, 7, 16, 1024]) {
    const { produced, expected } = await stream(chunk)
    assert.deepEqual(Array.from(produced), Array.from(expected), `chunk ${String(chunk)}`)
  }
})