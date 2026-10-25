/** The buffering decision that keeps media seekable without a Content-Length. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BUFFER_BYTES, bufferingDecision } from '../src/client/previews/media/decision.ts'

test('a non-empty seekable range needs no buffering', () => {
  assert.equal(bufferingDecision(14.08, 30_000_000), 'none')
  assert.equal(bufferingDecision(0.5, 30_000_000), 'none')
})

test('an empty seekable range buffers when the file fits', () => {
  assert.equal(bufferingDecision(0, 2_400_000), 'buffer')
  assert.equal(bufferingDecision(0, MAX_BUFFER_BYTES), 'buffer')
})

test('a file past the budget is blocked rather than buffered', () => {
  assert.equal(bufferingDecision(0, MAX_BUFFER_BYTES + 1), 'blocked')
  assert.equal(bufferingDecision(0, 4 * 1024 * 1024 * 1024), 'blocked')
})

test('an unknown size still attempts the buffer', () => {
  // The blob is measured after the fetch, so the cap is enforced there too.
  assert.equal(bufferingDecision(0, undefined), 'buffer')
})

test('the cap is configurable', () => {
  assert.equal(bufferingDecision(0, 500, 1000), 'buffer')
  assert.equal(bufferingDecision(0, 1500, 1000), 'blocked')
})
