/** JSONL record search: one result per non-empty raw line. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSONL_MATCH_LIMIT, matchJsonlLines, matchJsonlPage, scanJsonlText } from '../src/client/previews/jsonl/search.ts'

test('a record is one result even when the query occurs several times', () => {
  const result = matchJsonlLines(['{"a":"x x x"}', '{"a":"y"}', '{"a":"x"}'], /x/gu)
  assert.equal(result.total, 2)
  assert.deepEqual(result.lines, [0, 2])
})

test('blank lines are skipped and a bad line still matches as raw text', () => {
  const result = matchJsonlLines(['', '  ', '{bad x', '{"a":1}'], /x/gu)
  assert.equal(result.total, 1)
  assert.deepEqual(result.lines, [2])
})

test('the navigation cap holds while the total stays whole', () => {
  const result = matchJsonlLines(['a', 'a', 'a'], /a/gu, 1)
  assert.equal(result.total, 3)
  assert.deepEqual(result.lines, [0])
  assert.deepEqual(result.pages, [1, 2])
  assert.equal(JSONL_MATCH_LIMIT, 5_000)
})

test('a later JSONL page starts at its line cursor and skips blanks', () => {
  assert.deepEqual(matchJsonlPage(['', 'a', '', 'a', 'a'], /a/gu, 1, 2), [1, 3])
})

test('text scanning reports the complete record set', async () => {
  const result = await scanJsonlText('{"a":"x"}\n\n{bad x}\n', /x/gu, {
    signal: new AbortController().signal,
    lineLimit: 10,
    onSlice: () => {},
  })
  assert.deepEqual(result, { matches: 2, lines: [0, 2], pages: [] })
})
