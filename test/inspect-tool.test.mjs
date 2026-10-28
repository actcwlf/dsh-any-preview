/** The inspect tool's pure summarisers: no fs, no tool registry. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { detectDelimiter, inferType, inspectCsv, inspectGguf } from '../src/host/inspect-tool.ts'

const samples = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'samples')

test('the delimiter is the one that appears most on the first line', () => {
  assert.equal(detectDelimiter('a,b,c'), ',')
  assert.equal(detectDelimiter('a\tb\tc'), '\t')
  assert.equal(detectDelimiter('a;b;c'), ';')
  assert.equal(detectDelimiter('single'), ',')
})

test('column types are inferred coarsely from the first values', () => {
  assert.equal(inferType(['1', '2', '3']), 'integer')
  assert.equal(inferType(['1.5', '2.25']), 'number')
  assert.equal(inferType(['true', 'FALSE']), 'boolean')
  assert.equal(inferType(['x', '2']), 'string')
  assert.equal(inferType([]), 'empty')
})

test('a CSV result carries summary, schema and next steps', () => {
  const text = 'id,name\n1,alpha\n2,beta\n'
  const result = inspectCsv(new TextEncoder().encode(text), false, text.length)
  assert.equal(result.kind, 'csv')
  assert.equal(result.truncated, false)
  assert.match(result.summary, /2 columns/u)
  assert.deepEqual(result.schema, ['id: integer', 'name: string'])
  assert.equal(result.next.length, 2)
  assert.match(result.next[0] ?? '', /read\(offset=1/u)
})

test('an empty CSV is refused rather than summarised', () => {
  assert.throws(() => inspectCsv(new Uint8Array(), false, 0), /empty/u)
})

test('a truncated read is reported', () => {
  const result = inspectCsv(new TextEncoder().encode('a,b\n1,2\n'), true, 10 * 1024 * 1024)
  assert.equal(result.truncated, true)
  assert.ok(result.notes.some(note => note.includes('1 MB')))
})

test('a GGUF header summarises from the fixture', () => {
  const bytes = new Uint8Array(readFileSync(join(samples, 'sample.gguf')))
  const result = inspectGguf(bytes)
  assert.equal(result.kind, 'gguf')
  assert.match(result.summary, /GGUF v3/u)
  assert.match(result.summary, /llama/u)
  assert.ok(result.facts.some(fact => fact.includes('general.architecture = llama')))
  assert.ok(result.schema.some(line => line.startsWith('blk.0.attn_q.weight: Q4_0')))
  assert.equal(result.truncated, false)
})
