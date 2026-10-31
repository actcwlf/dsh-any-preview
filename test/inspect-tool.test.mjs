/** The inspect tool's pure summarisers: no fs, no tool registry. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { detectDelimiter, inferType, inspectCsv, inspectGguf, inspectJsonl, inspectSqlite, inspectZip, inspectSafetensors, inspectRst, inspectNotebook, inspectEpub, inspectSevenZip } from '../src/host/inspect-tool.ts'

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

function readerFor(name) {
  const bytes = new Uint8Array(readFileSync(join(samples, name)))
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.slice(offset, offset + length),
  }
}

test('a JSONL result reports objects, fields and invalid lines', () => {
  const text = '{"a":1,"b":"x"}\n{"a":2}\nnot json\n'
  const result = inspectJsonl(new TextEncoder().encode(text), false)
  assert.equal(result.kind, 'jsonl')
  assert.match(result.summary, /2 objects/u)
  assert.ok(result.schema.some(line => line.startsWith('a: present in 2/2')))
  assert.ok(result.notes.some(note => note.includes('1 of the first 3')))
})

test('a zip result reports counts and the largest members', async () => {
  const { size, read } = readerFor('binary.zip')
  const result = await inspectZip(size, read)
  assert.equal(result.kind, 'zip')
  assert.match(result.summary, /ZIP/u)
  assert.ok(result.facts.some(fact => fact.startsWith('files:')))
  assert.ok(result.schema.length > 0)
})

test('a SQLite result reports schema objects', async () => {
  const { read } = readerFor('sample.db')
  const result = await inspectSqlite(read)
  assert.equal(result.kind, 'sqlite')
  assert.match(result.summary, /SQLite/u)
  assert.ok(result.schema.some(line => line.startsWith('table ')))
})

test('a safetensors header summarises from the fixture', async () => {
  const { size, read } = readerFor('sample.safetensors')
  const result = await inspectSafetensors(size, read)
  assert.equal(result.kind, 'safetensors')
  assert.match(result.summary, /safetensors/u)
  assert.ok(result.facts.some(fact => fact.startsWith('tensors:')))
})

test('a reST outline lists headings and counts', () => {
  const text = 'Title\n=====\n\nFirst\n-----\n\nsome text\n\nSecond\n------\n\nmore\n'
  const result = inspectRst(new TextEncoder().encode(text), false)
  assert.equal(result.kind, 'rst')
  assert.match(result.summary, /headings/u)
  assert.ok(result.schema.includes('Title'))
})

test('a notebook reports cell kinds', () => {
  const notebook = {
    cells: [
      { cell_type: 'markdown', source: ['# Title'] },
      { cell_type: 'code', source: ['print(1)'], outputs: [{ output_type: 'stream', text: ['1'] }] },
    ],
  }
  const result = inspectNotebook(new TextEncoder().encode(JSON.stringify(notebook)))
  assert.equal(result.kind, 'ipynb')
  assert.match(result.summary, /2 cells/u)
  assert.ok(result.facts.includes('code: 1'))
})

test('an EPUB reports chapters from its archive shape', async () => {
  const { size, read } = readerFor('sample.epub')
  const result = await inspectEpub(size, read)
  assert.equal(result.kind, 'epub')
  assert.match(result.summary, /EPUB/u)
  assert.ok(result.facts.some(fact => fact.startsWith('chapters')))
})

function sevenZipReader(name) {
  const bytes = new Uint8Array(readFileSync(join(samples, name)))
  return async (offset, length) => bytes.slice(offset, offset + length)
}

test('a 7z archive is summarised with its files and solid flag', async () => {
  const result = await inspectSevenZip(sevenZipReader('sample-noheader.7z'))
  assert.equal(result.kind, '7z')
  assert.match(result.summary, /3 files/u)
  assert.ok(result.facts.some(fact => fact === 'solid: yes'))
  assert.ok(result.schema.some(line => line.startsWith('alpha.txt:')))
})

test('a compressed 7z header is decoded before summarising', async () => {
  const result = await inspectSevenZip(sevenZipReader('sample-solid.7z'))
  assert.equal(result.kind, '7z')
  assert.match(result.summary, /3 files/u)
})

test('an encrypted 7z archive says so', async () => {
  const result = await inspectSevenZip(sevenZipReader('sample-encrypted.7z'))
  assert.ok(result.facts.some(fact => fact === 'encrypted: yes'))
  assert.ok(result.notes.some(note => note.includes('encrypted')))
})