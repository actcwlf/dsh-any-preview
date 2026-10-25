/** Zip and tar parsing against the real fixtures in samples/. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { findEocd, parseTar, parseZipDirectory, zipDirectoryRange } from '../src/client/previews/archive/parse.ts'

const ZIP = 'F:/DSH/workspace/ext_preview/samples/bundle.zip'
const TGZ = 'F:/DSH/workspace/ext_preview/samples/bundle.tar.gz'
const available = existsSync(ZIP) && existsSync(TGZ)

test('the zip fixture lists both members through its central directory', { skip: !available }, () => {
  const bytes = new Uint8Array(readFileSync(ZIP))
  const eocd = findEocd(bytes)
  assert.ok(eocd >= 0, 'end-of-central-directory found')
  const range = zipDirectoryRange(bytes, eocd)
  assert.ok(range !== undefined, 'directory range read')
  const entries = parseZipDirectory(bytes.subarray(range.offset, range.offset + range.size))
  assert.deepEqual(entries.map(entry => entry.name).sort(), ['data.csv', 'readme.txt'])
  assert.equal(entries.find(entry => entry.name === 'data.csv')?.size, 7)
  assert.equal(entries.find(entry => entry.name === 'readme.txt')?.size, 34)
})

test('the zip tail alone is enough to locate the directory', { skip: !available }, () => {
  const bytes = new Uint8Array(readFileSync(ZIP))
  const tail = bytes.subarray(Math.max(0, bytes.length - 66_000))
  const eocd = findEocd(tail)
  assert.ok(eocd >= 0, 'EOCD is inside the tail window')
  const range = zipDirectoryRange(tail, eocd)
  assert.ok(range !== undefined)
  // The directory ends exactly where the EOCD record begins.
  assert.equal(range.offset + range.size, eocd)
})

test('the tar.gz fixture lists its members after inflate', { skip: !available }, () => {
  const raw = new Uint8Array(gunzipSync(readFileSync(TGZ)))
  const names = parseTar(raw).map(entry => entry.name.replace(/^\.\//u, ''))
  assert.ok(names.includes('readme.txt'), `names: ${names.join(', ')}`)
  assert.ok(names.includes('data.csv'), `names: ${names.join(', ')}`)
})

test('a tar header reports its size in octal', { skip: !available }, () => {
  const raw = new Uint8Array(gunzipSync(readFileSync(TGZ)))
  const entries = parseTar(raw)
  const csv = entries.find(entry => entry.name.endsWith('data.csv'))
  assert.equal(csv?.size, 7)
  assert.equal(csv?.directory, false)
})
