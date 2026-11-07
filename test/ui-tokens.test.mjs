/** Shared preview chrome contract. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BODY_ACTION, CHROME, CHROME_BAR, CHROME_CONTROL, DATA_TABLE_HEADER, TEXT } from '../src/client/kernel/ui.ts'

test('chrome uses the DSH-aligned height and control size', () => {
  assert.equal(CHROME.height, 32)
  assert.equal(CHROME.control, 28)
  assert.equal(CHROME.status, 28)
  assert.equal(CHROME.gap, 4)
  assert.equal(CHROME.padding, '0 6px 0 16px')
  assert.equal(CHROME_BAR.height, CHROME.height)
  assert.equal(CHROME_BAR.boxSizing, 'border-box')
})

test('header controls are ghost and body actions are filled', () => {
  assert.equal(CHROME_CONTROL.border, 'none')
  assert.equal(CHROME_CONTROL.height, 28)
  assert.equal(BODY_ACTION.border, '0.5px solid var(--dsw-alias-border-l2)')
  assert.equal(BODY_ACTION.fontSize, 13)
})

test('data-table headers share one contract', () => {
  assert.equal(DATA_TABLE_HEADER.height, 28)
  assert.equal(DATA_TABLE_HEADER.fontSize, 12)
  assert.equal(DATA_TABLE_HEADER.lineHeight, '18px')
  assert.equal(DATA_TABLE_HEADER.padding, '0 16px')
  assert.match(DATA_TABLE_HEADER.background, /color-mix/u)
})

test('chrome typography uses the shared 13/20 and 12/18 roles', () => {
  assert.equal(TEXT.chrome.fontSize, 13)
  assert.equal(TEXT.chrome.lineHeight, '20px')
  assert.equal(TEXT.meta.fontSize, 12)
  assert.equal(TEXT.meta.lineHeight, '18px')
  assert.equal(TEXT.table.fontSize, 12)
  assert.equal(TEXT.table.lineHeight, '18px')
  assert.equal(TEXT.caption.fontSize, 11)
  assert.equal(TEXT.caption.lineHeight, '16px')
})
