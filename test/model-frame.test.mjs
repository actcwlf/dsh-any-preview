/** Camera framing and grid sizing: pure numbers, no three.js or DOM. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GRID_DIVISIONS, frameForSphere, gridForBox } from '../src/client/previews/model/frame.ts'

const FOV = 45

test('distance scales with the model radius', () => {
  const one = frameForSphere(1, FOV, 1)
  const two = frameForSphere(2, FOV, 1)
  assert.ok(Math.abs(two.distance - one.distance * 2) < 1e-9)
  assert.ok(Math.abs(two.far - one.far * 2) < 1e-9)
})

test('a pane narrower than it is tall pulls the camera back', () => {
  const square = frameForSphere(1, FOV, 1)
  const narrow = frameForSphere(1, FOV, 0.4)
  assert.ok(narrow.distance > square.distance * 2.4, 'the width, not the height, limits the fit')
  // A wide pane is limited by the vertical field of view instead.
  assert.equal(frameForSphere(1, FOV, 4).distance, square.distance)
})

test('clip planes hold the sphere at both ends of the orbit range', () => {
  const fit = frameForSphere(1, FOV, 1)
  assert.ok(fit.near < fit.distance - 1, 'near sits in front of the sphere')
  assert.ok(fit.far > fit.distance + 1, 'far sits behind the sphere')
  assert.ok(fit.far > fit.distance * 8 + 1, 'far covers the zoom-out limit')
})

test('a millimetre-scale model gets proportional clip planes', () => {
  // Regression: the far plane used to be max(1000, extent * 20), so every model
  // smaller than a metre had a near/far ratio in the millions and z-fought.
  const fit = frameForSphere(0.001, FOV, 1)
  assert.ok(fit.far < 0.1, `far stayed proportional (${String(fit.far)})`)
  assert.ok(fit.near < 0.001)
})

test('the camera stays outside the sphere even with a tight padding', () => {
  const touching = frameForSphere(1, FOV, 1, 1)
  const tight = frameForSphere(1, FOV, 1, 0.2)
  assert.equal(tight.distance, touching.distance)
})

test('invalid inputs fall back instead of producing NaN', () => {
  const fit = frameForSphere(0, Number.NaN, 0)
  assert.ok(Number.isFinite(fit.distance) && fit.distance > 0)
  assert.ok(Number.isFinite(fit.near) && fit.near > 0)
  assert.ok(Number.isFinite(fit.far) && fit.far > fit.distance)
})

test('the grid spans the larger footprint side and sits at the base', () => {
  assert.deepEqual(gridForBox(2, 1, -0.5), { size: 4, divisions: GRID_DIVISIONS, y: -0.5 })
  assert.equal(gridForBox(0, 0, 0).size, 2, 'a degenerate footprint still draws a unit grid')
  assert.equal(gridForBox(Number.NaN, 3, Number.POSITIVE_INFINITY).size, 6)
  assert.equal(gridForBox(1, 1, Number.POSITIVE_INFINITY).y, 0)
})
