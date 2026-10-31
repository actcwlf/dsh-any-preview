/** Window reads must agree with a full parse at every offset. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCsvIndex } from '../src/client/kernel/csv-index.ts'
import { readWindow } from '../src/client/kernel/csv-window.ts'

function build(rows) {
  const lines = ['id,name,note']
  for (let i = 1; i <= rows; i++) lines.push(`${i},user_${i},"note ${i}, with comma"`)
  return `${lines.join('\n')}\n`
}

test('a window equals the same rows from a full parse', () => {
  const text = build(500)
  const index = createCsvIndex(50)
  index.push(text)

  const window = readWindow(text, index, 100, 25, ',')
  assert.equal(window.startRow, 100)
  assert.equal(window.rows.length, 25)
  // Row 0 is the header, so row 100 is data row id 100.\n  assert.deepEqual(window.rows[0], ['100', 'user_100', 'note 100, with comma'])
  assert.deepEqual(window.rows[24], ['124', 'user_124', 'note 124, with comma'])
})

test('a window in the middle of a long line of anchors still lines up', () => {
  const text = build(1000)
  const index = createCsvIndex(100)
  index.push(text)
  for (const start of [1, 99, 100, 101, 500, 990, 999]) {
    const window = readWindow(text, index, start, 3, ',')
    const expectedId = String(start)
    assert.equal(window.rows[0]?.[0], expectedId, `window at ${String(start)}`)
  }
})

test('a window past the end returns what exists, not an error', () => {
  const text = build(10)
  const index = createCsvIndex(5)
  index.push(text)
  const window = readWindow(text, index, 8, 100, ',')
  assert.equal(window.rows.length, 3, 'rows 8, 9 and 10 remain')
})

test('a last line without a newline is still a row', () => {
  const text = 'id,name\n1,alpha\n2,beta'
  const index = createCsvIndex(1)
  index.push(text)
  assert.equal(index.rows, 2, 'the index counts newlines, so it sees two rows')
  const window = readWindow(text, index, 0, 10, ',')
  assert.deepEqual(window.rows.map(row => row[0]), ['id', '1', '2'])
  const tail = readWindow(text, index, 2, 10, ',')
  assert.deepEqual(tail.rows, [['2', 'beta']])
})

test('a window that starts on the unterminated last row finds nothing', () => {
  const text = 'id,name\n1,alpha'
  const index = createCsvIndex(1)
  index.push(text)
  const window = readWindow(text, index, 2, 10, ',')
  assert.deepEqual(window.rows, [])
})

test('one enormous row stops the window parse instead of growing without bound', () => {
  const text = `id,note\n1,${'x'.repeat(200)}\n2,ok\n`
  const index = createCsvIndex(1)
  index.push(text)
  const window = readWindow(text, index, 0, 10, ',', 64)
  assert.equal(window.overlong, true)
  assert.ok(window.rows.length <= 2, `stopped after ${String(window.rows.length)} rows`)
  const plain = readWindow(text, index, 0, 10, ',')
  assert.equal(plain.overlong, false)
  assert.equal(plain.rows.length, 3)
})