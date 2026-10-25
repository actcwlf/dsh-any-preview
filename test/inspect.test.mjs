/** Metadata inspectors: SafeTensors, GGUF and SQLite schema. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { readHeaderLength, parseHeaderJson } from '../src/client/previews/safetensors/parse.ts'
import { looksLikeGguf, parseGguf } from '../src/client/previews/gguf/parse.ts'
import {
  collectSchema, decodeRecord, isSqlite, parseSqliteHeader, readVarint, toSchemaObject,
} from '../src/client/previews/sqlite/parse.ts'

const DB = 'F:/DSH/workspace/ext_preview/.tmp-schema-test.db'

function u32(value) {
  const buffer = new Uint8Array(4)
  new DataView(buffer.buffer).setUint32(0, value, true)
  return buffer
}

function u64(value) {
  const buffer = new Uint8Array(8)
  new DataView(buffer.buffer).setBigUint64(0, BigInt(value), true)
  return buffer
}

function ggufString(value) {
  const bytes = new TextEncoder().encode(value)
  return new Uint8Array([...u64(bytes.length), ...bytes])
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

test('safetensors header length is a little-endian u64', () => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, 123n, true)
  assert.equal(readHeaderLength(bytes), 123)
  assert.equal(readHeaderLength(new Uint8Array(3)), undefined)
})

test('safetensors header yields tensors, params, dtypes and metadata', () => {
  const header = parseHeaderJson(JSON.stringify({
    '__metadata__': { format: 'pt' },
    'model.embed.weight': { dtype: 'BF16', shape: [10, 4], data_offsets: [0, 80] },
    'model.norm.weight': { dtype: 'F32', shape: [4], data_offsets: [80, 96] },
  }), 200)
  assert.equal(header.tensors.length, 2)
  assert.equal(header.totalParams, 44)
  assert.deepEqual(header.metadata, [['format', 'pt']])
  const dtypes = Object.fromEntries(header.dtypes)
  assert.equal(dtypes.BF16, 1)
  assert.equal(dtypes.F32, 1)
  assert.equal(header.tensors[0].params, 40)
})

test('a gguf header reports version, metadata and tensors', () => {
  const bytes = concat([
    new TextEncoder().encode('GGUF'),
    u32(3),
    u64(1), // tensor count
    u64(2), // kv count
    ggufString('general.architecture'), u32(8), ggufString('llama'),
    ggufString('llama.context_length'), u32(4), u32(4096),
    ggufString('blk.0.attn_q.weight'), u32(2), u64(8), u64(8), u32(2), u64(0),
  ])
  assert.equal(looksLikeGguf(bytes), true)
  const header = parseGguf(bytes)
  assert.equal(header.version, 3)
  assert.equal(header.tensorCount, 1)
  assert.deepEqual(header.kv, [
    { key: 'general.architecture', value: 'llama' },
    { key: 'llama.context_length', value: '4096' },
  ])
  assert.equal(header.tensors[0].name, 'blk.0.attn_q.weight')
  assert.equal(header.tensors[0].type, 'Q4_0')
  assert.deepEqual(header.tensors[0].dims, [8, 8])
  assert.equal(header.tensors[0].params, 64)
})

test('a truncated gguf header fails instead of guessing', () => {
  const bytes = concat([new TextEncoder().encode('GGUF'), u32(3), u64(5), u64(1)])
  assert.throws(() => parseGguf(bytes))
  assert.equal(looksLikeGguf(new Uint8Array([1, 2, 3, 4])), false)
})

test('sqlite varints and records decode', () => {
  assert.deepEqual(readVarint(new Uint8Array([0x81, 0x00]), 0), { value: 128, next: 2 })
  // header length 2, one serial type (1 = 1-byte int), value 7
  assert.deepEqual(decodeRecord(new Uint8Array([2, 1, 7])), [7])
  assert.equal(toSchemaObject(['table', 't', 't', 2, 'CREATE TABLE t(a)'])?.name, 't')
  assert.equal(toSchemaObject(['index', 'i', 't', 3, null])?.sql, '')
  assert.equal(toSchemaObject(['other', 'x', '', 0, '']), undefined)
})

test('a real sqlite file reports its schema', { skip: !canCreateSqlite() }, async () => {
  createDatabase()
  const bytes = new Uint8Array(readFileSync(DB))
  assert.equal(isSqlite(bytes), true)
  const header = parseSqliteHeader(bytes)
  assert.ok(header !== undefined)
  assert.ok(header.pageSize >= 512)

  const result = await collectSchema({
    header,
    readPage: pageNumber => bytes.subarray((pageNumber - 1) * header.pageSize, pageNumber * header.pageSize),
  })
  const names = result.objects.map(object => object.name)
  assert.ok(names.includes('users'), names.join(', '))
  assert.ok(names.includes('idx_users_name'), names.join(', '))
  const table = result.objects.find(object => object.name === 'users')
  assert.match(table.sql.toLowerCase(), /create table users/u)
  assert.equal(result.truncated, false)
  rmSync(DB, { force: true })
})

test('a file that is not sqlite is refused', () => {
  assert.equal(isSqlite(new TextEncoder().encode('not a database at all')), false)
  assert.equal(parseSqliteHeader(new Uint8Array(10)), undefined)
})

function canCreateSqlite() {
  try {
    // eslint-disable-next-line no-unused-expressions
    return typeof process !== 'undefined' && existsSync('F:/DSH/workspace/ext_preview')
  } catch {
    return false
  }
}

function createDatabase() {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  rmSync(DB, { force: true })
  const db = new DatabaseSync(DB)
  db.exec('create table users(id integer primary key, name text); create index idx_users_name on users(name);')
  db.close()
}
