/** The streaming extraction's disk semantics: .part while writing, rename at the end. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abortExtraction, appendExtraction, beginExtraction, endExtraction, partPathOf } from '../src/host/extract-route.ts'

function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-extract-'))
}

test('chunks land in a .part file that is renamed when done', async () => {
  const dir = scratch()
  try {
    const target = await beginExtraction('a.bin', dir)
    assert.equal(existsSync(partPathOf('a.bin', dir)), true)
    assert.equal(existsSync(target), false, 'no final file while streaming')

    await appendExtraction('a.bin', dir, new Uint8Array([1, 2]))
    await appendExtraction('a.bin', dir, new Uint8Array([3, 4]))
    assert.deepEqual(Array.from(readFileSync(partPathOf('a.bin', dir))), [1, 2, 3, 4])

    const final = await endExtraction('a.bin', dir)
    assert.equal(final, target)
    assert.deepEqual(Array.from(readFileSync(final)), [1, 2, 3, 4])
    assert.equal(existsSync(partPathOf('a.bin', dir)), false, 'the .part file is gone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('aborting removes the partial file and leaves nothing behind', async () => {
  const dir = scratch()
  try {
    await beginExtraction('b.bin', dir)
    await appendExtraction('b.bin', dir, new Uint8Array([9]))
    await abortExtraction('b.bin', dir)
    assert.equal(existsSync(partPathOf('b.bin', dir)), false)
    assert.equal(existsSync(join(dir, 'b.bin')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appending without a session is refused', async () => {
  const dir = scratch()
  try {
    await assert.rejects(() => appendExtraction('c.bin', dir, new Uint8Array([1])), /no extraction in progress/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})