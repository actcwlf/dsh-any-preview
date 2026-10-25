/** Range parsing and MIME mapping for the media route. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mediaTypeOf, parseRange } from '../src/host/media-route.ts'

const SIZE = 1000

test('no Range header means the complete body', () => {
  assert.equal(parseRange(null, SIZE), undefined)
})

test('a closed range yields an inclusive window', () => {
  assert.deepEqual(parseRange('bytes=0-1023', 4096), { start: 0, end: 1023 })
})

test('an open-ended range runs to the last byte', () => {
  assert.deepEqual(parseRange('bytes=100-', SIZE), { start: 100, end: 999 })
})

test('a suffix range takes the tail', () => {
  assert.deepEqual(parseRange('bytes=-500', SIZE), { start: 500, end: 999 })
})

test('an end past the file is clamped, not rejected', () => {
  assert.deepEqual(parseRange('bytes=900-5000', SIZE), { start: 900, end: 999 })
})

test('a start at or past the end is unsatisfiable', () => {
  assert.equal(parseRange('bytes=1000-1200', SIZE), 'invalid')
  assert.equal(parseRange('bytes=5000-', SIZE), 'invalid')
})

test('a reversed or empty suffix range is unsatisfiable', () => {
  assert.equal(parseRange('bytes=500-400', SIZE), 'invalid')
  assert.equal(parseRange('bytes=-0', SIZE), 'invalid')
})

test('a suffix range against an empty file is unsatisfiable', () => {
  assert.equal(parseRange('bytes=-10', 0), 'invalid')
})

test('multi-range and malformed headers fall back to the complete body', () => {
  assert.equal(parseRange('bytes=0-1,5-6', SIZE), undefined)
  assert.equal(parseRange('items=0-1', SIZE), undefined)
  assert.equal(parseRange('bytes=-', SIZE), undefined)
})

test('media types come from the suffix, case-insensitively', () => {
  assert.equal(mediaTypeOf('/a/clip.mp4'), 'video/mp4')
  assert.equal(mediaTypeOf('C:\\media\\song.MP3'), 'audio/mpeg')
  assert.equal(mediaTypeOf('notes.txt'), 'application/octet-stream')
  assert.equal(mediaTypeOf('no-extension'), 'application/octet-stream')
})
