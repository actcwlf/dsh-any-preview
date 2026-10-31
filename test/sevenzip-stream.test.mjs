/** Streaming a folder must produce the same slice the one-shot path does. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseHeader, readLayout } from '../src/shared/sevenzip/structure.ts'
import { canStream, shouldStream, STREAM_THRESHOLD_BYTES, streamFolderRange } from '../src/shared/sevenzip/stream.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const samples = join(root, '..', 'samples')
const wasmPath = join(root, 'lib', 'lzma.wasm')
const skip = existsSync(wasmPath) ? false : 'lib/lzma.wasm is not built'

async function fixture() {
  const bytes = new Uint8Array(readFileSync(join(samples, 'sample-noheader.7z')))
  const layout = readLayout(bytes)
  assert.ok(layout)
  const start = 32 + layout.nextHeaderOffset
  const archive = parseHeader(bytes.subarray(start, start + layout.nextHeaderSize))
  assert.ok(archive)
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {})
  return { bytes, archive, api: instance.exports }
}

/** Collect a range through the streaming path. */
async function collect(chunkSize) {
  const { bytes, archive, api } = await fixture()
  const folder = archive.folders[0]
  const entry = archive.entries[1]
  assert.ok(folder)
  assert.ok(entry)
  const start = archive.entries
    .slice(0, 1)
    .reduce((sum, item) => sum + item.size, 0)
  const chunks = []
  await streamFolderRange({
    decoder: api,
    folder,
    readPacked: async (index, offset, length) => {
      const stream = archive.packStreams[index]
      assert.ok(stream)
      const from = 32 + stream.offset + offset
      return bytes.slice(from, Math.min(from + length, 32 + stream.offset + stream.size))
    },
    range: { start, end: start + entry.size },
    sink: (chunk) => { chunks.push(chunk) },
    chunkSize,
  })
  return { collected: Uint8Array.from(chunks.flatMap(chunk => Array.from(chunk))), entry }
}

test('a solid folder streams the requested member', { skip }, async () => {
  const { collected, entry } = await collect(1024 * 1024)
  const text = new TextDecoder().decode(collected)
  assert.equal(collected.length, entry.size)
  assert.match(text, /id,name/u)
})

test('chunk size does not change the result', { skip }, async () => {
  const reference = await collect(1024 * 1024)
  for (const chunkSize of [1, 3, 16, 64]) {
    const { collected } = await collect(chunkSize)
    assert.deepEqual(Array.from(collected), Array.from(reference.collected), `chunk ${String(chunkSize)}`)
  }
})

test('only single-coder folders are streamable', { skip }, async () => {
  const { archive } = await fixture()
  assert.equal(canStream(archive.folders[0]), true)
})
test('the streaming threshold decides the path', () => {
  assert.equal(shouldStream(STREAM_THRESHOLD_BYTES), true)
  assert.equal(shouldStream(STREAM_THRESHOLD_BYTES - 1), false)
  // A small fixture can exercise the same code path by lowering the threshold.
  assert.equal(shouldStream(1024, 1), true)
})