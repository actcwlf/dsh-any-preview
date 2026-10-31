/** Window arithmetic: which rows a viewport needs, and the cache key. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cacheCapacity, placeholderRows, planWindow } from '../src/client/kernel/csv-window-state.ts'

const ROW = 22
const VIEWPORT = 660

test('the top of the file asks for the first window', () => {
  const plan = planWindow(0, VIEWPORT, ROW, 5000, 300_000)
  assert.equal(plan.alignedStart, 0)
  assert.equal(plan.window, 0)
  assert.ok(plan.count >= Math.ceil(VIEWPORT / ROW))
})

test('a scrolled viewport asks for the window containing its first row', () => {
  const row = 200_000
  const plan = planWindow(row * ROW, VIEWPORT, ROW, 5000, 300_000)
  assert.equal(plan.window, Math.floor((row - 40) / 5000))
  assert.ok(plan.alignedStart <= row)
  assert.ok(plan.alignedStart + plan.count >= row)
})

test('the end of the file is clamped instead of overrunning', () => {
  const total = 1000
  const plan = planWindow((total - 1) * ROW, VIEWPORT, ROW, 5000, total)
  assert.equal(plan.alignedStart, 0)
  assert.equal(plan.count, total)
})

test('placeholders match the requested count and are empty', () => {
  const rows = placeholderRows(5)
  assert.equal(rows.length, 5)
  assert.deepEqual(rows[0], [])
})

test('the cache stays bounded no matter the window size', () => {
  assert.ok(cacheCapacity(5000) <= 32)
  assert.ok(cacheCapacity(50_000) >= 4)
})