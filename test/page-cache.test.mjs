/** Cursor-page cache: first page plus the neighbourhood of the current page. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trimPageCache } from '../src/client/kernel/page-cache.ts'

test('the cache keeps the first page and the current neighbourhood', () => {
  const cache = new Map([[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd'], [4, 'e']])
  trimPageCache(cache, 2)
  assert.deepEqual([...cache.keys()], [0, 1, 2, 3])
})

test('the first page keeps its next neighbour only', () => {
  const cache = new Map([[0, 'a'], [1, 'b'], [2, 'c']])
  trimPageCache(cache, 0)
  assert.deepEqual([...cache.keys()], [0, 1])
})
