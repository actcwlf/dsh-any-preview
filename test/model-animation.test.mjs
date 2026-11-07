/** Default multi-clip selection for the model viewer. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectDefaultClips } from '../src/client/previews/model/animation.ts'

test('a bone clip and a separate facial clip are both selected', () => {
  assert.deepEqual(
    selectDefaultClips([
      ['センター.quaternion', '上半身.quaternion', '頭.quaternion'],
      ['荧_mesh.morphTargetInfluences'],
    ]),
    [0, 1],
  )
})

test('the clip with more tracks becomes primary even when it comes second', () => {
  assert.deepEqual(
    selectDefaultClips([
      ['荧_mesh.morphTargetInfluences'],
      ['センター.quaternion', '上半身.quaternion'],
    ]),
    [1, 0],
  )
})

test('two full-body clips that touch the same track do not stack', () => {
  assert.deepEqual(
    selectDefaultClips([
      ['センター.quaternion', '上半身.quaternion'],
      ['センター.quaternion', '頭.quaternion'],
    ]),
    [0],
  )
})

test('a clip with no tracks is still selectable as a fallback', () => {
  assert.deepEqual(selectDefaultClips([[]]), [0])
})
