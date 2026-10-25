/** Translation runtime: dictionary fallback plus an optional platform binding. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getLocale, setLocale, setTranslator, subscribeLocale, t } from '../src/client/i18n.ts'
import { en, zh } from '../src/client/locales.ts'

test('both dictionaries carry the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim() !== '', `empty English translation for ${key}`)
  }
})

test('params interpolate in Chinese', () => {
  setLocale('zh')
  assert.equal(t('tensors.count', { count: 5, shown: 2 }), '共 5 个张量，显示前 2 个。')
  assert.equal(t('count.items', { count: 12 }), '12 项')
})

test('params interpolate in English', () => {
  setLocale('en')
  assert.equal(t('tensors.count', { count: 5, shown: 2 }), 'Showing the first 2 of 5 tensors.')
  assert.equal(t('metadata.count', { count: 9, shown: 3 }), 'Showing the first 3 of 9 metadata entries.')
  assert.equal(t('common.name'), 'Name')
})

test('a missing placeholder value renders empty rather than the template', () => {
  setLocale('en')
  assert.equal(t('tensors.count', { count: 5 }), 'Showing the first  of 5 tensors.')
})

test('a bound platform translator takes over every lookup', () => {
  const seen = []
  setTranslator((key, params) => {
    seen.push([key, params])
    return `bound:${key}`
  })
  try {
    assert.equal(t('common.name'), 'bound:common.name')
    assert.deepEqual(seen[0], ['common.name', undefined])
  } finally {
    setTranslator(undefined)
  }
})

test('subscribers are notified once per locale change', () => {
  const calls = []
  setLocale('zh')
  const off = subscribeLocale(() => { calls.push(getLocale()) })
  try {
    setLocale('en')
    setLocale('en')
    setLocale('zh')
  } finally {
    off()
  }
  assert.deepEqual(calls, ['en', 'zh'])
})
