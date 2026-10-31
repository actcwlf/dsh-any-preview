/** The large-text scan: counts whole-text matches, reports progress, can be aborted. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLineCounter, scanText } from '../src/client/kernel/search-scan.ts'

test('matches are counted across the whole text', async () => {
  const text = ('alpha beta alpha gamma alpha\n').repeat(50)
  const result = await scanText(text, /alpha/gu, { chunk: 1024 })
  assert.equal(result.completed, true)
  assert.equal(result.matches, 150)
})

test('a match that straddles a slice boundary counts once', async () => {
  const text = `${'x'.repeat(2040)}NEEDLE${'y'.repeat(100)}`
  const result = await scanText(text, /NEEDLE/gu, { chunk: 2048 })
  assert.equal(result.matches, 1)
})

test('progress reaches one and reports intermediate values', async () => {
  const seen = []
  await scanText('a'.repeat(8192), /zzz/gu, { chunk: 2048, onProgress: value => seen.push(value) })
  assert.ok(seen.length >= 3)
  assert.equal(seen[seen.length - 1], 1)
})

test('an aborted scan stops early and says so', async () => {
  const controller = new AbortController()
  const text = 'a'.repeat(64 * 1024)
  controller.abort()
  const result = await scanText(text, /a/gu, { chunk: 1024, signal: controller.signal })
  assert.equal(result.completed, false)
})

test('the scan reports the line of each match so it can be jumped to', async () => {
  const text = ['id,name', '1,alpha', '2,beta', '3,alpha', '4,gamma'].join('\n')
  const result = await scanText(text, /alpha/gu, { chunk: 8 })
  assert.equal(result.matches, 2)
  // Line 0 is the header; a preview's body row is the line minus one.
  assert.deepEqual(result.lines, [1, 3])
})

test('match lines can be capped while the count stays whole', async () => {
  const text = ['h', 'a', 'a', 'a', 'a', 'a'].join('\n')
  const result = await scanText(text, /^a$/gmu, { chunk: 4, lineLimit: 2 })
  assert.equal(result.matches, 5)
  assert.deepEqual(result.lines, [1, 2])
})

test('a match on the line after a quoted newline keeps its own line', async () => {
  const text = ['h', '"one', 'two"', '3'].join('\n')
  const result = await scanText(text, /3/gu, { chunk: 4 })
  assert.deepEqual(result.lines, [3])
})

test('the line counter starts each slice at the line it is told', () => {
  const counter = createLineCounter(10)
  counter.nextSlice(0)
  counter.record('a\nb\nc\n', 0)
  counter.record('a\nb\nc\n', 2)
  counter.nextSlice(3)
  counter.record('d\ne\n', 0)
  counter.record('d\ne\n', 2)
  assert.deepEqual([...counter.lines], [0, 1, 3, 4])
})