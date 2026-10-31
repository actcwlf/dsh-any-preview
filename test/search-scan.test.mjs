/** The large-text scan: counts whole-text matches, reports progress, can be aborted. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanText } from '../src/client/kernel/search-scan.ts'

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