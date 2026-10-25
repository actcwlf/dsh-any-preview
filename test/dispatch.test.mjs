/** Extension discriminators: only ambiguous extensions get one. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  claimsFile,
  looksLikeTransportStream,
  looksLikeWavefront,
} from '../src/client/previews/dispatch.ts'

function tsPackets() {
  const head = new Uint8Array(400)
  for (const offset of [0, 188, 376]) head[offset] = 0x47
  return head
}

test('a transport stream is recognised by its sync bytes', () => {
  assert.equal(looksLikeTransportStream(tsPackets()), true)
  const m2ts = new Uint8Array(400)
  for (const offset of [4, 196, 388]) m2ts[offset] = 0x47
  assert.equal(looksLikeTransportStream(m2ts), true)
})

test('TypeScript source is not a transport stream', () => {
  const head = new TextEncoder().encode('import type { X } from "y"\nexport const z = 1\n')
  assert.equal(looksLikeTransportStream(head), false)
})

test('a Wavefront model is recognised by its statements', () => {
  const head = new TextEncoder().encode('# cube\nv 0 0 0\nv 1 0 0\nf 1 2 3\n')
  assert.equal(looksLikeWavefront(head), true)
})

test('a COFF object file is not a Wavefront model', () => {
  const head = new Uint8Array([0x64, 0x86, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00])
  assert.equal(looksLikeWavefront(head), false)
})

test('unambiguous extensions are trusted without a probe', () => {
  assert.equal(claimsFile('glb', undefined), true)
  assert.equal(claimsFile('obj', undefined), true)
  assert.equal(claimsFile('obj', new TextEncoder().encode('v 0 0 0\n')), true)
  assert.equal(claimsFile('obj', new Uint8Array([0x64, 0x86])), false)
  assert.equal(claimsFile('ts', new TextEncoder().encode('export const a = 1')), false)
})
