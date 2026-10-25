/**
 * Incremental parsing must agree with whole-string parsing at every possible
 * chunk boundary — that is the whole point of the pipeline, and the one thing
 * that silently breaks when quote and CRLF state is mishandled.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRowBuffer, createRowParser } from '../src/client/kernel/text-pipeline.ts'

const SAMPLE = [
  'name,city,note',
  '"Ada, Lovelace",London,"quoted ""inside"""',
  'Grace,New York,',
  'Linus',
  '',
].join('\n')

/**
 * Parse the given chunks and return the rows.
 * @param {readonly string[]} chunks - text chunks in delivery order.
 * @param {string} [delimiter] - field separator.
 * @returns {string[][]} parsed rows.
 */
function collect(chunks, delimiter = ',') {
  const rows = []
  const parser = createRowParser(delimiter, cells => rows.push([...cells]))
  for (const chunk of chunks) parser.push(chunk)
  parser.finish()
  return rows
}

test('whole-string parse matches the expected table', () => {
  assert.deepEqual(collect([SAMPLE]), [
    ['name', 'city', 'note'],
    ['Ada, Lovelace', 'London', 'quoted "inside"'],
    ['Grace', 'New York', ''],
    ['Linus'],
  ])
})

test('every two-way split yields the same table', () => {
  const expected = collect([SAMPLE])
  for (let cut = 0; cut <= SAMPLE.length; cut += 1) {
    assert.deepEqual(
      collect([SAMPLE.slice(0, cut), SAMPLE.slice(cut)]),
      expected,
      `split at ${String(cut)} (${JSON.stringify(SAMPLE.slice(Math.max(0, cut - 3), cut + 3))})`,
    )
  }
})

test('three-way splits around quoted boundaries stay stable', () => {
  const expected = collect([SAMPLE])
  const cuts = [0, 1, 26, 27, 28, 30, 52, 53, 54, 55, SAMPLE.length]
  for (const first of cuts) {
    for (const second of cuts) {
      if (second < first) continue
      assert.deepEqual(
        collect([SAMPLE.slice(0, first), SAMPLE.slice(first, second), SAMPLE.slice(second)]),
        expected,
        `splits at ${String(first)}, ${String(second)}`,
      )
    }
  }
})

test('a quote split across a chunk boundary is an escape, not a closer', () => {
  // The first chunk ends immediately after the first quote of an escaped pair.
  assert.deepEqual(collect(['a,"x""', 'y",b']), [['a', 'x"y', 'b']])
})

test('CRLF split between the two characters is still one line break', () => {
  assert.deepEqual(collect(['a,b\r', '\nc,d']), [['a', 'b'], ['c', 'd']])
})

test('a trailing quoted field without a newline is flushed by finish', () => {
  assert.deepEqual(collect(['a,"b,c"']), [['a', 'b,c']])
})

test('tab-delimited input honours its delimiter', () => {
  assert.deepEqual(collect(['a\tb\n1\t2'], '\t'), [['a', 'b'], ['1', '2']])
})

test('row budget stops accumulation and reports truncation', () => {
  const buffer = createRowBuffer(',', 2)
  buffer.push('a,b\nc,d\ne,f\n')
  buffer.finish()
  assert.equal(buffer.rows.length, 2)
  assert.equal(buffer.truncated, true)
  assert.equal(buffer.complete, true)
})

test('a file exactly at the budget is not reported truncated', () => {
  const buffer = createRowBuffer(',', 2)
  buffer.push('a,b\nc,d\n')
  buffer.finish()
  assert.equal(buffer.rows.length, 2)
  assert.equal(buffer.truncated, false)
})

test('finish is idempotent and never duplicates the trailing row', () => {
  const buffer = createRowBuffer(',', 10)
  buffer.push('a,b\nc')
  buffer.finish()
  buffer.finish()
  assert.deepEqual(buffer.rows, [['a', 'b'], ['c']])
})
