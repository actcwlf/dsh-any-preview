/** The text-slice route: byte windows cut into whole lines, decoded once. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEXT_MAX_SLICE_BYTES, alignTextSlice, serveText } from '../src/host/text-route.ts'

const TEXT = 'id,name\n1,alpha\n2,beta\n3,gamma'
const BYTES = Buffer.from(TEXT, 'utf8')
const PATH = '/data/table.csv'
// Byte offsets of each row in the fixture.
const ROW1 = 8
const ROW2 = 16
const ROW3 = 23

/**
 * A filesystem over one UTF-8 text.
 * @param {{ missing?: boolean, mapped?: string | undefined, body?: Buffer }} [options] - overrides.
 * @returns {object} the fake service.
 */
function fakeFs(options = {}) {
  const body = options.body ?? BYTES
  const mapping = 'mapped' in options ? options.mapped : PATH
  return {
    processPathFromHostPath: () => mapping,
    processPath: target => target,
    resolve: async path => path,
    stat: async () => (options.missing === true ? undefined : { type: 'file', size: body.length, displayPath: PATH }),
    readByteRange: async (_target, { offset, length }) => body.subarray(offset, offset + length),
  }
}

/**
 * @param {string} query - already-encoded query string.
 * @returns {Request} the request.
 */
function request(query) {
  return new Request(`http://127.0.0.1/api/any-preview/text?${query}`)
}

/** The query for the fixture path. */
const QUERY = `path=${encodeURIComponent(PATH)}`

/**
 * @param {string} [extra] - extra query fields.
 * @returns {Promise<object>} the decoded slice.
 */
async function sliceOf(extra = '') {
  const response = await serveText(request(`${QUERY}${extra}`), fakeFs())
  assert.equal(response.status, 200)
  return response.json()
}

test('the first window starts at byte 0 and keeps the first row', async () => {
  const slice = await sliceOf()
  assert.equal(slice.start, 0)
  assert.equal(slice.text, TEXT, 'the whole file here')
  assert.equal(slice.size, BYTES.length)
  assert.equal(slice.eof, true)
})

test('a window ending mid-line drops that fragment', async () => {
  const slice = alignTextSlice(BYTES.subarray(0, 21), 0, BYTES.length)
  assert.equal(slice.text, 'id,name\n1,alpha\n', 'the "2,b" fragment is not a row yet')
  assert.equal(slice.start, 0)
  assert.equal(slice.end, ROW2)
  assert.equal(slice.eof, false)
})

test('a window starting mid-line drops that line and begins at a row boundary', async () => {
  const from = 10
  const slice = alignTextSlice(BYTES.subarray(from, 25), from, BYTES.length)
  assert.equal(slice.start, ROW2, 'just past the newline that ended the partial line')
  assert.equal(slice.text, '2,beta\n', 'whole rows only')
})

test('a window that must drop its only row returns nothing', async () => {
  const slice = alignTextSlice(BYTES.subarray(ROW2 - 3, ROW2 + 4), ROW2 - 3, BYTES.length)
  assert.equal(slice.text, '')
  assert.equal(slice.start, ROW2, 'the next complete row is where a retry would begin')
  assert.equal(slice.end, ROW2)
  assert.equal(slice.eof, false)
})

test('an offset known to start a row keeps that row', async () => {
  const slice = alignTextSlice(BYTES.subarray(ROW2, ROW3), ROW2, BYTES.length, true)
  assert.equal(slice.start, ROW2)
  assert.equal(slice.text, '2,beta\n')
  const route = await sliceOf(`&offset=${String(ROW2)}&length=${String(ROW3 - ROW2)}&rowStart=1`)
  assert.equal(route.text, '2,beta\n')
})

test('the end of the file keeps its last row even without a newline', async () => {
  const from = 20
  const slice = alignTextSlice(BYTES.subarray(from), from, BYTES.length)
  assert.equal(slice.eof, true)
  assert.equal(slice.text, '3,gamma', 'the fragment before the newline is dropped')
  assert.equal(slice.end, BYTES.length)
})

test('a multi-byte character is never split by a window edge', async () => {
  const text = 'a,b\n文,字\nc,d\n'
  const body = Buffer.from(text, 'utf8')
  // Cut inside the three bytes of 文: the fragment must not become text.
  const cut = 5
  const slice = alignTextSlice(body.subarray(0, cut), 0, body.length)
  assert.equal(slice.text, 'a,b\n')
  const next = alignTextSlice(body.subarray(cut, body.length), cut, body.length)
  assert.equal(next.start, 12, 'the row after the newline that follows 字')
  assert.equal(next.text, 'c,d\n')
})

test('a window past the end is empty and marked eof', async () => {
  const slice = await sliceOf(`&offset=${String(BYTES.length + 10)}`)
  assert.deepEqual(slice, { text: '', start: BYTES.length, end: BYTES.length, size: BYTES.length, eof: true })
})

test('offset and length are applied to the file bytes', async () => {
  const slice = await sliceOf(`&offset=${String(ROW1)}&length=8&rowStart=1`)
  assert.equal(slice.text, '1,alpha\n')
  assert.equal(slice.start, ROW1)
  assert.equal(slice.end, ROW2)
})

test('a length outside the allowed range is refused', async () => {
  for (const bad of ['0', String(TEXT_MAX_SLICE_BYTES + 1), '1.5', '-3']) {
    const response = await serveText(request(`${QUERY}&length=${bad}`), fakeFs())
    assert.equal(response.status, 400, `length ${bad}`)
  }
})

test('a bad offset, path, mapping or file is reported like the media route', async () => {
  assert.equal((await serveText(request(`${QUERY}&offset=-1`), fakeFs())).status, 400)
  assert.equal((await serveText(request('path=table.csv'), fakeFs())).status, 400)
  assert.equal((await serveText(request(''), fakeFs())).status, 400)
  assert.equal((await serveText(request(QUERY), fakeFs({ mapped: undefined }))).status, 422)
  assert.equal((await serveText(request(QUERY), fakeFs({ missing: true }))).status, 404)
})

test('the response is not cached', async () => {
  const response = await serveText(request(QUERY), fakeFs())
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
})
