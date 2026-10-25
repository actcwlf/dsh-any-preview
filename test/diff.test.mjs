/** Unified-diff classification and the streaming model. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDiffLine, createDiffConsumer } from '../src/client/previews/diff/parse.ts'

/**
 * @param {readonly string[]} chunks - chunks in delivery order.
 * @param {number} [max] - line budget.
 * @returns {object} the finished consumer.
 */
function consume(chunks, max) {
  const model = createDiffConsumer(max)
  for (const chunk of chunks) model.push(chunk)
  model.finish()
  return model
}

test('headers win over the +/- body markers', () => {
  assert.equal(classifyDiffLine('--- a/file.ts'), 'file')
  assert.equal(classifyDiffLine('+++ b/file.ts'), 'file')
  assert.equal(classifyDiffLine('diff --git a/x b/x'), 'file')
  assert.equal(classifyDiffLine('index 123..456 100644'), 'context')
})

test('body lines are classified by their marker', () => {
  assert.equal(classifyDiffLine('+added'), 'add')
  assert.equal(classifyDiffLine('-removed'), 'del')
  assert.equal(classifyDiffLine(' context'), 'context')
  assert.equal(classifyDiffLine(''), 'context')
})

test('hunk headers and notes are their own kinds', () => {
  assert.equal(classifyDiffLine('@@ -1,3 +1,4 @@ fn()'), 'hunk')
  assert.equal(classifyDiffLine('\\ No newline at end of file'), 'note')
})

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const keep = 1',
  '-const old = 2',
  '+const next = 2',
  '+const extra = 3',
  '',
].join('\n')

test('the model counts additions and removals', () => {
  const model = consume([PATCH])
  assert.equal(model.added, 2)
  assert.equal(model.removed, 1)
  assert.equal(model.lines.length, 8)
  assert.deepEqual(model.lines.map(line => line.kind), [
    'file', 'file', 'file', 'hunk', 'context', 'del', 'add', 'add',
  ])
  assert.equal(model.truncated, false)
})

test('the model is stable across arbitrary chunk boundaries', () => {
  const whole = consume([PATCH])
  for (let cut = 0; cut <= PATCH.length; cut += 1) {
    const split = consume([PATCH.slice(0, cut), PATCH.slice(cut)])
    assert.deepEqual(split.lines, whole.lines, `cut at ${String(cut)}`)
    assert.equal(split.added, whole.added)
    assert.equal(split.removed, whole.removed)
  }
})

test('the line budget truncates without losing the counters already seen', () => {
  const model = consume([PATCH], 4)
  assert.equal(model.lines.length, 4)
  assert.equal(model.truncated, true)
})
