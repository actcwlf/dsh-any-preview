/** Log tail-follow rules: at-bottom detection and the follow flag. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followAfterScroll, isAtBottom } from '../src/client/previews/log/follow.ts'

test('the last row being visible counts as the bottom', () => {
  assert.equal(isAtBottom(800, 1000, 200), true)
  assert.equal(isAtBottom(700, 1000, 200), false)
})

test('a list shorter than the viewport is always at the bottom', () => {
  assert.equal(isAtBottom(0, 120, 200), true)
})

test('the threshold tolerates a few pixels of slack', () => {
  assert.equal(isAtBottom(780, 1000, 200), true) // 20 px short
  assert.equal(isAtBottom(700, 1000, 200), false) // 100 px short
})

test('reading history turns follow off', () => {
  assert.equal(followAfterScroll({ follow: true, manualOff: false, atBottom: false }), false)
})

test('returning to the bottom turns follow back on', () => {
  assert.equal(followAfterScroll({ follow: false, manualOff: false, atBottom: true }), true)
})

test('a manual opt-out is never overridden by scrolling', () => {
  assert.equal(followAfterScroll({ follow: false, manualOff: true, atBottom: true }), false)
})
