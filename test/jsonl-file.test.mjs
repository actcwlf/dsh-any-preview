/** JSONL file-source parsing and record classification. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJsonlConsumer, parseJsonlRecord } from '../src/client/previews/jsonl/parse.ts'
import { parseJsonlSlice } from '../src/client/previews/jsonl/rows.ts'

test('a JSONL slice keeps one raw line per row', () => {
  assert.deepEqual(parseJsonlSlice('{"a":1}\n{"a":2}\n').rows, [['{"a":1}'], ['{"a":2}']])
})

test('a record is parsed with its source line number', () => {
  const record = parseJsonlRecord(7, '{"a":1}')
  assert.equal(record?.line, 7)
  assert.deepEqual(record?.value, { a: 1 })
  assert.equal(record?.error, undefined)
})

test('a blank line is not a record, and a bad line keeps its error', () => {
  assert.equal(parseJsonlRecord(1, '   '), undefined)
  const bad = parseJsonlRecord(2, '{bad')
  assert.match(bad?.error ?? '', /JSON/u)
})

test('the consumer reports completion after finish', () => {
  const consumer = createJsonlConsumer()
  consumer.push('{"a":1}\n')
  assert.equal(consumer.complete, false)
  consumer.finish()
  assert.equal(consumer.complete, true)
  assert.equal(consumer.records.length, 1)
})
