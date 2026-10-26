/** The inspect tool's pure summarisers: no fs, no tool registry. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { detectDelimiter, summariseCsv, summariseGguf } from '../src/host/inspect-tool.ts'

const samples = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'samples')

test('the delimiter is the one that appears most on the first line', () => {
  assert.equal(detectDelimiter('a,b,c'), ',')
  assert.equal(detectDelimiter('a\tb\tc'), '\t')
  assert.equal(detectDelimiter('a;b;c'), ';')
  assert.equal(detectDelimiter('single'), ',')
})

test('a CSV summary names the delimiter, the columns and the first rows', () => {
  const text = 'id,name\n1,alpha\n2,beta\n'
  const result = summariseCsv(new TextEncoder().encode(text), false)
  assert.equal(result.kind, 'csv')
  assert.equal(result.truncated, false)
  assert.match(result.summary, /delimiter ",", 2 columns/u)
  assert.match(result.summary, /columns: id \| name/u)
  assert.match(result.summary, /2,beta/u)
})

test('an empty CSV is refused rather than summarised', () => {
  assert.throws(() => summariseCsv(new Uint8Array(), false), /empty/u)
})

test('a truncated read is reported', () => {
  const result = summariseCsv(new TextEncoder().encode('a,b\n1,2\n'), true)
  assert.equal(result.truncated, true)
  assert.match(result.summary, /truncated/u)
})

test('a GGUF header summarises from the fixture', () => {
  const bytes = new Uint8Array(readFileSync(join(samples, 'sample.gguf')))
  const result = summariseGguf(bytes)
  assert.equal(result.kind, 'gguf')
  assert.match(result.summary, /GGUF v3/u)
  assert.match(result.summary, /general\.architecture = llama/u)
  assert.match(result.summary, /blk\.0\.attn_q\.weight Q4_0/u)
  assert.equal(result.truncated, false)
})
