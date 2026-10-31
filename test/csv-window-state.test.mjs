/** Window arithmetic: which rows a viewport needs, where they sit, and the cache key. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheCapacity, planWindow, scaledRowHeight, windowedBodyRows,
} from '../src/client/kernel/csv-window-state.ts'

const ROW = 22
const VIEWPORT = 660

test('the top of the file asks for the first window', () => {
  const plan = planWindow(0, VIEWPORT, ROW, 5000, 300_000)
  assert.equal(plan.alignedStart, 0)
  assert.equal(plan.window, 0)
  assert.ok(plan.count >= 5000, 'a window is read whole, not just the viewport band')
})

test('a scrolled viewport asks for the window containing its first row', () => {
  for (const row of [0, 1, 4999, 5000, 5001, 200_000, 299_999]) {
    const plan = planWindow(row * ROW, VIEWPORT, ROW, 5000, 300_000)
    assert.equal(plan.alignedStart, Math.floor(row / 5000) * 5000, `row ${String(row)}`)
    assert.ok(plan.alignedStart <= row)
  }
})

test('a read window covers every scroll position inside it', () => {
  // The cache is keyed by window, so a read has to serve the whole window plus the
  // band the viewport reaches past its end — otherwise scrolling inside a cached
  // window paints blank rows.
  const size = 5000
  const viewportRows = Math.ceil(VIEWPORT / ROW) + 1
  for (const row of [0, 10, 4900, 4999, 5000, 5100]) {
    const plan = planWindow(row * ROW, VIEWPORT, ROW, size, 300_000)
    const windowEnd = plan.alignedStart + size
    assert.ok(plan.alignedStart + plan.count >= windowEnd + viewportRows,
      `row ${String(row)}: read covers the window and the viewport below it`)
  }
})

test('the end of the file is clamped instead of overrunning', () => {
  const total = 1000
  const plan = planWindow((total - 1) * ROW, VIEWPORT, ROW, 5000, total)
  assert.equal(plan.alignedStart, 0)
  assert.equal(plan.count, total)
})

test('an empty file asks for nothing', () => {
  const plan = planWindow(0, VIEWPORT, ROW, 5000, 0)
  assert.equal(plan.count, 0)
})

test('the cache stays bounded no matter the window size', () => {
  assert.ok(cacheCapacity(5000) <= 32)
  assert.ok(cacheCapacity(50_000) >= 4)
})

/** One window of `count` rows starting at file row `start`; cells carry the row number. */
function readRows(start, count) {
  return Array.from({ length: count }, (_unused, offset) => [String(start + offset), `cell ${String(start + offset)}`])
}

test('body row 0 is file row 1: the header is drawn by the table, not the body', () => {
  const body = windowedBodyRows(readRows(0, 5000), 0, 120_000, { first: 0, last: 3 }, ROW, false, 2)
  assert.deepEqual(body.rows.map(row => row.index), [0, 1, 2])
  assert.equal(body.rows[0].cells[0], '1', 'file row 1 is the first row under the header')
  assert.equal(body.rows[2].cells[0], '3')
  assert.equal(body.topPad, 0)
  assert.equal(body.bottomPad, (119_999 - 3) * ROW)
})

test('a window far into the file keeps absolute row numbers', () => {
  const body = windowedBodyRows(readRows(95_000, 5000), 95_000, 120_001, { first: 99_000, last: 99_002 }, ROW, false, 2)
  assert.deepEqual(body.rows.map(row => row.index), [99_000, 99_001])
  assert.equal(body.rows[0].cells[0], '99001', 'body row 99,000 is file row 99,001')
  assert.equal(body.topPad, 99_000 * ROW)
  // Filler above, the painted band, and filler below add up to the whole file.
  assert.equal(body.topPad + body.rows.length * ROW + body.bottomPad, 120_000 * ROW)
})

test('rows outside the read window paint as placeholders instead of wrong rows', () => {
  const body = windowedBodyRows(readRows(5000, 5000), 5000, 20_000, { first: 4000, last: 4002 }, ROW, false, 2)
  assert.deepEqual(body.rows.map(row => row.cells), [null, null], 'body rows 4,000 and 4,001 live in file rows 4,001-4,002, before this window')
  const past = windowedBodyRows(readRows(5000, 3), 5000, 20_000, { first: 6000, last: 6001 }, ROW, false, 2)
  assert.deepEqual(past.rows[0].cells, null, 'past the window end')
})

test('a window still loading paints placeholders for the band', () => {
  const body = windowedBodyRows([], 0, 120_000, { first: 10, last: 40 }, ROW, true, 3)
  assert.equal(body.rows.length, 30)
  for (const row of body.rows) assert.equal(row.cells, null)
  assert.equal(body.topPad, 10 * ROW)
  // Filler above, placeholders, and filler below still add up to the whole file.
  assert.equal(body.topPad + body.rows.length * ROW + body.bottomPad, 119_999 * ROW)
})

test('a short row is padded to the header width and a long one is not cut', () => {
  const body = windowedBodyRows([['h'], ['1', 'a'], ['2', 'b', 'c', 'd']], 0, 10, { first: 0, last: 2 }, ROW, false, 3)
  assert.deepEqual(body.rows[0].cells, ['1', 'a', ''])
  assert.deepEqual(body.rows[1].cells, ['2', 'b', 'c', 'd'])
})

test('an empty table paints nothing', () => {
  const body = windowedBodyRows([], 0, 1, { first: 0, last: 0 }, ROW, false, 3)
  assert.deepEqual(body.rows, [])
  assert.equal(body.topPad, 0)
  assert.equal(body.bottomPad, 0)
})

test('rows keep their natural height below the browser scroll limit', () => {
  assert.equal(scaledRowHeight(0, ROW, 16_777_216, 6), ROW)
  assert.equal(scaledRowHeight(1000, ROW, 16_777_216, 6), ROW)
  // 762,600 rows is where 22px rows exactly reach 2^24.
  assert.equal(scaledRowHeight(762_000, ROW, 16_777_216, 6), ROW)
})

test('a huge table shrinks its rows so its end stays reachable', () => {
  const rows = 1_000_000
  const height = scaledRowHeight(rows, ROW, 16_777_216, 6)
  assert.ok(height < ROW)
  assert.ok(rows * height <= 16_777_216 + 1)
  // Proportional: the scrollbar spans the same fraction of the file either way.
  assert.ok(Math.abs(height / ROW - 16_777_216 / (rows * ROW)) < 1e-9)
})

test('the scaled row height never collapses below the floor', () => {
  assert.equal(scaledRowHeight(50_000_000, ROW, 16_777_216, 6), 6)
})
