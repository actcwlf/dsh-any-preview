/** Incremental line splitting across arbitrary chunk boundaries. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLineConsumer } from '../src/client/kernel/lines.ts'

/**
 * @param {readonly string[]} chunks - chunks in delivery order.
 * @returns {string[]} the lines the consumer produced.
 */
function split(chunks) {
  const lines = []
  const consumer = createLineConsumer(line => lines.push(line))
  for (const chunk of chunks) consumer.push(chunk)
  consumer.finish()
  return lines
}

test('a whole text yields one entry per line', () => {
  assert.deepEqual(split(['a\nb\nc\n']), ['a', 'b', 'c'])
})

test('a trailing line without a terminator is flushed by finish', () => {
  assert.deepEqual(split(['a\nb']), ['a', 'b'])
})

test('CRLF is stripped, including when split between the two characters', () => {
  assert.deepEqual(split(['a\r', '\nb\r\nc']), ['a', 'b', 'c'])
})

test('a line split across chunks is reassembled once', () => {
  assert.deepEqual(split(['hel', 'lo\nwor', 'ld\n']), ['hello', 'world'])
})

test('empty lines are kept', () => {
  assert.deepEqual(split(['a\n\nb\n']), ['a', '', 'b'])
})

test('an empty input produces no lines', () => {
  assert.deepEqual(split(['']), [])
  assert.deepEqual(split([]), [])
})

test('finish is idempotent', () => {
  const lines = []
  const consumer = createLineConsumer(line => lines.push(line))
  consumer.push('only')
  consumer.finish()
  consumer.finish()
  assert.deepEqual(lines, ['only'])
})

test('every two-way split yields the same lines', () => {
  const text = 'alpha\nbeta\r\ngamma\ndelta'
  const expected = split([text])
  for (let cut = 0; cut <= text.length; cut += 1) {
    assert.deepEqual(split([text.slice(0, cut), text.slice(cut)]), expected, `cut at ${String(cut)}`)
  }
})
