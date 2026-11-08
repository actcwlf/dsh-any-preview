/** The two little state machines: the file source's life and a scan's progress. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAILED_FILE, IDLE_FILE, OPENING_FILE, fileState, linesToRows, scanState } from '../src/client/previews/csv/state.ts'

test('the file source goes idle -> opening -> ready', () => {
  const opening = fileState(IDLE_FILE, { type: 'open' })
  assert.equal(opening.status, 'opening')
  assert.equal(opening.total, 0)
  const ready = fileState(opening, { type: 'ready', total: 300_000, progress: 0.25, complete: false })
  assert.deepEqual(ready, { status: 'ready', total: 300_000, progress: 0.25, complete: false })
})

test('a failed file source is not resurrected by a late slice', () => {
  const failed = fileState(OPENING_FILE, { type: 'fail' })
  assert.equal(failed, FAILED_FILE)
  // A read that was in flight cannot bring it back: the table already fell back to text.
  assert.equal(fileState(failed, { type: 'ready', total: 10, progress: 1, complete: true }), failed)
})

test('a slice updates the total without leaving the ready state', () => {
  const ready = fileState(IDLE_FILE, { type: 'ready', total: 100, progress: 0.1, complete: false })
  const next = fileState(ready, { type: 'ready', total: 2_000_000, progress: 0.9, complete: true })
  assert.equal(next.status, 'ready')
  assert.equal(next.total, 2_000_000)
  assert.equal(next.complete, true)
})

test('a match on the header line has no row to jump to', () => {
  // Line 0 is the header, so line 1 is body row 0 and body row 99 is line 100.
  assert.deepEqual(linesToRows([0, 1, 100]), [0, 99])
})

const occurrence = (row, cell = 0, start = 0, end = 1) => ({ row, cell, start, end })

test('a scan starts empty and reports what each slice found', () => {
  const started = scanState(undefined, { type: 'start', query: 'user' })
  assert.deepEqual(started, { query: 'user', progress: 0, matches: 0, occurrences: [], pages: [], done: false, aborted: false })
  const sliced = scanState(started, {
    type: 'slice', progress: 0.4, matches: 7, occurrences: [occurrence(0), occurrence(1)],
  })
  assert.equal(sliced.progress, 0.4)
  assert.equal(sliced.matches, 7)
  assert.deepEqual(sliced.occurrences, [occurrence(0), occurrence(1)], 'the occurrence positions keep their order')
  assert.equal(sliced.done, false)
})

test('a finished scan is done, and its occurrences are the ones to walk', () => {
  const started = scanState(undefined, { type: 'start', query: 'x' })
  const done = scanState(started, {
    type: 'done', matches: 2, occurrences: [occurrence(4, 2, 3, 5), occurrence(8, 0, 1, 2)], pages: [],
  })
  assert.equal(done.done, true)
  assert.equal(done.aborted, false)
  assert.equal(done.progress, 1)
  assert.deepEqual(done.occurrences, [occurrence(4, 2, 3, 5), occurrence(8, 0, 1, 2)])
  assert.deepEqual(done.pages, [])
})

test('stopping keeps the hits found so far', () => {
  const started = scanState(undefined, { type: 'start', query: 'x' })
  const sliced = scanState(started, {
    type: 'slice', progress: 0.3, matches: 3, occurrences: [occurrence(1), occurrence(3), occurrence(5)],
  })
  const stopped = scanState(sliced, { type: 'stop' })
  assert.equal(stopped.done, true)
  assert.equal(stopped.aborted, true)
  assert.deepEqual(stopped.occurrences, [occurrence(1), occurrence(3), occurrence(5)], 'the occurrences stay reachable after a stop')
})

test('events without a scan are ignored, and clearing drops one', () => {
  assert.equal(scanState(undefined, { type: 'slice', progress: 1, matches: 1, occurrences: [occurrence(1)] }), undefined)
  assert.equal(scanState(undefined, { type: 'stop' }), undefined)
  const started = scanState(undefined, { type: 'start', query: 'x' })
  assert.equal(scanState(started, { type: 'clear' }), undefined)
})
