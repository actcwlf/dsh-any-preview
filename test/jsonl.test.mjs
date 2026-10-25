/** JSONL parsing, column discovery and cell formatting. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectColumns,
  createJsonlConsumer,
  formatValue,
} from '../src/client/previews/jsonl/parse.ts'

/**
 * @param {readonly string[]} chunks - chunks in delivery order.
 * @param {number} [max] - record budget.
 * @returns {object} the finished consumer.
 */
function consume(chunks, max) {
  const model = createJsonlConsumer(max)
  for (const chunk of chunks) model.push(chunk)
  model.finish()
  return model
}

test('one record per line, parsed into values', () => {
  const model = consume(['{"a":1}\n{"a":2}\n'])
  assert.equal(model.records.length, 2)
  assert.deepEqual(model.records.map(record => record.value), [{ a: 1 }, { a: 2 }])
  assert.equal(model.invalid, 0)
})

test('a bad line is kept raw and counted, without stopping the stream', () => {
  const model = consume(['{"a":1}\nnot json\n{"a":3}\n'])
  assert.equal(model.records.length, 3)
  assert.equal(model.invalid, 1)
  assert.equal(model.records[1].raw, 'not json')
  assert.equal(typeof model.records[1].error, 'string')
  assert.deepEqual(model.records[2].value, { a: 3 })
})

test('blank lines are skipped but still advance the line number', () => {
  const model = consume(['{"a":1}\n\n{"b":2}\n'])
  assert.deepEqual(model.records.map(record => record.line), [1, 3])
})

test('records split across chunks are reassembled', () => {
  const model = consume(['{"a":', '1}\n{"b":', '2}\n'])
  assert.deepEqual(model.records.map(record => record.value), [{ a: 1 }, { b: 2 }])
})

test('the record budget truncates', () => {
  const model = consume(['{"a":1}\n{"a":2}\n{"a":3}\n'], 2)
  assert.equal(model.records.length, 2)
  assert.equal(model.truncated, true)
})

test('columns are collected in first-seen order and deduplicated', () => {
  const model = consume([
    '{"id":1,"name":"a"}\n',
    '{"name":"b","size":2}\n',
  ])
  assert.deepEqual(collectColumns(model.records), ['id', 'name', 'size'])
})

test('columns ignore non-object records and honour the limit', () => {
  const model = consume(['[1,2]\n3\n{"x":1,"y":2,"z":3}\n'])
  assert.deepEqual(collectColumns(model.records), ['x', 'y', 'z'])
  assert.deepEqual(collectColumns(model.records, 2), ['x', 'y'])
})

test('cell formatting keeps scalars readable and truncates structures', () => {
  assert.equal(formatValue('text'), 'text')
  assert.equal(formatValue(42), '42')
  assert.equal(formatValue(true), 'true')
  assert.equal(formatValue(null), 'null')
  assert.equal(formatValue(undefined), '')
  assert.deepEqual(formatValue({ a: 1 }), '{"a":1}')
  assert.equal(formatValue('x'.repeat(100)).length, 81)
  assert.ok(formatValue('x'.repeat(100)).endsWith('…'))
})
