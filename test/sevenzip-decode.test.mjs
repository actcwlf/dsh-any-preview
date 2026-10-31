/** End-to-end: decode a compressed header and a folder with lib/lzma.wasm. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isEncodedHeader, parseEncodedHeader, parseHeader, readLayout } from '../src/shared/sevenzip/structure.ts'
import { canDecode, decodeFolder, folderPackedBytes } from '../src/shared/sevenzip/decode.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const samples = join(root, '..', 'samples')
const wasmPath = join(root, 'lib', 'lzma.wasm')
const skip = existsSync(wasmPath) ? false : 'lib/lzma.wasm is not built'

async function decoder() {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {})
  return instance.exports
}

/** Packed data is addressed from offset 0x20 in the file. */
function fileReader(bytes) {
  return (offset, length) => bytes.slice(32 + offset, 32 + offset + length)
}

test('a compressed header decodes and then parses like a plain one', { skip }, async () => {
  const bytes = new Uint8Array(readFileSync(join(samples, 'sample-solid.7z')))
  const layout = readLayout(bytes)
  assert.ok(layout)
  const start = 32 + layout.nextHeaderOffset
  const encoded = bytes.subarray(start, start + layout.nextHeaderSize)
  assert.equal(isEncodedHeader(encoded), true)

  const streams = parseEncodedHeader(encoded)
  assert.ok(streams)
  assert.equal(streams.folders.length, 1)
  const api = await decoder()
  const packed = folderPackedBytes(streams.folders[0], streams.packStreams, fileReader(bytes))
  const plain = decodeFolder(api, streams.folders[0], packed)

  const archive = parseHeader(plain)
  assert.ok(archive)
  assert.deepEqual(archive.entries.map(entry => entry.name), ['alpha.txt', 'beta.csv', 'deep.md'])
  assert.equal(archive.solid, true)
})

test('a folder decodes to the concatenation of its files', { skip }, async () => {
  const bytes = new Uint8Array(readFileSync(join(samples, 'sample-noheader.7z')))
  const layout = readLayout(bytes)
  assert.ok(layout)
  const start = 32 + layout.nextHeaderOffset
  const archive = parseHeader(bytes.subarray(start, start + layout.nextHeaderSize))
  assert.ok(archive)
  const folder = archive.folders[0]
  assert.ok(folder)
  assert.equal(canDecode(folder), true)

  const api = await decoder()
  const packed = folderPackedBytes(folder, archive.packStreams, fileReader(bytes))
  const output = decodeFolder(api, folder, packed)

  assert.equal(output.length, folder.size)
  const decoderText = new TextDecoder()
  let offset = 0
  for (const entry of archive.entries) {
    const slice = output.subarray(offset, offset + entry.size)
    offset += entry.size
    const text = decoderText.decode(slice)
    if (entry.name === 'alpha.txt') assert.match(text, /alpha line one/u)
    if (entry.name === 'beta.csv') assert.match(text, /id,name/u)
    if (entry.name === 'deep.md') assert.match(text, /# deep/u)
  }
  assert.equal(offset, output.length)
})

test('an AES folder is refused instead of decoded incorrectly', { skip }, async () => {
  const bytes = new Uint8Array(readFileSync(join(samples, 'sample-encrypted.7z')))
  const layout = readLayout(bytes)
  assert.ok(layout)
  const start = 32 + layout.nextHeaderOffset
  const archive = parseHeader(bytes.subarray(start, start + layout.nextHeaderSize))
  assert.ok(archive)
  const folder = archive.folders[0]
  assert.ok(folder)
  assert.equal(canDecode(folder), false)
  const api = await decoder()
  assert.throws(() => decodeFolder(api, folder, new Uint8Array([1, 2, 3])), /unsupported coder chain/u)
})
