/** Loopback URL signing: session-scoped, path-bound, never time-bound. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLanSecret, signLanPath, verifyLanPath } from '../src/host/lan-url.ts'

const PATH = 'F:\\w\\samples\\clip.mp4'

test('a signature verifies for the path it was minted for', () => {
  const secret = createLanSecret()
  assert.equal(verifyLanPath(secret, PATH, signLanPath(secret, PATH)), true)
})

test('a signature does not verify for another path', () => {
  const secret = createLanSecret()
  const signature = signLanPath(secret, PATH)
  assert.equal(verifyLanPath(secret, `${PATH}.other`, signature), false)
})

test('a signature does not verify under a different secret (a restart)', () => {
  const signature = signLanPath(createLanSecret(), PATH)
  assert.equal(verifyLanPath(createLanSecret(), PATH, signature), false)
})

test('a tampered or empty signature is refused', () => {
  const secret = createLanSecret()
  const signature = signLanPath(secret, PATH)
  assert.equal(verifyLanPath(secret, PATH, `${signature}x`), false)
  assert.equal(verifyLanPath(secret, PATH, ''), false)
  assert.equal(verifyLanPath(secret, '', signature), false)
})

test('the signature survives any length of playback', () => {
  // No clock is consulted: a URL minted now still verifies after hours.
  const secret = createLanSecret()
  const signature = signLanPath(secret, PATH)
  assert.equal(verifyLanPath(secret, PATH, signature), true)
})
