/** Log file-source parsing: fixed rows, one cell per line. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLogSlice } from '../src/client/previews/log/rows.ts'

test('a log slice becomes one-cell rows', () => {
  assert.deepEqual(parseLogSlice('alpha\nbeta\n').rows, [['alpha'], ['beta']])
})

test('a trailing partial line is emitted as a row at slice end', () => {
  assert.deepEqual(parseLogSlice('alpha\nbet').rows, [['alpha'], ['bet']])
})

test('CRLF is consumed without leaving carriage returns in rows', () => {
  assert.deepEqual(parseLogSlice('alpha\r\nbeta\r\n').rows, [['alpha'], ['beta']])
})
