/** CSV A2 search: cell occurrences, row results, occurrence navigation. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CSV_OCCURRENCE_LIMIT, matchCsvPage, matchCsvRows } from '../src/client/previews/csv/match.ts'

test('a query matches cell occurrences and reports both counts', () => {
  const result = matchCsvRows([['foo', 'bar'], ['foo foo foo']], /foo/gu)
  assert.deepEqual(result.rows, [0, 1])
  assert.equal(result.total, 4)
  assert.deepEqual(result.occurrences, [
    { row: 0, cell: 0, start: 0, end: 3 },
    { row: 1, cell: 0, start: 0, end: 3 },
    { row: 1, cell: 0, start: 4, end: 7 },
    { row: 1, cell: 0, start: 8, end: 11 },
  ])
})

test('a phrase spanning two cells does not match', () => {
  const result = matchCsvRows([['foo', 'bar']], /foo bar/gu)
  assert.deepEqual(result.rows, [])
  assert.equal(result.total, 0)
})

test('the navigation cap keeps the full occurrence count', () => {
  const result = matchCsvRows([['aa', 'aa'], ['aa']], /aa/gu, 2)
  assert.equal(result.total, 3)
  assert.equal(result.occurrences.length, 2)
  assert.equal(result.rows.length, 2)
  assert.deepEqual(result.pages, [{ row: 1, cell: 0, start: 0, end: 2 }])
  assert.equal(CSV_OCCURRENCE_LIMIT, 5_000)
})

test('a later page starts at the captured cursor', () => {
  const rows = [['aa', 'aa'], ['aa']]
  const cursor = { row: 1, cell: 0, start: 0, end: 2 }
  assert.deepEqual(matchCsvPage(rows, /aa/gu, cursor, 2), [
    { row: 1, cell: 0, start: 0, end: 2 },
  ])
})

test('anchors apply per cell, not to the joined row', () => {
  const result = matchCsvRows([['foo', 'bar']], /^foo$/gu)
  assert.equal(result.total, 1)
  assert.deepEqual(result.rows, [0])
})

test('case and regex modes are already compiled by the caller', () => {
  assert.equal(matchCsvRows([['Alpha']], /alpha/gu).total, 0)
  assert.equal(matchCsvRows([['Alpha']], /alpha/giu).total, 1)
  assert.equal(matchCsvRows([['a1', 'a2']], /a\d/gu).total, 2)
})
