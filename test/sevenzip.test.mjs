/** 7z structure parsing against archives produced by 7z.exe. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isEncodedHeader, parseHeader, readLayout, crc32Of } from '../src/shared/sevenzip/structure.ts'

const samples = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'samples')

/** Read a fixture and cut out its next header. */
function open(name) {
  const bytes = new Uint8Array(readFileSync(join(samples, name)))
  const layout = readLayout(bytes)
  assert.ok(layout, `${name} has a 7z signature`)
  const start = 32 + layout.nextHeaderOffset
  const header = bytes.subarray(start, start + layout.nextHeaderSize)
  return { bytes, layout, header }
}

test('a non-7z byte sequence is rejected', () => {
  assert.equal(readLayout(new Uint8Array(64).fill(0)), undefined)
  assert.equal(readLayout(new Uint8Array(8)), undefined)
})

test('the signature header points at a header whose CRC matches', () => {
  const { layout, header } = open('sample-noheader.7z')
  assert.equal(layout.nextHeaderSize, header.length)
  assert.equal(crc32Of(header), layout.nextHeaderCrc)
})

test('a plain header lists the files, their sizes and the solid grouping', () => {
  const { header } = open('sample-noheader.7z')
  const archive = parseHeader(header)
  assert.ok(archive)
  assert.deepEqual(archive.entries.map(entry => entry.name), ['alpha.txt', 'beta.csv', 'deep.md'])
  assert.deepEqual(archive.entries.map(entry => entry.size), [35, 25, 18])
  assert.equal(archive.entries.every(entry => entry.directory === false), true)
  assert.equal(archive.solid, true, '7z packs these three files into one folder')
  assert.equal(archive.encrypted, false)
  assert.equal(archive.folders.length, 1)
  assert.deepEqual(archive.folders[0].coders.map(coder => coder.name), ['LZMA2'])
  assert.deepEqual(archive.packStreams.map(stream => stream.size), [71])
})

test('a compressed header is reported instead of guessed at', () => {
  const { header } = open('sample-solid.7z')
  assert.equal(isEncodedHeader(header), true)
  assert.equal(parseHeader(header), undefined, 'a kEncodedHeader payload is not a kHeader')
})

test('an encrypted archive names its coder and flags the entries', () => {
  const { header } = open('sample-encrypted.7z')
  const archive = parseHeader(header)
  assert.ok(archive)
  assert.equal(archive.encrypted, true)
  assert.deepEqual(archive.folders[0].coders.map(coder => coder.name), ['AES-256', 'LZMA2'])
  assert.equal(archive.entries[0].encrypted, true)
  assert.equal(archive.folders[0].supported, false, 'AES cannot be decoded by this module')
})
