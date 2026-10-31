/** The row parser's budgets: row count and single-line length. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRowBuffer } from '../src/client/kernel/text-pipeline.ts'

test('rows stop at the row budget', () => {
  const buffer = createRowBuffer(',', 3)
  buffer.push('a,b\n1,2\n3,4\n5,6\n')
  buffer.finish()
  assert.equal(buffer.rows.length, 3)
  assert.equal(buffer.truncated, true)
  assert.equal(buffer.overlong, false)
})

test('a line over the cap stops parsing instead of growing', () => {
  const buffer = createRowBuffer(',', 100, 64)
  buffer.push('x'.repeat(200))
  assert.equal(buffer.overlong, true)
  assert.equal(buffer.truncated, true)
  assert.equal(buffer.rows.length, 0, 'the overlong row is not kept')
})

test('long lines under the cap still parse', () => {
  const buffer = createRowBuffer(',', 100, 1024)
  buffer.push(`a,${'y'.repeat(500)}\n1,2\n`)
  buffer.finish()
  assert.equal(buffer.overlong, false)
  assert.deepEqual(buffer.rows, [['a', 'y'.repeat(500)], ['1', '2']])
})

test('the line counter resets at every newline', () => {
  const buffer = createRowBuffer(',', 100, 10)
  buffer.push('1234567890\n1234567890\n')
  buffer.finish()
  assert.equal(buffer.overlong, false)
  assert.equal(buffer.rows.length, 2)
})