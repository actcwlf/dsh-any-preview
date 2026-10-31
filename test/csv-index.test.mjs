/** The sparse CSV row index: anchors, quote awareness and estimation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCsvIndex } from '../src/client/kernel/csv-index.ts'

test('anchors land on row boundaries every stride', () => {
  const index = createCsvIndex(2)
  index.push('a\nb\nc\nd\ne\n')
  assert.equal(index.rows, 5)
  assert.deepEqual(index.anchors.map(anchor => anchor.row), [0, 2, 4])
  assert.deepEqual(index.anchors.map(anchor => anchor.offset), [0, 4, 8])
})

test('a newline inside quotes does not create a row', () => {
  const index = createCsvIndex(1)
  index.push('id,note\n1,"two\nlines"\n2,ok\n')
  assert.equal(index.rows, 3, 'header, the quoted row, and one plain row')
})

test('feeding in pieces gives the same anchors as one push', () => {
  const whole = createCsvIndex(2)
  whole.push('a\nb\nc\nd\ne\nf\n')
  // push() takes the accumulated text, the way the document layer delivers it.
  const pieces = createCsvIndex(2)
  for (const piece of ['a\nb', 'a\nb\nc\nd\n', 'a\nb\nc\nd\ne\nf\n']) pieces.push(piece)
  assert.deepEqual(pieces.anchors, whole.anchors)
  assert.equal(pieces.rows, whole.rows)
})

test('anchorBefore finds the nearest anchor at or before a row', () => {
  const index = createCsvIndex(10)
  index.push(`${'x\n'.repeat(100)}`)
  assert.equal(index.anchorBefore(0)?.row, 0)
  assert.equal(index.anchorBefore(35)?.row, 30)
  assert.equal(index.anchorBefore(1000)?.row, 100)
})

test('estimateRows scales the observed density', () => {
  const index = createCsvIndex(10)
  index.push('ab\ncd\n')
  const rows = index.estimateRows(100)
  assert.ok(rows > 30 && rows < 70, `estimated ${String(rows)}`)
})

test('scanned follows the text consumed, character for character', () => {
  const index = createCsvIndex(2)
  index.push('a\nb\n')
  assert.equal(index.scanned, 4)
  index.push('a\nb\nc\nd\n')
  assert.equal(index.scanned, 8)
  index.push('a\nb\nc\nd\n')
  assert.equal(index.scanned, 8, 'a repeated push scans nothing new')
})