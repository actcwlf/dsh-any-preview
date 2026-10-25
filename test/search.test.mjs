/** Row filtering shared by every preview's search field. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterRows, normalizeQuery } from '../src/client/kernel/search.ts'

const ROWS = ['alpha one', 'beta two', 'Gamma three']

test('an empty query keeps every row and its index', () => {
  const result = filterRows(ROWS, '', row => row)
  assert.deepEqual(result.rows, ROWS)
  assert.deepEqual(result.indices, [0, 1, 2])
})

test('a query keeps only matching rows, with original indices', () => {
  const result = filterRows(ROWS, 'two', row => row)
  assert.deepEqual(result.rows, ['beta two'])
  assert.deepEqual(result.indices, [1])
})

test('matching is case-insensitive in both directions', () => {
  assert.deepEqual(filterRows(ROWS, 'GAMMA', row => row).indices, [2])
  assert.deepEqual(filterRows(['UPPER'], 'upper', row => row).indices, [0])
})

test('the query is trimmed before matching', () => {
  assert.deepEqual(filterRows(ROWS, '  beta  ', row => row).indices, [1])
  assert.deepEqual(filterRows(ROWS, '   ', row => row).indices, [0, 1, 2])
})

test('no match yields no rows', () => {
  const result = filterRows(ROWS, 'zzz', row => row)
  assert.deepEqual(result.rows, [])
  assert.deepEqual(result.indices, [])
})

test('the searchable text is supplied per row', () => {
  const rows = [{ a: 'x', b: 'needle' }, { a: 'needle', b: 'y' }]
  assert.deepEqual(filterRows(rows, 'needle', row => `${row.a} ${row.b}`).indices, [0, 1])
})

test('normalizeQuery lowercases and trims', () => {
  assert.equal(normalizeQuery('  MiXeD  '), 'mixed')
})
