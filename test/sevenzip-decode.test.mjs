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
  const plain = decodeFolder(api, streams.folders[0], [packed])

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
  const output = decodeFolder(api, folder, [packed])

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
  assert.throws(() => decodeFolder(api, folder, [new Uint8Array([1, 2, 3])]), /unsupported coder chain/u)
})

test('an x86 BCJ folder decodes back to the original executable', { skip }, async () => {
  const bytes = new Uint8Array(readFileSync(join(samples, 'sample-bcj.7z')))
  const layout = readLayout(bytes)
  assert.ok(layout)
  const start = 32 + layout.nextHeaderOffset
  let header = bytes.subarray(start, start + layout.nextHeaderSize)
  const api = await decoder()
  if (isEncodedHeader(header)) {
    const streams = parseEncodedHeader(header)
    assert.ok(streams)
    const packed = folderPackedBytes(streams.folders[0], streams.packStreams, fileReader(bytes))
    header = decodeFolder(api, streams.folders[0], [packed])
  }
  const archive = parseHeader(header)
  assert.ok(archive)
  const folder = archive.folders[0]
  assert.ok(folder)
  assert.deepEqual(folder.coders.map(coder => coder.name), ['LZMA2', 'BCJ'])
  assert.equal(canDecode(folder), true)

  const packed = folderPackedBytes(folder, archive.packStreams, fileReader(bytes))
  const output = decodeFolder(api, folder, [packed])
  const original = new Uint8Array(readFileSync(join(samples, 'tool.exe')))
  assert.equal(output.length, original.length)
  assert.deepEqual(Array.from(output), Array.from(original))
})

test('a BCJ2 folder decodes back to the original executable', { skip }, async () => {
  const bytes = new Uint8Array(readFileSync(join(samples, 'sample-bcj2.7z')))
  const layout = readLayout(bytes)
  assert.ok(layout)
  const start = 32 + layout.nextHeaderOffset
  const header = bytes.subarray(start, start + layout.nextHeaderSize)
  const archive = parseHeader(header)
  assert.ok(archive, 'the BCJ2 fixture keeps its header uncompressed')
  const folder = archive.folders[0]
  assert.ok(folder)
  assert.deepEqual(folder.coders.map(coder => coder.name), ['LZMA2', 'BCJ2'])
  assert.equal(folder.packs.length, 4, 'main, call, jump and range-coder streams')
  assert.equal(canDecode(folder), true)

  const packs = folder.packs.map(index => {
    const stream = archive.packStreams[index]
    assert.ok(stream)
    return bytes.slice(32 + stream.offset, 32 + stream.offset + stream.size)
  })
  const api = await decoder()
  const output = decodeFolder(api, folder, packs)
  const original = new Uint8Array(readFileSync(join(samples, 'tool.exe')))
  assert.equal(output.length, original.length)
  assert.deepEqual(Array.from(output), Array.from(original))
})