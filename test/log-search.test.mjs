/** Log full-search: one result per matching line. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOG_MATCH_LIMIT, matchLogLines, matchLogPage, scanLogText } from '../src/client/previews/log/search.ts'

test('a line is one result even when the pattern occurs several times', () => {
  const result = matchLogLines(['error error error', 'ok', 'error'], /error/gu)
  assert.equal(result.total, 2)
  assert.deepEqual(result.lines, [0, 2])
})

test('the navigation cap holds while the total stays whole', () => {
  const result = matchLogLines(['a', 'a', 'a'], /a/gu, 1)
  assert.equal(result.total, 3)
  assert.deepEqual(result.lines, [0])
  assert.deepEqual(result.pages, [1, 2])
  assert.equal(LOG_MATCH_LIMIT, 5_000)
})

test('a later log page starts at its line cursor', () => {
  assert.deepEqual(matchLogPage(['a', 'b', 'a', 'a'], /a/gu, 2, 2), [2, 3])
})

test('line anchors and case sensitivity are applied per line', () => {
  assert.deepEqual(matchLogLines(['Error', 'error'], /^error$/gu).lines, [1])
  assert.deepEqual(matchLogLines(['Error', 'error'], /^error$/giu).lines, [0, 1])
})

test('text scanning publishes one complete slice', async () => {
  let published = -1
  const result = await scanLogText('a\nb\na\n', /a/gu, {
    signal: new AbortController().signal,
    lineLimit: 10,
    onSlice: (progress, matches, lines) => {
      published = progress
      assert.equal(matches, 2)
      assert.deepEqual(lines, [0, 2])
    },
  })
  assert.equal(published, 1)
  assert.deepEqual(result, { matches: 2, lines: [0, 2], pages: [] })
})
