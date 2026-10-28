/** Fixed-height window arithmetic used by the table previews. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowRange } from '../src/client/kernel/window.ts'

const geometry = { rowHeight: 20, viewportHeight: 200, overscan: 2 }

test('a viewport at the top renders the first screen plus overscan', () => {
  const range = windowRange({ ...geometry, scrollTop: 0, rowCount: 1000 })
  assert.equal(range.first, 0)
  assert.equal(range.last, 12) // 10 visible + 2 overscan
  assert.equal(range.topPad, 0)
  assert.equal(range.bottomPad, (1000 - 12) * 20)
})

test('a scrolled viewport renders its screen plus overscan on both sides', () => {
  const range = windowRange({ ...geometry, scrollTop: 1000, rowCount: 1000 })
  assert.equal(range.first, 48) // 50 - 2
  assert.equal(range.last, 62) // 60 + 2
  assert.equal(range.topPad, 48 * 20)
})

test('the last screen is clamped to the row count', () => {
  const range = windowRange({ ...geometry, scrollTop: 19_800, rowCount: 1000 })
  assert.equal(range.last, 1000)
  assert.equal(range.bottomPad, 0)
})

test('a list shorter than the viewport renders every row', () => {
  const range = windowRange({ ...geometry, scrollTop: 0, rowCount: 3 })
  assert.equal(range.first, 0)
  assert.equal(range.last, 3)
  assert.equal(range.bottomPad, 0)
})

test('an empty list renders nothing', () => {
  assert.deepEqual(windowRange({ ...geometry, scrollTop: 0, rowCount: 0 }), {
    first: 0, last: 0, topPad: 0, bottomPad: 0,
  })
})

test('scrolling past the end cannot escape the row count', () => {
  const range = windowRange({ ...geometry, scrollTop: 999_999, rowCount: 100 })
  assert.equal(range.first, 100)
  assert.equal(range.last, 100)
  assert.equal(range.bottomPad, 0)
})

test('an unmeasured viewport still renders the overscan band', () => {
  const range = windowRange({ ...geometry, viewportHeight: 0, scrollTop: 0, rowCount: 50 })
  assert.equal(range.first, 0)
  assert.equal(range.last, 2)
})
