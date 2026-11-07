/** `.eml` MIME parsing: headers, first text part, attachment names. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeMimeHeader, headerLabel, parseEml } from '../src/client/previews/eml/parse.ts'

const SIMPLE = [
  'From: Ada <ada@example.test>',
  'To: Grace <grace@example.test>',
  'Subject: Hello',
  'Date: Sat, 25 Oct 2026 10:00:00 +0800',
  '',
  'First line.',
  'Second line.',
].join('\r\n')

test('a simple message keeps its headers and body', () => {
  const mail = parseEml(SIMPLE)
  assert.equal(mail.text, 'First line.\nSecond line.')
  assert.equal(mail.headers.find(header => header.name === 'subject')?.value, 'Hello')
  assert.deepEqual(mail.attachments, [])
})

test('folded headers are unfolded', () => {
  const mail = parseEml(['Subject: a very', ' long subject', '', 'body'].join('\n'))
  assert.equal(mail.headers.find(header => header.name === 'subject')?.value, 'a very long subject')
})

test('a multipart message picks the text part and lists attachments', () => {
  const raw = [
    'From: a@b.test',
    'Content-Type: multipart/mixed; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'H=C3=A9llo',
    '--XYZ',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="report.pdf"',
    '',
    'JVBERi0=',
    '--XYZ--',
  ].join('\r\n')
  const mail = parseEml(raw)
  assert.equal(mail.text, 'Héllo')
  assert.deepEqual(mail.attachments, ['report.pdf'])
})

test('a base64 body is decoded', () => {
  const raw = [
    'Content-Type: text/plain',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('decoded text', 'utf8').toString('base64'),
  ].join('\n')
  assert.equal(parseEml(raw).text, 'decoded text')
})

test('an empty message yields no text and no attachments', () => {
  const mail = parseEml('')
  assert.equal(mail.text, '')
  assert.deepEqual(mail.attachments, [])
})

test('known headers get readable labels', () => {
  assert.equal(headerLabel('subject'), '主题')
  assert.equal(headerLabel('x-custom'), 'x-custom')
})

test('RFC 2047 base64 and quoted-printable words are decoded', () => {
  assert.equal(decodeMimeHeader('=?UTF-8?B?5rWL6K+V6YKu5Lu2?='), '测试邮件')
  assert.equal(decodeMimeHeader('=?UTF-8?Q?H=C3=A9llo?='), 'Héllo')
  assert.equal(decodeMimeHeader('Plain =?UTF-8?B?5L2g5aW9?= text'), 'Plain 你好 text')
})

test('whitespace between adjacent encoded words is not content', () => {
  assert.equal(
    decodeMimeHeader('=?UTF-8?B?5rWL?=  =?UTF-8?B?6K+V?='),
    '测试',
  )
})

test('a parseEml subject is decoded for the chrome title', () => {
  const raw = [
    'Subject: =?UTF-8?B?5rWL6K+V6YKu5Lu2?=',
    'From: Ada <ada@example.test>',
    '',
    'body',
  ].join('\n')
  const mail = parseEml(raw)
  assert.equal(mail.headers.find(header => header.name === 'subject')?.value, '测试邮件')
})
