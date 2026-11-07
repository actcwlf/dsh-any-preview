/**
 * Minimal MIME reader for `.eml`: headers, the first text part, attachment
 * names. Attachments stay unread — the point is to read the message, not to
 * extract its payloads.
 */

/** One unfolded header. */
export interface EmlHeader {
  readonly name: string
  readonly value: string
}

/** What the viewer shows. */
export interface EmlDocument {
  readonly headers: readonly EmlHeader[]
  readonly text: string
  readonly attachments: readonly string[]
  readonly contentType: string
}

/** Headers worth showing first, in this order. */
export const PRIMARY_HEADERS = ['from', 'to', 'cc', 'date', 'subject'] as const

const HEADER_NAMES: Readonly<Record<string, string>> = {
  from: '发件人', to: '收件人', cc: '抄送', bcc: '密送',
  date: '时间', subject: '主题', 'content-type': '类型',
  'reply-to': '回复至', 'message-id': '消息 ID',
}

/**
 * Human label for a header name.
 * @param name - lower-case header name.
 * @returns the label, or the name itself when unknown.
 */
export function headerLabel(name: string): string {
  return HEADER_NAMES[name] ?? name
}

function decodeQuotedPrintable(input: string): string {
  const bytes: number[] = []
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (char === '=') {
      if (input[index + 1] === '\n') {
        index += 1
        continue
      }
      const hex = input.slice(index + 1, index + 3)
      if (/^[0-9a-f]{2}$/iu.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 2
        continue
      }
    }
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else bytes.push(...new TextEncoder().encode(char))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function decodeBase64(input: string): string {
  try {
    const binary = atob(input.replace(/\s+/gu, ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new TextDecoder().decode(bytes)
  } catch {
    return input
  }
}

/**
 * Decode RFC 2047 encoded words in a header value.
 *
 * Subjects and display names routinely arrive as `=?UTF-8?B?...?=` or
 * `=?GBK?Q?...?=`; showing the raw token in the title is never useful.
 * @param value - unfolded header value.
 * @returns the decoded display text.
 */
export function decodeMimeHeader(value: string): string {
  let result = ''
  let cursor = 0
  let previousEncodedEnd = -1
  for (const match of value.matchAll(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/gu)) {
    const start = match.index ?? 0
    const gap = value.slice(cursor, start)
    // RFC 2047 says whitespace between two encoded words is not content.
    if (!(previousEncodedEnd === cursor && gap.trim() === '')) result += gap
    const charset = (match[1] ?? 'utf-8').split('*')[0] ?? 'utf-8'
    const encoding = (match[2] ?? 'B').toLowerCase()
    const payload = match[3] ?? ''
    result += decodeEncodedWord(charset, encoding, payload, match[0])
    cursor = start + match[0].length
    previousEncodedEnd = cursor
  }
  result += value.slice(cursor)
  return result.trim()
}

function decodeEncodedWord(charset: string, encoding: string, payload: string, original: string): string {
  try {
    const bytes = encoding === 'b'
      ? decodeBase64Bytes(payload)
      : decodeQBytes(payload)
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return original
  }
}

function decodeBase64Bytes(input: string): Uint8Array {
  const clean = input.replace(/\s+/gu, '')
  try {
    const binary = atob(clean)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    // A tiny fallback keeps malformed headers from throwing; valid words are
    // handled by atob in every browser and supported Node runtime.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const bytes: number[] = []
    let buffer = 0
    let bits = 0
    for (const char of clean.replace(/=+$/u, '')) {
      const value = alphabet.indexOf(char)
      if (value < 0) continue
      buffer = (buffer << 6) | value
      bits += 6
      if (bits >= 8) {
        bits -= 8
        bytes.push((buffer >> bits) & 0xff)
      }
    }
    return new Uint8Array(bytes)
  }
}

function decodeQBytes(input: string): Uint8Array {
  const bytes: number[] = []
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (char === '_') {
      bytes.push(0x20)
      continue
    }
    if (char === '=') {
      const hex = input.slice(index + 1, index + 3)
      if (/^[0-9a-f]{2}$/iu.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 2
        continue
      }
    }
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else bytes.push(...new TextEncoder().encode(char))
  }
  return new Uint8Array(bytes)
}

function decodeBody(body: string, transferEncoding: string): string {
  const encoding = transferEncoding.toLowerCase()
  if (encoding === 'base64') return decodeBase64(body)
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body)
  return body
}

function splitHeaders(block: string): EmlHeader[] {
  const headers: EmlHeader[] = []
  for (const line of block.split('\n')) {
    if (/^[ \t]/u.test(line) && headers.length > 0) {
      const last = headers[headers.length - 1]!
      headers[headers.length - 1] = { name: last.name, value: `${last.value} ${line.trim()}` }
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    headers.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() })
  }
  return headers
}

function headerOf(headers: readonly EmlHeader[], name: string): string {
  return headers.find(header => header.name === name)?.value ?? ''
}

function fileNameOf(headers: readonly EmlHeader[]): string | undefined {
  const disposition = headerOf(headers, 'content-disposition')
  const contentType = headerOf(headers, 'content-type')
  const match = /filename\*?=(?:"([^"]+)"|([^;]+))/iu.exec(disposition) ?? /name=(?:"([^"]+)"|([^;]+))/iu.exec(contentType)
  if (match === null) return undefined
  const raw = (match[1] ?? match[2] ?? '').trim()
  return raw === '' ? undefined : decodeMimeHeader(decodeURIComponent(raw.replace(/^utf-8''/iu, '')))
}

/** Split a multipart body into its parts' `(headers, body)` pairs. */
function multipartParts(body: string, boundary: string): { headers: EmlHeader[], body: string }[] {
  const parts: { headers: EmlHeader[], body: string }[] = []
  for (const chunk of body.split(`--${boundary}`)) {
    const trimmed = chunk.replace(/^\r?\n/u, '')
    if (trimmed === '' || trimmed.startsWith('--')) continue
    const split = trimmed.indexOf('\n\n')
    if (split < 0) continue
    parts.push({ headers: splitHeaders(trimmed.slice(0, split)), body: trimmed.slice(split + 2) })
  }
  return parts
}

/**
 * Parse one message.
 * @param raw - decoded message text.
 * @returns headers, the first readable text body, and attachment names.
 */
export function parseEml(raw: string): EmlDocument {
  const normalized = raw.replaceAll('\r\n', '\n')
  const split = normalized.indexOf('\n\n')
  const headerBlock = split < 0 ? normalized : normalized.slice(0, split)
  const body = split < 0 ? '' : normalized.slice(split + 2)
  const headers = splitHeaders(headerBlock).map(header => ({
    name: header.name,
    value: decodeMimeHeader(header.value),
  }))
  const contentType = headerOf(headers, 'content-type')
  const boundary = /boundary="?([^";]+)"?/iu.exec(contentType)?.[1]

  if (boundary === undefined) {
    return {
      headers,
      contentType,
      text: decodeBody(body, headerOf(headers, 'content-transfer-encoding')).trim(),
      attachments: [],
    }
  }

  const attachments: string[] = []
  let text = ''
  for (const part of multipartParts(body, boundary)) {
    const name = fileNameOf(part.headers)
    const partType = headerOf(part.headers, 'content-type')
    if (name !== undefined) {
      attachments.push(name)
      continue
    }
    if (text === '' && (partType === '' || partType.toLowerCase().startsWith('text/plain'))) {
      text = decodeBody(part.body, headerOf(part.headers, 'content-transfer-encoding')).trim()
    }
  }
  return { headers, contentType, text, attachments }
}
