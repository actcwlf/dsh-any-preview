/** Route-read helpers: the size probe and the ranged window. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileSize, readRange } from '../src/client/kernel/zip.ts'

function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => { globalThis.fetch = original }
}

function response({ status, headers = {}, body = new Uint8Array() }) {
  return {
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    body: { cancel: async () => {} },
    arrayBuffer: async () => body.slice().buffer,
  }
}

test('the size probe reads the total from Content-Range', async () => {
  const restore = stubFetch(async () => response({
    status: 206,
    headers: { 'content-range': 'bytes 0-0/2425359' },
  }))
  try {
    assert.equal(await fileSize('http://file'), 2425359)
  } finally {
    restore()
  }
})

test('the size probe gives up when the server answers 200', async () => {
  const restore = stubFetch(async () => response({ status: 200 }))
  try {
    assert.equal(await fileSize('http://file'), undefined)
  } finally {
    restore()
  }
})

test('a ranged read keeps the requested window when Range is honoured', async () => {
  const restore = stubFetch(async () => response({
    status: 206,
    body: new TextEncoder().encode('234'),
  }))
  try {
    const bytes = await readRange('http://file', 2, 4)
    assert.equal(new TextDecoder().decode(bytes), '234')
  } finally {
    restore()
  }
})

test('a ranged read slices a 200 answer instead of trusting it', async () => {
  const restore = stubFetch(async () => response({
    status: 200,
    body: new TextEncoder().encode('0123456789'),
  }))
  try {
    const bytes = await readRange('http://file', 2, 4)
    assert.equal(new TextDecoder().decode(bytes), '234')
  } finally {
    restore()
  }
})
