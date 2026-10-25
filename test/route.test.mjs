/**
 * End-to-end behaviour of the media route against a fake filesystem, so the
 * status/header decisions are covered without a Host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serveMedia } from '../src/host/media-route.ts'

const BYTES = Buffer.from('0123456789')

/**
 * A filesystem whose identity mapping accepts one path.
 * @param {{ missing?: boolean, mapped?: string | undefined, size?: number }} [options] - overrides.
 * @returns {object} the fake service.
 */
function fakeFs(options = {}) {
  const size = options.size ?? BYTES.length
  // `'mapped' in options` distinguishes "unmapped" from "not overridden".
  const mapping = 'mapped' in options ? options.mapped : '/media/clip.mp4'
  return {
    processPathFromHostPath: () => mapping,
    processPath: target => target,
    resolve: async path => path,
    stat: async () => (options.missing === true
      ? undefined
      : { type: 'file', size, displayPath: '/media/clip.mp4' }),
    readByteRange: async (_target, { offset, length }) => BYTES.subarray(offset, offset + length),
  }
}

/**
 * @param {string} query - already-encoded query string.
 * @param {object} [init] - request init.
 * @returns {Request} the request.
 */
function request(query, init = {}) {
  return new Request(`http://127.0.0.1/api/any-preview/media?${query}`, init)
}

const CLIP = 'path=%2Fmedia%2Fclip.mp4'

test('a plain GET answers the complete body', async () => {
  const response = await serveMedia(request(CLIP), fakeFs())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-range'), null)
  assert.equal(response.headers.get('content-length'), '10')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.headers.get('content-type'), 'video/mp4')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), '0123456789')
})

test('a range request answers exactly that window', async () => {
  const response = await serveMedia(request(CLIP, { headers: { range: 'bytes=2-4' } }), fakeFs())
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 2-4/10')
  assert.equal(response.headers.get('content-length'), '3')
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), '234')
})

test('a download stays a complete 200 with a disposition', async () => {
  const response = await serveMedia(request(`${CLIP}&download=1`), fakeFs())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-range'), null)
  assert.equal(response.headers.get('content-length'), '10')
  assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="clip\.mp4"/)
})

test('an unsatisfiable range reports the total and no body', async () => {
  const response = await serveMedia(request(CLIP, { headers: { range: 'bytes=99-' } }), fakeFs())
  assert.equal(response.status, 416)
  assert.equal(response.headers.get('content-range'), 'bytes */10')
})

test('HEAD carries the headers without a body', async () => {
  const response = await serveMedia(request(CLIP, { method: 'HEAD' }), fakeFs())
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-length'), '10')
  assert.equal(await response.text(), '')
})

test('an empty file answers 200 with zero length', async () => {
  const response = await serveMedia(request(CLIP), fakeFs({ size: 0 }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-length'), '0')
})

test('a missing file is 404 and an unmapped path is 422', async () => {
  assert.equal((await serveMedia(request(CLIP), fakeFs({ missing: true }))).status, 404)
  assert.equal((await serveMedia(request(CLIP), fakeFs({ mapped: undefined }))).status, 422)
})

test('a relative or empty path is rejected before touching the filesystem', async () => {
  assert.equal((await serveMedia(request('path=clip.mp4'), fakeFs())).status, 400)
  assert.equal((await serveMedia(request(''), fakeFs())).status, 400)
})
