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

const encode = text => new TextEncoder().encode(text)

/** Build the probe the tool hands `inspectCsv`: head, size, windows and tail. */
function csvProbe(text, overrides = {}) {
  const bytes = encode(text)
  return { head: bytes, size: bytes.length, samples: [], tail: bytes.slice(-64), ...overrides }
}

test('a CSV result carries summary, schema and next steps', () => {
  const text = 'id,name\n1,alpha\n2,beta\n'
  const result = inspectCsv(csvProbe(text))
  assert.equal(result.kind, 'csv')
  assert.equal(result.truncated, false)
  assert.match(result.summary, /2 columns/u)
  assert.match(result.summary, /~3 rows/u)
  assert.match(result.schema[0] ?? '', /^id: integer/u)
  assert.match(result.schema[1] ?? '', /^name: string/u)
  assert.ok(result.facts.some(fact => fact.startsWith('header: id | name')))
  assert.equal(result.next.length, 2)
  assert.match(result.next[0] ?? '', /read\(offset=1/u)
})

test('an empty CSV is refused rather than summarised', () => {
  assert.throws(() => inspectCsv(csvProbe('')), /empty/u)
})

test('a big file gets a row estimate, not just its first megabyte', () => {
  // 1,000 rows of 16 bytes each; the file claims to be 2 MB, so ~125,000 rows fit.
  const LINE = '1,user_1,note 1\n'
  const head = LINE.repeat(1_000)
  const sample = LINE.repeat(2_000)
  const result = inspectCsv(csvProbe(head, {
    size: 2 * 1024 * 1024,
    samples: [encode(sample), encode(sample), encode(sample)],
    tail: encode(LINE),
  }))
  const rows = result.facts.find(fact => fact.startsWith('rows:')) ?? ''
  assert.match(rows, /~\d{3},\d{3}/u, rows)
  assert.match(rows, /est\. from the head \+ 3 windows/u)
  assert.match(rows, /16–16 bytes\/row/u)
  assert.ok(result.notes.some(note => /only the first/u.test(note)))
  // The whole file is described, so the answer is not truncated.
  assert.equal(result.truncated, false)
})

test('rows that grow across the file warn about byte offsets', () => {
  const LINE = '1,user_1,note 1\n'
  const LONG = '1000000,user_1000000,note which is much longer\n'
  const result = inspectCsv(csvProbe(LINE.repeat(500), {
    size: 4 * 1024 * 1024,
    samples: [encode(LONG.repeat(400)), encode(LONG.repeat(400))],
    tail: encode(LONG),
  }))
  assert.ok(result.notes.some(note => /row length varies/u.test(note)), 'the spread is reported')
})

test('a delimiter that changes deeper in the file is called out', () => {
  const result = inspectCsv(csvProbe('a,b\n1,2\n', {
    size: 8 * 1024 * 1024,
    samples: [encode('a;b\n1;2\n'), encode('a;b\n1;2\n')],
    tail: encode('1;2\n'),
  }))
  assert.ok(result.notes.some(note => /delimiter is "," at the head but ";"/u.test(note)))
})

test('line endings, the trailing newline, BOM and encoding are reported', () => {
  const crlf = inspectCsv(csvProbe('id,name\r\n1,a\r\n2,b', { tail: encode('2,b') }))
  assert.ok(crlf.facts.some(fact => fact === 'line endings: CRLF · no trailing newline'), crlf.facts.join('\n'))
  const bom = new TextEncoder().encode('\ufeffid,name\n1,a\n')
  const withBom = inspectCsv({ head: bom, size: bom.length, samples: [], tail: bom })
  assert.ok(withBom.facts.some(fact => fact.includes('UTF-8 with BOM')), withBom.facts.join('\n'))
  assert.ok(withBom.notes.some(note => /BOM/u.test(note)))
  // Invalid UTF-8 is reported instead of silently decoded.
  const broken = new Uint8Array([0x69, 0x64, 0x0A, 0xFF, 0xFE, 0x0A])
  const invalid = inspectCsv({ head: broken, size: broken.length, samples: [], tail: broken })
  assert.ok(invalid.facts.some(fact => /invalid bytes/u.test(fact)))
})

test('a column that changes kind deeper in the file is flagged', () => {
  // A real mid-file window starts mid-row: the partial first line is dropped, so the
  // N/A values have to sit on the complete lines that follow it.
  const result = inspectCsv(csvProbe('id,paid\n1,true\n2,false\n', {
    size: 16 * 1024 * 1024,
    samples: [encode('9,N/A\n7,N/A\n8,true\n'), encode('9,false\n6,N/A\n')],
    tail: encode('10,false\n'),
  }))
  const paid = result.schema.find(line => line.startsWith('paid:')) ?? ''
  assert.match(paid, /also string/u, paid)
})

test('a headerless file is not mistaken for a header', () => {
  const result = inspectCsv(csvProbe('1,a\n2,b\n3,c\n'))
  assert.ok(result.facts.some(fact => /header: none detected/u.test(fact)), result.facts.join('\n'))
})

test('quoted newlines say rows are not lines', () => {
  const result = inspectCsv(csvProbe('id,note\n1,"two\nlines"\n2,plain\n'))
  assert.ok(result.notes.some(note => /quoted fields hold newlines/u.test(note)), result.notes.join('\n'))
  assert.ok(result.next.some(step => /按 CSV 解析/u.test(step)))
})

test('a wide table caps the schema and says so', () => {
  const header = Array.from({ length: 25 }, (_value, index) => `c${String(index)}`).join(',')
  const row = Array.from({ length: 25 }, () => '1').join(',')
  const result = inspectCsv(csvProbe(`${header}\n${row}\n`))
  assert.equal(result.truncated, true)
  assert.equal(result.schema.length, 20)
  assert.ok(result.notes.some(note => /25 columns, first 20 shown/u.test(note)))
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