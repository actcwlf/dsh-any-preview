/** Zip and tar parsing against the real fixtures in samples/. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { decodeText, findEocd, inflateRaw, localDataStart, parseTar, parseZipDirectory, zipDirectoryRange } from '../src/shared/zip/parse.ts'
import { cleanExtractionDir, extractEntryTo, extractedPathOf, safeEntryName, writeEntryBytesTo } from '../src/host/extract-route.ts'
import { defaultTargetDir, extractedAddress } from '../src/client/previews/archive/paths.ts'
import { safeEntryPath } from '../src/shared/archive-paths.ts'

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

test('a deflated member inflates back to its text', { skip: !available }, async () => {
  const bytes = new Uint8Array(readFileSync(ZIP))
  const eocd = findEocd(bytes)
  const range = zipDirectoryRange(bytes, eocd)
  const entries = parseZipDirectory(bytes.subarray(range.offset, range.offset + range.size))
  const csv = entries.find(entry => entry.name === 'data.csv')
  assert.ok(csv !== undefined, 'data.csv listed')
  const dataStart = csv.offset + localDataStart(bytes.subarray(csv.offset, csv.offset + 30))
  const compressed = bytes.subarray(dataStart, dataStart + csv.compressedSize)
  const data = csv.method === 8 ? await inflateRaw(compressed) : compressed
  assert.equal(decodeText(data), 'a,b\n1,2')
})

test('decodeText refuses binary payloads', () => {
  assert.equal(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), undefined)
  assert.equal(decodeText(new TextEncoder().encode('plain text')), 'plain text')
})

test('entry names cannot escape the target directory', () => {
  assert.equal(safeEntryName('../../evil.sh'), 'evil.sh')
  assert.equal(safeEntryName('a/b/c.txt'), 'c.txt')
  assert.equal(safeEntryName('..'), '_')
  assert.equal(safeEntryName(''), 'entry')
  assert.equal(safeEntryPath('../../evil.sh'), 'evil.sh')
  assert.equal(safeEntryPath('a/b/c.txt'), 'a/b/c.txt')
  assert.equal(safeEntryPath('a/../b.txt'), 'a/b.txt')
})

test('an entry extracts to disk with its content', { skip: !available }, async () => {
  const dir = 'F:/DSH/workspace/ext_preview/.tmp-extract-test'
  const archive = new Uint8Array(readFileSync(ZIP))
  const path = await extractEntryTo(archive, 'data.csv', dir)
  assert.equal(readFileSync(path, 'utf8'), 'a,b\n1,2')
  rmSync(dir, { recursive: true, force: true })
})

test('extraction is reusable, reportable and cleanable', { skip: !available }, async () => {
  const root = 'F:/DSH/workspace/ext_preview/.tmp-extract-test'
  const dir = `${root}/.dsh-any-preview/b.zip`
  const archive = new Uint8Array(readFileSync(ZIP))

  const first = await extractEntryTo(archive, 'data.csv', dir)
  const second = await extractEntryTo(archive, 'data.csv', dir)
  assert.equal(first, second, 'a repeat extraction reuses the file')

  assert.equal(await extractedPathOf('data.csv', dir), first)
  assert.equal(await extractedPathOf('missing.txt', dir), undefined)

  assert.equal(await cleanExtractionDir(dir), 1)
  assert.equal(await extractedPathOf('data.csv', dir), undefined)
  // Only a direct archive subdirectory of `.dsh-any-preview` may be removed.
  await assert.rejects(() => cleanExtractionDir(root))
  rmSync(root, { recursive: true, force: true })
})

test('different entry directories stay separate', { skip: !available }, async () => {
  const root = 'F:/DSH/workspace/ext_preview/.tmp-extract-test'
  const dir = `${root}/.dsh-any-preview/b.zip`
  const payload = new Uint8Array([1, 2, 3])
  const first = await writeEntryBytesTo(payload, 'x/readme.txt', dir)
  const second = await writeEntryBytesTo(payload, 'y/readme.txt', dir)
  assert.notEqual(first, second)
  assert.match(first.replaceAll('\\', '/'), /\/x\/readme\.txt$/u)
  assert.match(second.replaceAll('\\', '/'), /\/y\/readme\.txt$/u)
  rmSync(root, { recursive: true, force: true })
})

test('the extraction directory sits beside the archive', () => {
  assert.equal(defaultTargetDir('F:/w/samples/b.zip'), 'F:/w/samples/.dsh-any-preview/b.zip')
  assert.equal(defaultTargetDir('C:\\w\\b.zip'), 'C:/w/.dsh-any-preview/b.zip')
  assert.equal(defaultTargetDir('b.zip'), './.dsh-any-preview/b.zip')
})

test('only a default-directory extraction gets a session address', () => {
  const archive = 'dsh-resource://file/session/abc/dir/samples/b.zip'
  const expected = 'F:/w/samples/.dsh-any-preview/b.zip'
  assert.equal(
    extractedAddress(archive, 'img/cover.png', expected, expected),
    'dsh-resource://file/session/abc/dir/samples/.dsh-any-preview/b.zip/img/cover.png',
  )
  assert.equal(extractedAddress(archive, 'a.png', 'F:/elsewhere', expected), undefined)
  assert.equal(extractedAddress('dsh-resource://file/absolute/x', 'a.png', expected, expected), undefined)
})