/** Shared preview chrome contract. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHROME, CHROME_BAR, TEXT } from '../src/client/kernel/ui.ts'

test('chrome uses the DSH-aligned height and control size', () => {
  assert.equal(CHROME.height, 32)
  assert.equal(CHROME.control, 28)
  assert.equal(CHROME.status, 28)
  assert.equal(CHROME_BAR.height, CHROME.height)
  assert.equal(CHROME_BAR.boxSizing, 'border-box')
})

test('chrome typography uses the shared 13/20 and 12/16 roles', () => {
  assert.equal(TEXT.chrome.fontSize, 13)
  assert.equal(TEXT.chrome.lineHeight, '20px')
  assert.equal(TEXT.meta.fontSize, 12)
  assert.equal(TEXT.meta.lineHeight, '16px')
  assert.equal(TEXT.table.fontSize, 12)
  assert.equal(TEXT.table.lineHeight, '18px')
  assert.equal(TEXT.caption.fontSize, 11)
  assert.equal(TEXT.caption.lineHeight, '16px')
})
