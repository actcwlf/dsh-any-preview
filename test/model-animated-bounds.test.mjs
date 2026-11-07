/** Animated bounds use the current world pose, not the bind-pose shortcut. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { computeAnimatedBounds } from '../src/client/previews/model/animated-bounds.ts'

test('a transformed mesh is measured in world space', () => {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshBasicMaterial(),
  )
  mesh.position.set(5, 1, -2)
  const box = computeAnimatedBounds(THREE, mesh)
  assert.ok(Math.abs(box.min.x - 4) < 1e-6)
  assert.ok(Math.abs(box.max.x - 6) < 1e-6)
  assert.ok(Math.abs(box.min.y - 0) < 1e-6)
  assert.ok(Math.abs(box.max.y - 2) < 1e-6)
  assert.ok(Math.abs(box.min.z + 3) < 1e-6)
  assert.ok(Math.abs(box.max.z + 1) < 1e-6)
})

test('an empty root falls back to its object box', () => {
  const group = new THREE.Group()
  const box = computeAnimatedBounds(THREE, group)
  assert.equal(box.isEmpty(), true)
})
