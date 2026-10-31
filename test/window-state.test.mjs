/** Window arithmetic: which rows a viewport needs, where they sit, and the cache key. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheCapacity, logicalRow, planWindow, proportionalGeometry, stickyBand, windowedBodyRows,
} from '../src/client/kernel/window-state.ts'

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

test('a table past the scroll limit gets a proportional scrollbar', () => {
  const bodyRows = 2_000_000
  const geometry = proportionalGeometry(bodyRows, 720, ROW, 16_777_216)
  assert.equal(geometry.contentHeight, 16_777_216, 'the content stays inside the cap')
  assert.equal(geometry.maxScroll, 16_777_216 - 720)
  assert.equal(geometry.visibleRows, Math.floor(720 / ROW))
  // A scroll pixel is worth `pitch` rows, so the row at the top is exact.
  assert.ok(Math.abs(geometry.pitch - geometry.maxScroll / (bodyRows - geometry.visibleRows)) < 1e-9)
})

test('the proportional mapping starts at the first row and ends on the last screen', () => {
  const bodyRows = 2_000_000
  const geometry = proportionalGeometry(bodyRows, 720, ROW, 16_777_216)
  assert.equal(logicalRow(0, geometry, bodyRows), 0)
  // Full scroll must land on the last screen, not `visibleRows` short of it.
  assert.equal(logicalRow(geometry.maxScroll, geometry, bodyRows), bodyRows - geometry.visibleRows)
  assert.equal(logicalRow(geometry.maxScroll / 2, geometry, bodyRows), (bodyRows - geometry.visibleRows) / 2)
  // Out-of-range scroll offsets clamp instead of running past the file.
  assert.equal(logicalRow(-100, geometry, bodyRows), 0)
  assert.equal(logicalRow(1e12, geometry, bodyRows), bodyRows - geometry.visibleRows)
})

test('the pinned band covers the viewport and reaches the last row', () => {
  const bodyRows = 2_000_000
  const geometry = proportionalGeometry(bodyRows, 720, ROW, 16_777_216)
  const top = stickyBand(0, bodyRows, geometry.visibleRows, ROW, 8)
  assert.equal(top.first, 0)
  assert.equal(top.offset, 0)
  assert.ok(top.count >= geometry.visibleRows)

  const middle = stickyBand(1_000_000.5, bodyRows, geometry.visibleRows, ROW, 8)
  assert.equal(middle.first, 1_000_000 - 8)
  assert.equal(middle.count, geometry.visibleRows + 8 + 8 + 1)
  assert.ok(Math.abs(middle.offset - (8 * ROW + 0.5 * ROW)) < 1e-9, 'the fractional row lines up')

  const end = stickyBand(bodyRows - geometry.visibleRows, bodyRows, geometry.visibleRows, ROW, 8)
  assert.equal(end.first + end.count, bodyRows, 'every row to the last is painted')
  assert.equal(end.offset, 8 * ROW)
})

test('a band never paints past either end of the table', () => {
  const negative = stickyBand(-5, 100, 10, ROW, 4)
  assert.equal(negative.first, 0)
  assert.equal(negative.offset, 0)
  const beyond = stickyBand(1_000, 100, 10, ROW, 4)
  assert.ok(beyond.first + beyond.count <= 100)
  assert.ok(beyond.offset >= 0)
})

