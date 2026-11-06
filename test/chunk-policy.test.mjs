/** Chunk load policy: defaults, overrides, and which chunks get warmed. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkStrategy,
  isChunkEnabled,
  resetChunkStrategies,
  setChunkStrategy,
  warmableChunks,
} from '../src/client/kernel/chunk-policy.ts'

test('defaults reproduce the previous behaviour', () => {
  resetChunkStrategies()
  assert.equal(chunkStrategy('three'), 'warm')
  assert.equal(chunkStrategy('mux'), 'click')
  assert.equal(chunkStrategy('model-extras'), 'click', 'decoders load only when a model needs them')
  assert.deepEqual(warmableChunks(), ['three'])
})

test('an override changes both the strategy and the warm list', () => {
  resetChunkStrategies()
  setChunkStrategy('three', 'click')
  setChunkStrategy('mux', 'warm')
  try {
    assert.deepEqual(warmableChunks(), ['mux'])
  } finally {
    resetChunkStrategies()
  }
})

test('never disables a chunk without removing it from the policy', () => {
  resetChunkStrategies()
  setChunkStrategy('three', 'never')
  try {
    assert.equal(isChunkEnabled('three'), false)
    assert.deepEqual(warmableChunks(), [])
    assert.equal(chunkStrategy('three'), 'never')
  } finally {
    resetChunkStrategies()
  }
})

test('an unknown chunk id is rejected', () => {
  assert.throws(() => setChunkStrategy('nope', 'warm'), /unknown chunk/u)
})
