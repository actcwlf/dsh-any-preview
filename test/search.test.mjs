/** Query compilation, match ranges and row selection. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileSearch,
  escapeRegExp,
  hasMatch,
  matchRanges,
  matchingIndices,
} from '../src/client/kernel/search.ts'

const options = (query, extra = {}) => ({ query, regex: false, caseSensitive: false, ...extra })

test('an empty query compiles to nothing', () => {
  assert.equal(compileSearch(options('')), undefined)
  assert.equal(compileSearch(options('   ')), undefined)
})

test('literal mode escapes regex metacharacters', () => {
  assert.equal(escapeRegExp('a.b*c'), 'a\\.b\\*c')
  const pattern = compileSearch(options('a.b'))
  assert.ok(pattern)
  assert.equal(hasMatch('xa.by', pattern), true)
  assert.equal(hasMatch('axby', pattern), false)
})

test('regex mode compiles the query as written', () => {
  const pattern = compileSearch(options('a+', { regex: true }))
  assert.ok(pattern)
  assert.equal(hasMatch('aaa', pattern), true)
})

test('an invalid regex is treated as no query', () => {
  assert.equal(compileSearch(options('([', { regex: true })), undefined)
})

test('case sensitivity follows the toggle', () => {
  assert.equal(hasMatch('ABC', compileSearch(options('abc'))), true)
  assert.equal(hasMatch('ABC', compileSearch(options('abc', { caseSensitive: true }))), false)
})

test('every non-overlapping match is returned in order', () => {
  const pattern = compileSearch(options('an'))
  assert.deepEqual(matchRanges('an an an', pattern), [
    { start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 },
  ])
})

test('matches do not overlap', () => {
  const pattern = compileSearch(options('aa'))
  assert.deepEqual(matchRanges('aaaa', pattern), [{ start: 0, end: 2 }, { start: 2, end: 4 }])
})

test('a zero-width pattern terminates instead of looping', () => {
  const pattern = compileSearch(options('x*', { regex: true }))
  assert.deepEqual(matchRanges('abc', pattern), [])
})

test('row selection reports the matching indices', () => {
  const pattern = compileSearch(options('beta'))
  assert.deepEqual(matchingIndices(['alpha', 'beta', 'gamma', 'beta again'], pattern), [1, 3])
  assert.deepEqual(matchingIndices(['alpha'], pattern), [])
})
