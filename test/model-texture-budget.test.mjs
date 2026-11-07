/** Decoded texture budget planner. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTextureResizes } from '../src/client/previews/model/texture-budget.ts'

const budget = { maxDimension: 4096, maxPixels: 32 * 1024 * 1024 }

test('a normal 2K atlas set is left alone', () => {
  const plans = planTextureResizes(
    Array.from({ length: 6 }, () => ({ width: 2048, height: 2048 })),
    budget,
  )
  assert.equal(plans.every((plan) => !plan.resized), true)
  assert.deepEqual([plans[0].targetWidth, plans[0].targetHeight], [2048, 2048])
})

test('a set over the pixel budget is scaled down globally', () => {
  const plans = planTextureResizes(
    Array.from({ length: 4 }, () => ({ width: 4096, height: 4096 })),
    budget,
  )
  assert.equal(plans.every((plan) => plan.resized), true)
  const total = plans.reduce((sum, plan) => sum + plan.targetWidth * plan.targetHeight, 0)
  assert.ok(total <= budget.maxPixels, `expected <= ${budget.maxPixels}, got ${total}`)
  assert.deepEqual([plans[0].targetWidth, plans[0].targetHeight], [2896, 2896])
})

test('the longest edge is capped even below the pixel budget', () => {
  const plans = planTextureResizes([{ width: 8192, height: 1024 }], budget)
  assert.deepEqual([plans[0].targetWidth, plans[0].targetHeight], [4096, 512])
})

test('the planner never enlarges small images', () => {
  const plans = planTextureResizes([{ width: 64, height: 32 }], budget)
  assert.equal(plans[0].resized, false)
  assert.deepEqual([plans[0].targetWidth, plans[0].targetHeight], [64, 32])
})
