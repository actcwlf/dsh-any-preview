/** Log severity spotting and the streaming model. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogConsumer, levelOf } from '../src/client/previews/log/parse.ts'

test('severity keywords map to levels, case-insensitively', () => {
  assert.equal(levelOf('2026-10-25 ERROR failed to bind'), 'error')
  assert.equal(levelOf('fatal: repository not found'), 'error')
  assert.equal(levelOf('warning: deprecated flag'), 'warn')
  assert.equal(levelOf('INFO listening on 8080'), 'info')
  assert.equal(levelOf('debug: trace enabled'), 'debug')
  assert.equal(levelOf('just some output'), 'none')
})

test('the loudest keyword wins', () => {
  assert.equal(levelOf('INFO fallback after ERROR'), 'error')
  assert.equal(levelOf('warn: retrying'), 'warn')
})

test('the model keeps lines and reports completion', () => {
  const model = createLogConsumer()
  model.push('one\ntwo\n')
  assert.deepEqual(model.lines, ['one', 'two'])
  assert.equal(model.complete, false)
  model.finish()
  model.finish()
  assert.equal(model.complete, true)
  assert.deepEqual(model.lines, ['one', 'two'])
})

test('lines split across chunks are reassembled', () => {
  const model = createLogConsumer()
  model.push('alpha\nbe')
  model.push('ta\ngamma')
  model.finish()
  assert.deepEqual(model.lines, ['alpha', 'beta', 'gamma'])
})

test('the budget truncates the tail of a long log', () => {
  const model = createLogConsumer(3)
  model.push('a\nb\nc\nd\ne\n')
  model.finish()
  assert.deepEqual(model.lines, ['a', 'b', 'c'])
  assert.equal(model.truncated, true)
})
