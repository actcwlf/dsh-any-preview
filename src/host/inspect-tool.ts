/**
 * `preview_inspect`: answer "what is in this file" without reading its bytes.
 *
 * The output is an envelope shared by every format: one summary line, a few facts,
 * an optional schema, warnings, and concrete next steps. `read` and `grep` already
 * give content and matches; this tool exists to make the first decision cheap
 * (can I work with this file, and how) instead of dumping data.
 *
 * Scope: workspace files, read through the same fs service the previews use. The
 * read itself is not fenced to the workspace — see docs/security-notes.md.
 */
import { basename, extname, isAbsolute, join } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import type { HostFileSystem, RouteContext } from './contracts.ts'
import { looksLikeGguf, parseGguf } from '../client/previews/gguf/parse.ts'
import { parseNotebook } from '../client/previews/ipynb/parse.ts'
import { parseHeaderJson, readHeaderLength } from '../client/previews/safetensors/parse.ts'
import { collectSchema, parseSqliteHeader } from '../client/previews/sqlite/parse.ts'
import { detectDelimiter } from '../client/previews/csv/detect.ts'
import { createRowParser } from '../client/kernel/text-pipeline.ts'
import { countNewlines } from '../client/kernel/lines.ts'
import { formatBytes } from '../client/kernel/format.ts'
import { parseEml } from '../client/previews/eml/parse.ts'
import { classifyDiffLine } from '../client/previews/diff/parse.ts'
import { LIMITS } from '../shared/limits.ts'
import { densitySpread, rowLengthRange, rowsAt } from '../shared/inspect/density.ts'
import type { DensityProbe } from '../shared/inspect/density.ts'
import { parseRst } from '../shared/inspect/rst.ts'
import { isEncodedHeader, parseEncodedHeader, parseHeader, readLayout } from '../shared/sevenzip/structure.ts'
import { decodeFolder } from '../shared/sevenzip/decode.ts'
import type { Decoder } from '../shared/sevenzip/decode.ts'
import { canDecode } from '../shared/sevenzip/decode.ts'
import type { SevenZipArchive } from '../shared/sevenzip/structure.ts'
import { outlineOf } from '../shared/inspect/document.ts'
import { findEocd, parseTar, parseZipDirectory, u16, u32, zipEntryBytes } from '../shared/zip/parse.ts'

/** Header window for binary formats. */
const HEAD_BYTES = 4 * 1024 * 1024

/** Text window for delimited files. */
const TEXT_BYTES = 1 * 1024 * 1024

/** Window probed across a delimited file, for density and dialect. */
const SAMPLE_BYTES = 32 * 1024

/** Where those probes are taken, as fractions of the file. */
const SAMPLE_POINTS = [1 / 3, 2 / 3, 5 / 6] as const

/** Tail read for the trailing-newline fact. */
const TAIL_BYTES = 1024

/** How many keys, tensors, columns or rows a summary may name. */
const MAX_ITEMS = 20

/** Parameters: object root, closed, no required on the scalar. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'Absolute file path, or archive path with !/member for zip/tar/7z.' },
  },
} as const

/** Output: object root, closed; lists are strings so the schema stays flat. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    capability: { type: 'string', enum: ['inspected', 'preview-only', 'unknown'] },
    summary: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    schema: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    next: { type: 'array', items: { type: 'string' } },
    truncated: { type: 'boolean' },
  },
} as const

/** Whether the tool parsed structure, knows only that a preview exists, or cannot identify it. */
export type InspectCapability = 'inspected' | 'preview-only' | 'unknown'

/** One inspection result. */
interface InspectResult {
  kind: string
  /** Filled by the tool wrapper; pure summarisers only produce inspected results. */
  capability?: InspectCapability
  summary: string
  facts: string[]
  schema: string[]
  notes: string[]
  next: string[]
  truncated: boolean
}

/** The `tools` service as this tool uses it. */
interface ToolsLike {
  register(tool: unknown): () => void
}

/** The sandbox policy service: it resolves the workspace root per session. */
interface SandboxPolicyLike {
  resolve(input: { session?: unknown }): { workspaceRoot?: string, root?: string }
}

/** Context with the optional injects used to reach `tools` and `sandboxPolicy`. */
interface InspectContext extends RouteContext {
  fs: HostFileSystem
  inject?(deps: readonly string[], callback: (scope: never) => void): unknown
}

/** Formats the sidebar can render without a structural inspector. */
const PREVIEW_FAMILIES: Readonly<Record<string, string>> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', bmp: 'image', ico: 'image', avif: 'image', tif: 'image', tiff: 'image',
  pdf: 'pdf',
  doc: 'office', docx: 'office', ppt: 'office', pptx: 'office', xls: 'office', xlsx: 'office',
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  txt: 'code', text: 'code', ts: 'code', tsx: 'code', js: 'code', jsx: 'code',
  json: 'code', jsonc: 'code', yaml: 'code', yml: 'code', py: 'code', go: 'code',
  rs: 'code', java: 'code', c: 'code', h: 'code', cpp: 'code', cs: 'code',
  sh: 'code', bash: 'code', sql: 'code', css: 'code', scss: 'code', less: 'code',
  xml: 'code', toml: 'code', ini: 'code', cfg: 'code', conf: 'code', env: 'code',
  tex: 'code', bib: 'code', sty: 'code', cls: 'code',
  tar: 'tar', tgz: 'tar',
  diff: 'diff', patch: 'diff',
  log: 'log',
  eml: 'eml',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video', mov: 'video',
  mkv: 'video', avi: 'video', mpg: 'video', mpeg: 'video', '3gp': 'video',
  '3g2': 'video', m2ts: 'video',
  mp3: 'audio', m4a: 'audio', m4b: 'audio', aac: 'audio', wav: 'audio',
  flac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', weba: 'audio',
  aiff: 'audio', aif: 'audio', wma: 'audio', mid: 'audio', midi: 'audio',
  glb: 'model', gltf: 'model', obj: 'model', stl: 'model',
}

/** Human label and renderer for each preview-only family. */
const PREVIEW_INFO: Readonly<Record<string, { label: string, renderer: string, next?: string }>> = {
  image: { label: 'Image', renderer: 'image' },
  pdf: { label: 'PDF document', renderer: 'pdf' },
  office: { label: 'Office document', renderer: 'office' },
  html: { label: 'HTML document', renderer: 'html' },
  markdown: { label: 'Markdown document', renderer: 'markdown' },
  code: {
    label: 'Text/code file',
    renderer: 'code',
    next: 'Use read or grep for content; open the sidebar preview for highlighting.',
  },
  tar: { label: 'TAR archive', renderer: 'archive' },
  diff: { label: 'Diff', renderer: 'diff' },
  log: { label: 'Log', renderer: 'log' },
  eml: { label: 'Email', renderer: 'eml' },
  font: { label: 'Font', renderer: 'font' },
  video: { label: 'Video', renderer: 'video' },
  audio: { label: 'Audio', renderer: 'audio' },
  model: { label: '3D model', renderer: '3d' },
}

/**
 * Preview family for a filename, including the compound `.tar.gz` suffix.
 * @param name - file name or path.
 * @returns family key, or undefined when no known renderer claims it.
 */
export function previewFamily(name: string): string | undefined {
  const lower = name.replaceAll('\\', '/').toLowerCase()
  if (lower.endsWith('.tar.gz')) return 'tar'
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return undefined
  return PREVIEW_FAMILIES[lower.slice(dot + 1)]
}

/** ASCII slice, for magic checks. */
function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = ''
  for (let at = start; at < end && at < bytes.length; at += 1) text += String.fromCharCode(bytes[at] ?? 0)
  return text
}

/** Whether a short head looks like text rather than binary. */
function looksText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  let controls = 0
  for (const byte of bytes.subarray(0, 512)) {
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte === 0) return false
    if (byte < 0x20 || byte === 0x7f) controls += 1
  }
  return controls / Math.min(bytes.length, 512) < 0.05
}

/**
 * Detect a format from its first bytes.
 *
 * This is intentionally a small magic table: it covers the formats whose
 * container signature is cheap and unambiguous, plus a text fallback for
 * renamed source files. It does not replace the extension-based inspectors.
 * @param bytes - first kilobyte or less.
 * @returns a format key, or undefined when nothing matches.
 */
export function sniffFormat(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && (u32(bytes, 0) === 0x04034b50 || u32(bytes, 0) === 0x06054b50)) return 'zip'
  if (bytes.length >= 6
    && bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc
    && bytes[3] === 0xaf && bytes[4] === 0x27 && bytes[5] === 0x1c) return '7z'
  if (ascii(bytes, 0, 16) === 'SQLite format 3\u0000') return 'sqlite'
  if (ascii(bytes, 0, 4) === 'GGUF') return 'gguf'
  if (ascii(bytes, 0, 5) === '%PDF-') return 'pdf'
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp'
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip'
  if (bytes.length >= 262 && ascii(bytes, 257, 262) === 'ustar') return 'tar'
  if (ascii(bytes, 0, 4) === 'glTF') return 'glb'
  if (ascii(bytes, 4, 8) === 'ftyp') return 'video'
  if (ascii(bytes, 0, 4) === 'OggS') return 'audio'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'audio'
  return looksText(bytes) ? 'text' : undefined
}

/** Map a magic-detected format to a preview-only family. */
function magicPreviewFamily(kind: string): string | undefined {
  switch (kind) {
    case 'pdf': return 'pdf'
    case 'png': case 'jpeg': case 'gif': case 'webp': return 'image'
    case 'tar': return 'tar'
    case 'video': return 'video'
    case 'audio': return 'audio'
    case 'glb': return 'model'
    case 'text': return 'code'
    default: return undefined
  }
}

/** Human-readable size with the exact count. */
function sizeFact(size: number): string {
  return `${formatBytes(size)} (${size.toLocaleString('en-US')} bytes)`
}

/** Big-endian 16-bit read. */
function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
}

/** Big-endian 32-bit read. */
function u32be(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16)
    | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0
}

/** Little-endian 24-bit read, used by WebP canvas dimensions. */
function u24le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)
}

/** Image format and dimensions from a short head. */
function imageInfo(bytes: Uint8Array): { format: string, width?: number, height?: number } | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') {
    return bytes.length >= 24
      ? { format: 'PNG', width: u32be(bytes, 16), height: u32be(bytes, 20) }
      : { format: 'PNG' }
  }
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    return bytes.length >= 10
      ? { format: 'GIF', width: u16(bytes, 6), height: u16(bytes, 8) }
      : { format: 'GIF' }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at += 1; continue }
      const marker = bytes[at + 1] ?? 0
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'JPEG', width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) }
      }
      const length = u16be(bytes, at + 2)
      if (length < 2) break
      at += 2 + length
    }
    return { format: 'JPEG' }
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    const chunk = ascii(bytes, 12, 16)
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return { format: 'WebP', width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
    }
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      return { format: 'WebP', width: u16(bytes, 26) & 0x3fff, height: u16(bytes, 28) & 0x3fff }
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const b1 = bytes[21] ?? 0
      const b2 = bytes[22] ?? 0
      const b3 = bytes[23] ?? 0
      const b4 = bytes[24] ?? 0
      return {
        format: 'WebP',
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      }
    }
    return { format: 'WebP' }
  }
  if (bytes.length >= 14 && ascii(bytes, 0, 2) === 'BM') {
    return bytes.length >= 26
      ? { format: 'BMP', width: u32(bytes, 18), height: Math.abs(u32(bytes, 22) | 0) }
      : { format: 'BMP' }
  }
  if (bytes.length >= 4 && (ascii(bytes, 0, 4) === '<svg' || ascii(bytes, 0, 5) === '<?xml')) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096))
    if (!/<svg\b/iu.test(text)) return undefined
    const width = /width=["']([\d.]+)/iu.exec(text)?.[1]
    const height = /height=["']([\d.]+)/iu.exec(text)?.[1]
    return {
      format: 'SVG',
      width: width === undefined ? undefined : Number(width),
      height: height === undefined ? undefined : Number(height),
    }
  }
  return undefined
}

/**
 * Describe an image without decoding its pixels.
 * @param bytes - image head.
 * @param size - file size.
 * @returns the image metadata.
 */
export function inspectImage(bytes: Uint8Array, size: number): InspectResult {
  const info = imageInfo(bytes)
  if (info === undefined) throw new Error('image: unrecognized image header')
  const dimensions = info.width !== undefined && info.height !== undefined
    ? `${String(info.width)}×${String(info.height)}`
    : 'unknown'
  return {
    kind: 'image',
    summary: `${info.format} image · ${dimensions} · ${formatBytes(size)}`,
    facts: [
      `format: ${info.format}`,
      `dimensions: ${dimensions}`,
      `size: ${sizeFact(size)}`,
    ],
    schema: [],
    notes: [],
    next: ['在面板中打开图片预览查看像素；颜色/ICC 等细节用短脚本或图像库读取'],
    truncated: false,
  }
}

/**
 * Describe a PDF header.
 * @param bytes - first bytes.
 * @param size - file size.
 * @returns the PDF metadata.
 */
export function inspectPdf(bytes: Uint8Array, size: number): InspectResult {
  const header = ascii(bytes, 0, 16)
  const version = /^%PDF-(\d+\.\d+)/u.exec(header)?.[1]
  if (version === undefined) throw new Error('pdf: header mismatch')
  return {
    kind: 'pdf',
    summary: `PDF ${version} · ${formatBytes(size)}`,
    facts: [`version: ${version}`, `size: ${sizeFact(size)}`],
    schema: [],
    notes: [],
    next: ['在面板中打开 PDF 预览；页文本用 PDF 库或 read 获取'],
    truncated: false,
  }
}

/**
 * Describe a font from its sfnt/WOFF table directory.
 * @param bytes - font head.
 * @param size - file size.
 * @returns the font metadata.
 */
export function inspectFont(bytes: Uint8Array, size: number): InspectResult {
  const signature = ascii(bytes, 0, 4)
  const format = signature === 'OTTO' ? 'OpenType CFF'
    : signature === 'wOFF' ? 'WOFF'
      : signature === 'wOF2' ? 'WOFF2'
        : signature === 'ttcf' ? 'TrueType collection'
          : 'TrueType'
  const numTables = signature === 'wOFF' || signature === 'wOF2' ? u16be(bytes, 12) : u16be(bytes, 4)
  const tables: string[] = []
  let glyphs: number | undefined
  if (signature !== 'wOFF' && signature !== 'wOF2' && signature !== 'ttcf') {
    for (let index = 0; index < numTables; index += 1) {
      const at = 12 + index * 16
      if (at + 16 > bytes.length) break
      const tag = ascii(bytes, at, at + 4)
      tables.push(tag)
      if (tag === 'maxp') {
        const offset = u32be(bytes, at + 8)
        if (offset + 6 <= bytes.length) glyphs = u16be(bytes, offset + 4)
      }
    }
  }
  return {
    kind: 'font',
    summary: `${format} font · ${glyphs === undefined ? 'unknown' : String(glyphs)} glyphs · ${formatBytes(size)}`,
    facts: [
      `format: ${format}`,
      `tables: ${String(numTables)}`,
      ...(glyphs === undefined ? [] : [`glyphs: ${String(glyphs)}`]),
      `size: ${sizeFact(size)}`,
    ],
    schema: tables.slice(0, MAX_ITEMS),
    notes: [],
    next: ['在面板中打开字体预览；字形细节用 fontTools 等库读取'],
    truncated: false,
  }
}

/**
 * Describe a glTF JSON document or a GLB container.
 * @param bytes - head of the model file.
 * @param size - file size.
 * @returns the model metadata.
 */
export function inspectModel(bytes: Uint8Array, size: number): InspectResult {
  let glb = false
  let json = ''
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'glTF') {
    glb = true
    const chunkLength = u32(bytes, 12)
    const chunkType = ascii(bytes, 16, 20)
    if (chunkType !== 'JSON') throw new Error('glb: first chunk is not JSON')
    json = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(20, 20 + chunkLength))
  } else {
    json = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
  const parsed = JSON.parse(json) as {
    asset?: { version?: string, generator?: string }
    scene?: number
    scenes?: unknown[]
    nodes?: Array<{ name?: string }>
    meshes?: unknown[]
    materials?: unknown[]
    animations?: unknown[]
  }
  const version = parsed.asset?.version
  if (version === undefined) throw new Error('gltf: asset.version missing')
  const count = (value: unknown[] | undefined): number => value?.length ?? 0
  const nodes = parsed.nodes ?? []
  return {
    kind: glb ? 'glb' : 'gltf',
    summary: `glTF ${version} · ${String(count(parsed.meshes))} meshes · ${String(count(parsed.materials))} materials`,
    facts: [
      `asset version: ${version}`,
      ...(parsed.asset?.generator === undefined ? [] : [`generator: ${parsed.asset.generator}`]),
      `scenes: ${String(count(parsed.scenes))}`,
      `nodes: ${String(nodes.length)}`,
      `meshes: ${String(count(parsed.meshes))}`,
      `materials: ${String(count(parsed.materials))}`,
      `animations: ${String(count(parsed.animations))}`,
      ...(parsed.scene === undefined ? [] : [`default scene: ${String(parsed.scene)}`]),
      `size: ${sizeFact(size)}`,
    ],
    schema: nodes.slice(0, MAX_ITEMS).map(node => node.name ?? '(unnamed)'),
    notes: [],
    next: ['在面板中打开 3D 预览；几何/包围盒用模型库读取'],
    truncated: false,
  }
}

/**
 * Describe a media container without probing codecs or duration.
 * @param bytes - first bytes.
 * @param size - file size.
 * @returns the media metadata.
 */
export function inspectMedia(bytes: Uint8Array, size: number): InspectResult {
  let format = ''
  const facts: string[] = []
  if (ascii(bytes, 4, 8) === 'ftyp') {
    format = `ISO BMFF (${ascii(bytes, 8, 12).trim()})`
  } else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') {
    format = 'WAV'
    const channels = u16(bytes, 22)
    const sampleRate = u32(bytes, 24)
    facts.push(`channels: ${String(channels)}`, `sample rate: ${String(sampleRate)} Hz`)
  } else if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    format = 'Matroska/WebM'
  } else if (ascii(bytes, 0, 4) === 'OggS') {
    format = 'Ogg'
  } else if (ascii(bytes, 0, 3) === 'ID3') {
    format = 'MP3'
  } else if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x40) {
    format = 'MPEG-TS'
  } else {
    throw new Error('media: unrecognized container')
  }
  return {
    kind: 'media',
    summary: `${format} media · ${formatBytes(size)}`,
    facts: [`container: ${format}`, ...facts, `size: ${sizeFact(size)}`],
    schema: [],
    notes: ['Codec and duration probing are not part of preview_inspect.'],
    next: ['在面板中打开媒体预览；codec/时长用 ffprobe 等工具读取'],
    truncated: false,
  }
}

/**
 * A successful result for a file the sidebar can preview but this tool cannot
 * structurally inspect. This is deliberately not an exception: the file is
 * usable, and the user needs the preview route rather than an error.
 * @param family - preview family key.
 * @param size - file size in bytes.
 * @param detected - format detected by magic, when it differs from the extension.
 * @returns the capability envelope.
 */
export function previewOnlyResult(family: string, size: number, format = family, detected?: string): InspectResult {
  const info = PREVIEW_INFO[family] ?? { label: family, renderer: family }
  const facts = [
    `format: ${format}`,
    `size: ${sizeFact(size)}`,
    ...(detected === undefined ? [] : [`detected: ${detected}`]),
    `preview: ${info.renderer}`,
  ]
  return {
    kind: family,
    capability: 'preview-only',
    summary: `${info.label} · ${formatBytes(size)}`,
    facts,
    schema: [],
    notes: [`No structural inspector for ${info.label.toLowerCase()}; the sidebar preview is the intended view.`],
    next: [info.next ?? 'Open the file in the sidebar preview.'],
    truncated: false,
  }
}

/**
 * A capability envelope for a file no inspector or preview family recognised.
 * @param size - file size in bytes.
 * @param suffix - extension without the dot, or an empty string.
 * @param detected - magic detection, when one ran.
 * @returns the unknown envelope.
 */
export function unknownResult(size: number, suffix: string, detected?: string): InspectResult {
  const label = suffix === '' ? 'no extension' : `.${suffix}`
  const facts = [
    `extension: ${label}`,
    `size: ${sizeFact(size)}`,
    ...(detected === undefined ? [] : [`detected: ${detected}`]),
  ]
  return {
    kind: 'unknown',
    capability: 'unknown',
    summary: `Unknown file · ${formatBytes(size)}`,
    facts,
    schema: [],
    notes: ['No inspector or preview family matched this file.'],
    next: ['Use read or grep for text, or open the file in the sidebar if a preview is available.'],
    truncated: false,
  }
}

/** Mark a pure summariser's result as structurally inspected. */
function inspected(result: InspectResult): InspectResult {
  return { ...result, capability: 'inspected' }
}

/** Describe a GGUF header. */
function inspectGguf(bytes: Uint8Array): InspectResult {
  const header = parseGguf(bytes)
  const kv = header.kv ?? []
  const tensors = header.tensors ?? []
  const find = (key: string): string => {
    const hit = kv.find(entry => entry.key === key)
    return hit === undefined ? '' : String(hit.value)
  }
  const architecture = find('general.architecture')
  const context = find(`${architecture}.context_length`)

  const summary = [
    `GGUF v${String(header.version)}`,
    `${tensors.length.toLocaleString('en-US')} tensors`,
    architecture,
  ].filter(part => part !== '').join(' · ')

  const facts = kv.slice(0, MAX_ITEMS).map(entry => `${entry.key} = ${String(entry.value)}`)
  const schema = tensors.slice(0, MAX_ITEMS).map(
    tensor => `${tensor.name}: ${tensor.type} [${tensor.dims.join('×')}] ${tensor.params.toLocaleString('en-US')} params`,
  )

  const notes: string[] = []
  if (kv.length > MAX_ITEMS) notes.push(`${kv.length.toLocaleString('en-US')} metadata keys, first ${String(MAX_ITEMS)} shown`)
  if (tensors.length > MAX_ITEMS) notes.push(`${tensors.length.toLocaleString('en-US')} tensors, first ${String(MAX_ITEMS)} shown`)
  if (context !== '') notes.push(`context length ${context}`)

  return {
    kind: 'gguf',
    summary,
    facts,
    schema,
    notes,
    next: ['grep(pattern="…") 在文件其它部分定位（GGUF 主体是二进制，仅元数据可读）'],
    truncated: kv.length > MAX_ITEMS || tensors.length > MAX_ITEMS,
  }
}

/** Pick the delimiter that appears most on the first line. */
export { detectDelimiter }

/** How many rows a sample window contributes to the type check. */const SAMPLE_ROWS = 20

/** Longest value shown per column. */
const VALUE_CHARS = 24

/** Types one field can look like. */
type FieldType = 'empty' | 'integer' | 'number' | 'boolean' | 'date' | 'string'

/**
 * What a single field looks like.
 * @param value - one field, already trimmed by the parser.
 */
function typeOf(value: string): FieldType {
  if (value === '') return 'empty'
  if (/^[-+]?\d+$/u.test(value)) return 'integer'
  if (/^[-+]?\d*\.\d+(?:[eE][-+]?\d+)?$/u.test(value)) return 'number'
  if (/^(?:true|false)$/iu.test(value)) return 'boolean'
  // A whole column of `2026-02-02` or `2026-02-02T03:04:05Z` reads better as a date than
  // as a string, and it tells the caller a time column exists.
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[-+]\d{2}:?\d{2})?)?$/u.test(value)) return 'date'
  return 'string'
}

/**
 * Infer a column type from a handful of values; deliberately coarse.
 * @param values - sampled fields of one column.
 */
function inferType(values: readonly string[]): string {
  const seen = new Set<FieldType>()
  for (const value of values) {
    const type = typeOf(value)
    if (type !== 'empty') seen.add(type)
  }
  if (seen.size === 0) return 'empty'
  return seen.size === 1 ? ([...seen][0] ?? 'string') : 'string'
}

/** What the tool knows about a delimited file before it looks inside. */
export interface CsvProbe {
  /** Bytes from the start: all of it when it fits, else the first 1 MB. */
  readonly head: Uint8Array
  /** File size in bytes. */
  readonly size: number
  /** Windows spread across the file, for density and dialect checks. */
  readonly samples: readonly Uint8Array[]
  /** The last kilobyte, for the trailing-newline fact. */
  readonly tail: Uint8Array
}

/**
 * Parse text into rows with the real (quote-aware) parser.
 * @param text - whole lines; the trailing partial line is dropped unless `complete`.
 * @param delimiter - field separator.
 * @param complete - true when `text` is the whole file.
 */
function parseRows(text: string, delimiter: string, complete: boolean): string[][] {
  const rows: string[][] = []
  const parser = createRowParser(delimiter, cells => { rows.push([...cells]) }, LIMITS.csvLineChars)
  parser.push(text)
  if (complete) parser.finish()
  return rows
}

/**
 * Rows a mid-file window contributes: the partial first line is dropped, and the last
 * line is only kept when the window ends on a newline.
 * @param text - one sampled window, decoded.
 * @param delimiter - field separator.
 * @param limit - rows to keep.
 */
function sampleRows(text: string, delimiter: string, limit: number): string[][] {
  const start = text.indexOf('\n')
  const end = text.lastIndexOf('\n')
  if (start === -1 || end <= start) return []
  return parseRows(text.slice(start + 1, end), delimiter, true).slice(0, limit)
}

/**
 * The line ending a text uses: CRLF when most breaks are CRLF, LF otherwise.
 * @param text - decoded bytes.
 */
function lineEnding(text: string): string {
  const crlf = text.split('\r\n').length - 1
  const lf = text.split('\n').length - 1
  if (lf === 0) return 'no line breaks'
  return crlf * 2 > lf ? 'CRLF' : 'LF'
}

/**
 * Describe one column from the values sampled at the head and across the file.
 * @param name - header cell.
 * @param index - column position.
 * @param head - values from the first rows of the file.
 * @param spread - values from the windows sampled across the file.
 */
function describeColumn(
  name: string,
  index: number,
  head: readonly string[],
  spread: readonly string[],
): string {
  const label = name === '' ? `column_${String(index + 1)}` : name
  const headTypes = new Set(head.map(typeOf).filter(type => type !== 'empty'))
  const spreadTypes = new Set(spread.map(typeOf).filter(type => type !== 'empty'))
  const all = [...head, ...spread]
  const filled = all.filter(value => value !== '')
  const empties = all.length - filled.length

  const parts: string[] = []
  const main = inferType(head.length > 0 ? head : all)
  parts.push(main)
  const examples = [...new Set(filled)].slice(0, 2).map(value => value.length > VALUE_CHARS ? `${value.slice(0, VALUE_CHARS)}…` : value)
  if (examples.length > 0) parts.push(`(${examples.join(', ')})`)
  if (empties > 0 && all.length > 0) parts.push(`${String(Math.round((empties / all.length) * 100))}% empty`)
  // The interesting case is a column that changes kind deeper in the file: a loader that
  // trusts the first rows alone would fail on the sampled ones.
  const changed = [...headTypes].length > 0 && spreadTypes.size > 0 && [...spreadTypes].some(type => !headTypes.has(type))
  if (changed) {
    const other = [...spreadTypes].find(type => !headTypes.has(type))
    const sample = spread.find(value => typeOf(value) === other)
    parts.push(`also ${other ?? 'string'}${sample === undefined ? '' : ` (${sample.length > VALUE_CHARS ? `${sample.slice(0, VALUE_CHARS)}…` : sample})`} in samples`)
  }
  if (main === 'integer' && filled.length >= 2 && [...filled].every(value => typeOf(value) === 'integer')) {
    const numbers = filled.map(Number)
    const ascending = numbers.every((value, position) => position === 0 || value >= (numbers[position - 1] ?? 0))
    if (ascending) parts.push('ascending in samples')
  }
  return `${label}: ${parts.join(' · ')}`
}

/**
 * Describe a delimited text file: the whole-file shape from cheap probes, the columns
 * from a parse of the head plus a few rows of each sampled window.
 *
 * The head alone describes 1 MB of a 150 MB file, so the row count, the row-length
 * spread and the dialect are measured across the file instead of extrapolated from its
 * beginning. Nothing here reads the whole file: four 32 KB windows are enough to know
 * whether the rows are uniform and whether the delimiter holds.
 * @param probe - head bytes, size, sampled windows and the tail.
 */
function inspectCsv(probe: CsvProbe): InspectResult {
  const { head, size, samples, tail } = probe
  if (head.length === 0) throw new Error('file is empty')

  const bom = head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF
  const body = bom ? head.subarray(3) : head
  let text: string
  let valid = true
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    valid = false
    text = new TextDecoder('utf-8', { fatal: false }).decode(body)
  }

  const complete = size <= head.length
  const delimiter = detectDelimiter(text)
  const rows = parseRows(text, delimiter, complete)
  if (rows.length === 0) throw new Error('file is empty')

  const header = rows[0] ?? []
  const columns = header.length
  const dataRows = rows.slice(1)

  const decoded = samples.map(sample => new TextDecoder('utf-8', { fatal: false }).decode(sample))
  const sampled = decoded.map(sample => sampleRows(sample, delimiter, SAMPLE_ROWS))

  // Density: the head counts rows in its own bytes, each window in its own.
  const probes: DensityProbe[] = [{ rows: countNewlines(text), bytes: body.length }]
  for (const [position, sample] of samples.entries()) {
    const sampleText = decoded[position] ?? ''
    probes.push({ rows: countNewlines(sampleText), bytes: sample.length })
  }
  const estimated = rowsAt(size, probes)
  const spread = densitySpread(probes)
  const lengths = rowLengthRange(probes)

  // Dialect: a file stitched together from several exports can change separator halfway.
  const dialects = new Set(decoded.map(sample => detectDelimiter(sample)))
  const disagrees = [...dialects].filter(candidate => candidate !== delimiter)

  // Ragged: sample rows whose field count is not the header's.
  const flat = sampled.flat()
  const ragged = flat.filter(row => row.length !== columns).length
  // A quoted field can hold a newline, in which case a line is not a row.
  const embedded = complete ? Math.max(0, countNewlines(text) - rows.length) : 0

  const schema = header.slice(0, MAX_ITEMS).map((column, index) => {
    const headValues = dataRows.slice(0, SAMPLE_ROWS).map(row => row[index] ?? '')
    const deeper = sampled.map(sample => sample.slice(0, SAMPLE_ROWS).map(row => row[index] ?? '')).flat()
    return describeColumn(column, index, headValues, deeper)
  })

  // Is the first row a header? A column that is numeric in the data but text in row 0
  // confirms it; a first row typed exactly like the data is data; a file of all-string
  // columns gives nothing to confirm with, so the header is only assumed.
  const dataTypes = header.map((_value, index) => typeOf(dataRows[0]?.[index] ?? ''))
  const typedColumns = dataTypes.filter(type => type !== 'string' && type !== 'empty').length
  const confirmed = header.some((value, index) => {
    const data = dataTypes[index] ?? 'empty'
    const first = typeOf(value)
    return data !== 'string' && data !== 'empty' && first !== 'empty' && first !== data
  })
  const names = header.slice(0, MAX_ITEMS).join(' | ')
  const headerFact = confirmed
    ? `header: ${names}`
    : typedColumns === 0
      ? `header: ${names} (assumed; no typed column to confirm it)`
      : `header: none detected — the first row looks like data (${header.slice(0, 3).join(', ')})`

  const facts = [
    `size: ${(size / 1024 / 1024).toFixed(2)} MB (${size.toLocaleString('en-US')} bytes)`,
    `rows: ~${estimated.toLocaleString('en-US')} (est. from the head + ${String(samples.length)} windows, ${lengths.min.toFixed(0)}–${lengths.max.toFixed(0)} bytes/row)`,
    `columns: ${String(columns)}`,
    `delimiter: ${JSON.stringify(delimiter === '\t' ? 'tab' : delimiter)} (${disagrees.length === 0 ? `same in all ${String(samples.length + 1)} windows` : `differs: ${disagrees.map(value => JSON.stringify(value)).join(', ')}`})`,
    `line endings: ${lineEnding(text)}${tail.length > 0 ? (tail[tail.length - 1] === 0x0A ? ' · ends with a newline' : ' · no trailing newline') : ''}`,
    `encoding: ${valid ? 'UTF-8' : 'UTF-8, invalid bytes replaced'}${bom ? ' with BOM' : ''}`,
    headerFact,
  ]

  const notes: string[] = []
  if (!complete) {
    notes.push(`only the first ${(body.length / 1024 / 1024).toFixed(0)} MB was parsed; the row count and row length come from the head and ${String(samples.length)} sampled windows`)
  }
  if (spread > 1.05) {
    notes.push(`row length varies ${spread.toFixed(2)}× across the file: an offset in bytes infers row numbers to ±${String(Math.round((spread - 1) * 100))}%`)
  }
  if (disagrees.length > 0) {
    notes.push(`delimiter is ${JSON.stringify(delimiter)} at the head but ${disagrees.map(value => JSON.stringify(value)).join(', ')} in samples`)
  }
  if (ragged > 0) {
    notes.push(`${String(ragged)} of ${String(flat.length)} sampled rows have a different field count`)
  }
  if (embedded > 0) {
    notes.push(`quoted fields hold newlines (${String(embedded)} more newlines than rows): parse as CSV, not by lines`)
  }
  if (bom) notes.push('UTF-8 BOM: the first column name includes it unless stripped')
  if (columns > MAX_ITEMS) notes.push(`${String(columns)} columns, first ${String(MAX_ITEMS)} shown`)

  const next = size > TEXT_BYTES
    ? ['在面板中打开：按行随机访问，不必读全文件（精确行数在索引完成后可见）', 'grep(pattern="…") 扫描整份文件；read 只适合小片段']
    : ['read(offset=1, limit=50) 查看表头与首批数据', 'grep(pattern="…") 按内容定位行']
  if (embedded > 0) next.push('行不是记录：按 CSV 解析，而不是按换行数')
  if (ragged > 0) next.push(`列数不齐：按表头的 ${String(columns)} 列解析，多出的字段会保留在后面`)

  return {
    kind: 'csv',
    // The estimate itself is well sampled; the spread is a caveat about *offsets*, not
    // about the count, so it stays in the notes instead of being presented as ± error.
    summary: `delimited text · ${String(columns)} columns · delimiter ${JSON.stringify(delimiter === '\t' ? 'tab' : delimiter)} · ~${estimated.toLocaleString('en-US')} rows`,
    facts,
    schema,
    notes,
    next,
    truncated: columns > MAX_ITEMS,
  }
}

/** A reader over one file's bytes, supplied by the caller. */
type Reader = (offset: number, length: number) => Promise<Uint8Array>

/** Describe a line-delimited JSON file from its first bytes. */
function inspectJsonl(bytes: Uint8Array, truncatedRead: boolean): InspectResult {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '')
  if (lines.length === 0) throw new Error('file is empty')

  const counts = new Map<string, number>()
  let objects = 0
  let invalid = 0
  for (const line of lines.slice(0, 500)) {
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        objects += 1
        for (const key of Object.keys(value as Record<string, unknown>)) {
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      } else {
        invalid += 1
      }
    } catch {
      invalid += 1
    }
  }

  const sampled = Math.min(lines.length, 500)
  const fields = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ITEMS)
  const notes: string[] = []
  if (invalid > 0) notes.push(`${String(invalid)} of the first ${String(sampled)} lines are not JSON objects`)
  if (sampled < lines.length) notes.push(`only the first ${String(sampled)} lines were sampled`)
  if (truncatedRead) notes.push('only the first 1 MB was read')

  return {
    kind: 'jsonl',
    summary: `JSONL · ${String(objects)} objects sampled · ${String(fields.length)} distinct fields`,
    facts: [
      `sampled lines: ${String(sampled)}`,
      `objects: ${String(objects)}`,
      `invalid lines: ${String(invalid)}`,
    ],
    schema: fields.map(([key, count]) => `${key}: present in ${String(count)}/${String(objects)} objects`),
    notes,
    next: ['read(offset=1, limit=20) 查看原始记录', 'grep(pattern="…") 按字段值定位'],
    truncated: truncatedRead || sampled < lines.length,
  }
}

/** Describe a zip archive from its tail and central directory. */
async function inspectZip(size: number, read: Reader): Promise<InspectResult> {
  const tailLength = Math.min(size, 66_000)
  const tail = await read(size - tailLength, tailLength)
  const eocd = findEocd(tail)
  if (eocd < 0) throw new Error('zip: no end-of-central-directory record')

  const entries = u16(tail, eocd + 10)
  const directorySize = u32(tail, eocd + 12)
  const directoryOffset = u32(tail, eocd + 16)
  if (directorySize === 0 || directoryOffset === 0) throw new Error('zip: empty central directory')

  const directory = await read(directoryOffset, directorySize)
  const listed = parseZipDirectory(directory)
  const files = listed.filter(entry => !entry.directory)
  const totalSize = files.reduce((sum, entry) => sum + entry.size, 0)
  const totalCompressed = files.reduce((sum, entry) => sum + entry.compressedSize, 0)

  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, 5)
  const notes: string[] = []
  if (entries > listed.length) notes.push(`central directory lists ${String(listed.length)} of ${String(entries)} entries`)
  if (totalSize > 0) notes.push(`compressed ${(totalCompressed / 1024 / 1024).toFixed(2)} MB into ${(totalSize / 1024 / 1024).toFixed(2)} MB`)

  return {
    kind: 'zip',
    summary: `ZIP · ${String(files.length)} files · ${(totalSize / 1024 / 1024).toFixed(2)} MB uncompressed`,
    facts: [
      `entries: ${String(listed.length)}`,
      `files: ${String(files.length)}`,
      `directories: ${String(listed.length - files.length)}`,
      `uncompressed total: ${(totalSize / 1024 / 1024).toFixed(2)} MB`,
    ],
    schema: largest.map(entry => `${entry.name}: ${(entry.size / 1024).toFixed(0)} KB`),
    notes,
    next: ['在面板中打开压缩包可直接列出条目', '若需按扩展名预览某个条目，先解压到工作区'],
    truncated: listed.length < entries,
  }
}

/**
 * Describe a tar / tar.gz archive from its whole payload.
 *
 * Tar has no random-access directory, so this is the one inspector that reads
 * the container whole; the archive cap keeps it bounded.
 * @param size - archive size in bytes.
 * @param read - reader over the file.
 * @returns the archive summary.
 */
export async function inspectTar(size: number, read: Reader): Promise<InspectResult> {
  if (size === 0) throw new Error('tar: file is empty')
  if (size > LIMITS.archiveWhole) {
    throw new Error(`tar: ${formatBytes(size)} exceeds the ${formatBytes(LIMITS.archiveWhole)} cap`)
  }
  const raw = await read(0, size)
  const gzipped = raw[0] === 0x1f && raw[1] === 0x8b
  const bytes = gzipped
    ? new Uint8Array(gunzipSync(raw, { maxOutputLength: LIMITS.archiveWhole }))
    : raw
  const entries = parseTar(bytes)
  if (entries.length === 0) throw new Error('tar: no members found')
  const files = entries.filter(entry => !entry.directory)
  const total = files.reduce((sum, entry) => sum + entry.size, 0)
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, MAX_ITEMS)
  const notes: string[] = []
  if (entries.length > MAX_ITEMS) notes.push(`${String(entries.length)} entries, first ${String(MAX_ITEMS)} listed`)
  if (gzipped) notes.push('gzip compressed; the listed offsets are in the inflated tar')
  return {
    kind: 'tar',
    summary: `${gzipped ? 'TAR.GZ' : 'TAR'} · ${String(files.length)} files · ${(total / 1024).toFixed(1)} KB uncompressed`,
    facts: [
      `entries: ${String(entries.length)}`,
      `files: ${String(files.length)}`,
      `directories: ${String(entries.length - files.length)}`,
      `uncompressed total: ${(total / 1024).toFixed(1)} KB`,
    ],
    schema: largest.map(entry => `${entry.name}: ${(entry.size / 1024).toFixed(0)} KB`),
    notes,
    next: ['在面板中打开压缩包可直接浏览条目'],
    truncated: entries.length > MAX_ITEMS,
  }
}

/**
 * Describe an OOXML package (docx/xlsx/pptx) from its ZIP central directory.
 * @param size - package size in bytes.
 * @param read - reader over the file.
 * @returns the Office summary.
 */
export async function inspectOffice(size: number, read: Reader): Promise<InspectResult> {
  const tailLength = Math.min(size, 66_000)
  const tail = await read(size - tailLength, tailLength)
  const eocd = findEocd(tail)
  if (eocd < 0) throw new Error('office: no end-of-central-directory record')
  const directorySize = u32(tail, eocd + 12)
  const directoryOffset = u32(tail, eocd + 16)
  const entries = parseZipDirectory(await read(directoryOffset, directorySize))
  if (entries.length === 0) throw new Error('office: empty package')
  const names = entries.map(entry => entry.name)
  const main = names.find(name => name === 'word/document.xml')
    ?? names.find(name => name === 'xl/workbook.xml')
    ?? names.find(name => name === 'ppt/presentation.xml')
  if (main === undefined) throw new Error('office: no known document part')
  const kind = main.startsWith('word/') ? 'docx' : main.startsWith('xl/') ? 'xlsx' : 'pptx'
  const label = kind === 'docx' ? 'Word document' : kind === 'xlsx' ? 'Excel workbook' : 'PowerPoint presentation'
  const files = entries.filter(entry => !entry.directory)
  const total = files.reduce((sum, entry) => sum + entry.size, 0)
  const keyParts = names.filter(name => (
    name === '[Content_Types].xml'
    || name === main
    || name === 'word/styles.xml'
    || name === 'xl/sharedStrings.xml'
    || name.startsWith('ppt/slides/slide')
  )).slice(0, MAX_ITEMS)
  return {
    kind,
    summary: `${label} · ${String(files.length)} parts · ${(total / 1024).toFixed(1)} KB uncompressed`,
    facts: [
      'container: zip',
      `main part: ${main}`,
      `entries: ${String(entries.length)}`,
      `uncompressed total: ${(total / 1024).toFixed(1)} KB`,
    ],
    schema: keyParts,
    notes: [],
    next: ['在面板中打开 Office 预览查看内容'],
    truncated: entries.length > MAX_ITEMS,
  }
}

/**
 * Describe an email from its header block and attachment names.
 * @param bytes - message head.
 * @param truncatedRead - whether only the head was read.
 * @returns the email summary.
 */
export function inspectEml(bytes: Uint8Array, truncatedRead = false): InspectResult {
  const doc = parseEml(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
  const value = (name: string): string => (
    doc.headers.find(header => header.name.toLowerCase() === name)?.value.trim() ?? ''
  )
  const subject = value('subject')
  const from = value('from')
  const to = value('to')
  const date = value('date')
  const attachments = doc.attachments.slice(0, MAX_ITEMS)
  const facts = [
    `from: ${from === '' ? '(missing)' : from}`,
    `to: ${to === '' ? '(missing)' : to}`,
    `date: ${date === '' ? '(missing)' : date}`,
    `content-type: ${doc.contentType === '' ? '(missing)' : doc.contentType}`,
    `attachments: ${String(doc.attachments.length)}`,
  ]
  return {
    kind: 'eml',
    summary: `Email${subject === '' ? '' : ` · ${subject}`} · ${String(doc.attachments.length)} attachments`,
    facts,
    schema: attachments,
    notes: truncatedRead ? ['only the first 1 MB was read'] : [],
    next: ['在面板中打开邮件预览查看正文'],
    truncated: truncatedRead || doc.attachments.length > MAX_ITEMS,
  }
}

/**
 * Describe a unified diff without dumping its lines.
 * @param bytes - diff head.
 * @param truncatedRead - whether only the head was read.
 * @returns the diff summary.
 */
export function inspectDiff(bytes: Uint8Array, truncatedRead = false): InspectResult {
  const lines = new TextDecoder('utf-8', { fatal: false }).decode(bytes).split(/\r?\n/u)
  const files = new Set<string>()
  let hunks = 0
  let added = 0
  let removed = 0
  for (const line of lines) {
    const kind = classifyDiffLine(line)
    if (kind === 'hunk') hunks += 1
    if (kind === 'add') added += 1
    if (kind === 'del') removed += 1
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/^b\//u, '')
      if (name !== '/dev/null') files.add(name)
    }
  }
  const names = [...files]
  return {
    kind: 'diff',
    summary: `${String(names.length)} files · ${String(hunks)} hunks · +${String(added)}/−${String(removed)}`,
    facts: [
      `files: ${String(names.length)}`,
      `hunks: ${String(hunks)}`,
      `added: ${String(added)}`,
      `removed: ${String(removed)}`,
      `lines: ${String(lines.length)}`,
    ],
    schema: names.slice(0, MAX_ITEMS),
    notes: truncatedRead ? ['only the first 1 MB was read'] : [],
    next: ['在面板中打开 diff 预览查看逐行内容'],
    truncated: truncatedRead || names.length > MAX_ITEMS,
  }
}

/**
 * Inspect one already-extracted member by its name and bytes.
 *
 * This is the same routing as a normal file, but over an in-memory reader; it
 * lets archive-member inspection reuse every parser instead of materialising a
 * temporary file.
 * @param name - member name, used for the extension.
 * @param bytes - member payload.
 * @param read - reader over the payload.
 * @returns the member's inspection result.
 */
async function inspectEntryBytes(name: string, bytes: Uint8Array, read: Reader): Promise<InspectResult> {
  const size = bytes.length
  const lower = name.replaceAll('\\', '/').toLowerCase()
  const suffix = extname(lower).slice(1)
  if (lower.endsWith('.tar.gz')) return inspected(await inspectTar(size, read))
  if (suffix === 'tar' || suffix === 'tgz') return inspected(await inspectTar(size, read))
  if (suffix === 'csv' || suffix === 'tsv' || suffix === 'tab') {
    return inspected(inspectCsv({ head: bytes, size, samples: [], tail: bytes.slice(-TAIL_BYTES) }))
  }
  if (suffix === 'jsonl' || suffix === 'ndjson') return inspected(inspectJsonl(bytes, false))
  if (suffix === 'zip') return inspected(await inspectZip(size, read))
  if (suffix === 'sqlite' || suffix === 'sqlite3' || suffix === 'db' || suffix === 'db3') {
    return inspected(await inspectSqlite(read))
  }
  if (suffix === '7z') return inspected(await inspectSevenZip(read))
  if (suffix === 'safetensors') return inspected(await inspectSafetensors(size, read))
  if (suffix === 'ipynb') return inspected(inspectNotebook(bytes))
  if (suffix === 'rst') return inspected(inspectRst(bytes, false))
  if (suffix === 'epub') return inspected(await inspectEpub(size, read))
  if (suffix === 'docx' || suffix === 'xlsx' || suffix === 'pptx') {
    return inspected(await inspectOffice(size, read))
  }
  if (suffix === 'doc' || suffix === 'xls' || suffix === 'ppt') {
    return previewOnlyResult('office', size, suffix)
  }
  if (suffix === 'eml') return inspected(inspectEml(bytes))
  if (suffix === 'diff' || suffix === 'patch') return inspected(inspectDiff(bytes))
  if (suffix === 'png' || suffix === 'jpg' || suffix === 'jpeg' || suffix === 'gif'
    || suffix === 'webp' || suffix === 'bmp' || suffix === 'svg') {
    return inspected(inspectImage(bytes, size))
  }
  if (suffix === 'pdf') return inspected(inspectPdf(bytes, size))
  if (suffix === 'ttf' || suffix === 'otf' || suffix === 'woff' || suffix === 'woff2') {
    return inspected(inspectFont(bytes, size))
  }
  if (suffix === 'gltf' || suffix === 'glb') return inspected(inspectModel(bytes, size))
  const mediaFamily = PREVIEW_FAMILIES[suffix]
  if (mediaFamily === 'video' || mediaFamily === 'audio') {
    try {
      return inspected(inspectMedia(bytes, size))
    } catch {
      return previewOnlyResult(mediaFamily, size, suffix)
    }
  }
  if (suffix === 'gguf') {
    if (!looksLikeGguf(bytes)) throw new Error('not a GGUF file (magic mismatch)')
    return inspected(inspectGguf(bytes))
  }
  if (looksText(bytes)) return previewOnlyResult('code', size, suffix)
  return unknownResult(size, suffix)
}

/**
 * Inspect `archive!/entry` without extracting to disk.
 * @param archivePath - archive path as typed.
 * @param entryName - member name after `!/`.
 * @param size - archive size.
 * @param read - reader over the archive.
 * @returns the member result with archive context facts.
 */
async function inspectArchiveEntry(
  archivePath: string,
  entryName: string,
  size: number,
  read: Reader,
): Promise<InspectResult> {
  if (size > LIMITS.archiveWhole) {
    throw new Error(`archive: ${formatBytes(size)} exceeds the ${formatBytes(LIMITS.archiveWhole)} cap`)
  }
  const lower = archivePath.replaceAll('\\', '/').toLowerCase()
  let bytes: Uint8Array
  if (lower.endsWith('.zip')) {
    const raw = await read(0, size)
    bytes = await zipEntryBytes(raw, entryName, inflateRawSync)
  } else if (lower.endsWith('.tar') || lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) {
    const raw = await read(0, size)
    const gzipped = raw[0] === 0x1f && raw[1] === 0x8b
    const data = gzipped
      ? new Uint8Array(gunzipSync(raw, { maxOutputLength: LIMITS.archiveWhole }))
      : raw
    const wanted = entryName.replaceAll('\\', '/').replace(/^\.\//u, '')
    const entry = parseTar(data).find(candidate => (
      candidate.name.replaceAll('\\', '/').replace(/^\.\//u, '') === wanted
    ))
    if (entry === undefined) throw new Error(`archive: no ${entryName}`)
    if (entry.directory) throw new Error(`archive: ${entryName} is a directory`)
    bytes = data.subarray(entry.offset, entry.offset + entry.size)
  } else if (lower.endsWith('.7z')) {
    bytes = await inspectSevenZipMember(size, read, entryName)
  } else {
    throw new Error('archive: only zip, tar and 7z members are supported')  }
  if (bytes.length > LIMITS.archiveEntry) {
    throw new Error(`archive: member ${formatBytes(bytes.length)} exceeds the ${formatBytes(LIMITS.archiveEntry)} cap`)
  }
  const entryRead: Reader = async (offset, length) => bytes.subarray(offset, offset + length)
  const result = await inspectEntryBytes(entryName, bytes, entryRead)
  return {
    ...result,
    summary: `${result.summary} · in ${basename(archivePath)}`,
    facts: [`archive: ${basename(archivePath)}`, `entry: ${entryName}`, ...result.facts],
    capability: result.capability ?? 'inspected',
  }
}

/** Describe a SQLite database from its header and schema table. */
async function inspectSqlite(read: Reader): Promise<InspectResult> {
  const header = parseSqliteHeader(await read(0, 100))
  if (header === undefined) throw new Error('not a SQLite database (magic mismatch)')

  const schema = await collectSchema({
    header,
    readPage: pageNumber => read((pageNumber - 1) * header.pageSize, header.pageSize),
  })

  const objects = schema.objects
  const tables = objects.filter(object => object.type === 'table')
  const indexes = objects.filter(object => object.type === 'index')
  const views = objects.filter(object => object.type === 'view')

  return {
    kind: 'sqlite',
    summary: `SQLite · ${String(tables.length)} tables · ${String(indexes.length)} indexes`,
    facts: [
      `tables: ${String(tables.length)}`,
      `indexes: ${String(indexes.length)}`,
      `views: ${String(views.length)}`,
      `triggers: ${String(objects.filter(object => object.type === 'trigger').length)}`,
    ],
    schema: objects.slice(0, MAX_ITEMS).map(object => `${object.type} ${object.name}: ${object.sql ?? ''}`.trim()),
    notes: objects.length > MAX_ITEMS ? [`${String(objects.length)} objects, first ${String(MAX_ITEMS)} shown`] : [],
    next: ['在面板中打开数据库可看到每个对象完整的 CREATE 语句'],
    truncated: schema.truncated || objects.length > MAX_ITEMS,
  }
}
/** Describe a safetensors header (8-byte length prefix plus JSON). */
async function inspectSafetensors(size: number, read: Reader): Promise<InspectResult> {
  const prefix = await read(0, 8)
  const headerLength = readHeaderLength(prefix)
  if (headerLength === undefined) throw new Error('not a safetensors file (length prefix missing)')
  const bytes = await read(8, Math.min(headerLength, size - 8))
  const header = parseHeaderJson(new TextDecoder().decode(bytes), headerLength)
  const dtypes = header.dtypes.map(([dtype, count]) => `${dtype}: ${String(count)}`)

  return {
    kind: 'safetensors',
    summary: `safetensors · ${String(header.tensors.length)} tensors · ${header.totalParams.toLocaleString('en-US')} params`,
    facts: [
      `tensors: ${String(header.tensors.length)}`,
      `parameters: ${header.totalParams.toLocaleString('en-US')}`,
      `header bytes: ${String(headerLength)}`,
      `metadata keys: ${String(header.metadata.length)}`,
    ],
    schema: header.tensors.slice(0, MAX_ITEMS).map(
      tensor => `${tensor.name}: ${tensor.dtype} [${tensor.shape.join('×')}] ${tensor.params.toLocaleString('en-US')}`,
    ),
    notes: dtypes.slice(0, 5),
    next: ['在面板中打开可看到完整张量表与 dtype 分布'],
    truncated: header.tensors.length > MAX_ITEMS,
  }
}

/** Describe a reStructuredText document by its outline. */
function inspectRst(bytes: Uint8Array, truncatedRead: boolean): InspectResult {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const blocks = parseRst(text)
  const { headings, counts } = outlineOf(blocks)

  return {
    kind: 'rst',
    summary: `reST · ${String(headings.length)} headings · ${String(counts.paragraph ?? 0)} paragraphs`,
    facts: [
      `headings: ${String(headings.length)}`,
      `paragraphs: ${String(counts.paragraph ?? 0)}`,
      `literal blocks: ${String(counts.code ?? 0)}`,
      `tables: ${String(counts.table ?? 0)}`,
      `lists: ${String(counts.list ?? 0)}`,
    ],
    schema: headings.slice(0, MAX_ITEMS).map(heading => `${'  '.repeat(Math.max(0, heading.level - 1))}${heading.text}`),
    notes: [
      ...(truncatedRead ? ['only the first 2 MB was read'] : []),
      ...(headings.length > MAX_ITEMS ? [`${String(headings.length)} headings, first ${String(MAX_ITEMS)} shown`] : []),
    ],
    next: ['在面板中打开可按章节阅读', 'grep(pattern="…") 定位具体段落'],
    truncated: truncatedRead || headings.length > MAX_ITEMS,
  }
}

/** Describe a notebook by its cells, not their content. */
function inspectNotebook(bytes: Uint8Array): InspectResult {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  const notebook = parseNotebook(parsed)
  const markdown = notebook.cells.filter(cell => cell.kind === 'markdown').length
  const code = notebook.cells.filter(cell => cell.kind === 'code').length
  const withOutput = notebook.cells.filter(cell => (cell.outputs ?? []).length > 0).length

  return {
    kind: 'ipynb',
    summary: `notebook · ${String(notebook.cells.length)} cells · ${String(code)} code`,
    facts: [
      `cells: ${String(notebook.cells.length)}`,
      `markdown: ${String(markdown)}`,
      `code: ${String(code)}`,
      `cells with output: ${String(withOutput)}`,
    ],
    schema: notebook.cells.slice(0, MAX_ITEMS).map((cell, index) => `#${String(index + 1)} ${cell.kind}: ${(cell.source ?? '').split('\n')[0]?.slice(0, 80) ?? ''}`),
    notes: notebook.cells.length > MAX_ITEMS ? [`${String(notebook.cells.length)} cells, first ${String(MAX_ITEMS)} shown`] : [],
    next: ['在面板中打开可逐单元格阅读'],
    truncated: notebook.cells.length > MAX_ITEMS,
  }
}

/** Describe an EPUB by its archive shape (entries, not rendered text). */
async function inspectEpub(size: number, read: Reader): Promise<InspectResult> {
  const tailLength = Math.min(size, 66_000)
  const tail = await read(size - tailLength, tailLength)
  const eocd = findEocd(tail)
  if (eocd < 0) throw new Error('epub: no end-of-central-directory record')
  const directorySize = u32(tail, eocd + 12)
  const directoryOffset = u32(tail, eocd + 16)
  const entries = parseZipDirectory(await read(directoryOffset, directorySize))

  const names = entries.map(entry => entry.name)
  const xhtml = names.filter(name => /\.x?html?$/iu.test(name)).length
  const images = names.filter(name => /\.(?:png|jpe?g|gif|svg|webp)$/iu.test(name)).length
  const styles = names.filter(name => /\.css$/iu.test(name)).length
  const hasContainer = names.some(name => name === 'META-INF/container.xml')
  const opf = names.find(name => name.endsWith('.opf')) ?? ''

  return {
    kind: 'epub',
    summary: `EPUB · ${String(xhtml)} chapters · ${String(images)} images`,
    facts: [
      `entries: ${String(entries.length)}`,
      `chapters (html): ${String(xhtml)}`,
      `images: ${String(images)}`,
      `stylesheets: ${String(styles)}`,
      `package document: ${opf === '' ? 'missing' : opf}`,
    ],
    schema: names.slice(0, MAX_ITEMS),
    notes: hasContainer ? [] : ['META-INF/container.xml is missing; the book may not open'],
    next: ['在面板中打开可按章节阅读'],
    truncated: entries.length > MAX_ITEMS,
  }
}
/** Load lib/lzma.wasm once, for archives whose header is compressed. */
let cachedDecoder: Promise<Decoder> | undefined
async function sevenZipDecoder(): Promise<Decoder> {
  cachedDecoder ??= (async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const path = fileURLToPath(new URL('../../lib/lzma.wasm', import.meta.url))
    const module = await WebAssembly.compile(await readFile(path))
    const instance = await WebAssembly.instantiate(module, {})
    return instance.exports as unknown as Decoder
  })()
  return cachedDecoder
}

/** Read and parse a 7z archive header, decoding an encoded header when needed. */
async function readSevenZipArchive(read: Reader): Promise<SevenZipArchive> {
  const layout = readLayout(await read(0, 32))
  if (layout === undefined) throw new Error('not a 7z archive (signature mismatch)')

  let header = await read(32 + layout.nextHeaderOffset, layout.nextHeaderSize)
  if (isEncodedHeader(header)) {
    const streams = parseEncodedHeader(header)
    const folder = streams?.folders[0]
    const stream = streams?.packStreams[0]
    if (streams === undefined || folder === undefined || stream === undefined) {
      throw new Error('7z: encoded header is incomplete')
    }
    const bytes = await read(32 + stream.offset, stream.size)
    header = decodeFolder(await sevenZipDecoder(), folder, [bytes])
  }

  const archive = parseHeader(header)
  if (archive === undefined) throw new Error('7z: header could not be parsed')
  return archive
}

/** Decode one member from a 7z archive; solid folders decode as a whole. */
async function inspectSevenZipMember(size: number, read: Reader, entryName: string): Promise<Uint8Array> {
  if (size > LIMITS.archiveWhole) {
    throw new Error(`7z: ${formatBytes(size)} exceeds the ${formatBytes(LIMITS.archiveWhole)} cap`)
  }
  const archive = await readSevenZipArchive(read)
  if (archive.encrypted) throw new Error('7z: encrypted archive cannot be decoded')
  const wanted = entryName.replaceAll('\\', '/').replace(/^\.\//u, '')
  const entry = archive.entries.find(candidate => (
    candidate.name.replaceAll('\\', '/').replace(/^\.\//u, '') === wanted
  ))
  if (entry === undefined) throw new Error(`7z: no ${entryName}`)
  if (entry.directory) throw new Error(`7z: ${entryName} is a directory`)
  const folder = archive.folders[entry.folder]
  const fallback = archive.packStreams[0]
  if (folder === undefined || fallback === undefined) throw new Error('7z: entry has no stream')
  if (!canDecode(folder)) throw new Error('7z: unsupported coder chain (AES or filters)')
  const packs = await Promise.all(folder.packs.map(index => {
    const stream = archive.packStreams[index] ?? fallback
    return read(32 + stream.offset, stream.size)
  }))
  const output = decodeFolder(await sevenZipDecoder(), folder, packs)
  let offset = 0
  for (let index = 0; index < entry.stream; index += 1) offset += folder.sizes[index] ?? 0
  return output.slice(offset, offset + entry.size)
}

/** Describe a 7z archive: entries, sizes, and whether it can be opened. */
async function inspectSevenZip(read: Reader): Promise<InspectResult> {
  const archive = await readSevenZipArchive(read)
  const files = archive.entries.filter(entry => !entry.directory)
  const total = files.reduce((sum, entry) => sum + entry.size, 0)
  const largest = [...files].sort((a, b) => b.size - a.size).slice(0, MAX_ITEMS)
  const encrypted = archive.encrypted
  const solid = archive.solid

  const notes: string[] = []
  if (solid) notes.push('solid: entries share a folder, so opening one decodes all of them')
  if (encrypted) notes.push('encrypted: AES-256 folders cannot be decoded without a password')
  if (files.length > MAX_ITEMS) notes.push(`${String(files.length)} files, ${String(MAX_ITEMS)} listed`)

  return {
    kind: '7z',
    summary: `7z · ${String(files.length)} files · ${(total / 1024).toFixed(1)} KB uncompressed${solid ? ' · solid' : ''}`,
    facts: [
      `files: ${String(files.length)}`,
      `directories: ${String(archive.entries.length - files.length)}`,
      `uncompressed total: ${(total / 1024).toFixed(1)} KB`,
      `folders: ${String(archive.folders.length)}`,
      `encrypted: ${encrypted ? 'yes' : 'no'}`,
      `solid: ${solid ? 'yes' : 'no'}`,
    ],
    schema: largest.map(entry => `${entry.name}: ${(entry.size / 1024).toFixed(1)} KB`),
    notes,
    next: [
      '在面板中打开可直接列出条目并按需解码',
      encrypted ? '"解压后用主预览查看" 是当前对加密包的处理' : 'read(offset=…) 无法直接读压缩内容，需先解压',
    ],
    truncated: files.length > MAX_ITEMS,
  }
}
/**
 * Register the inspect tool when the profile provides a tool registry.
 * @param ctx - Host context carrying `fs` and optionally `tools`.
 * @returns disposer, or a no-op when `tools` is unavailable.
 */
export function registerInspectTool(ctx: InspectContext): () => void {
  let dispose: (() => void) | undefined
  // The sandbox policy knows the session's workspace root, which the fs service
  // does not expose; without it a relative path resolves against the app cwd.
  let sandbox: SandboxPolicyLike | undefined
  ctx.inject?.(['sandboxPolicy'], (scope: never) => {
    sandbox = (scope as { sandboxPolicy?: SandboxPolicyLike }).sandboxPolicy
  })
  ctx.inject?.(['tools'], (scope: never) => {
    const toolsCtx = scope as unknown as {
      tools: ToolsLike
      effect(fn: () => void, label: string): unknown
    }
    toolsCtx.effect(() => {
      dispose = toolsCtx.tools.register({
        name: 'preview_inspect',
        description: 'Describe the structure of a file instead of reading its bytes: one summary line, '
          + 'a few facts, a schema (columns or tensors), warnings, and concrete next steps. '
          + 'Supports CSV/TSV, JSONL, ZIP/EPUB, TAR/TGZ, Office OOXML, EML, diff, 7z, '
          + 'SQLite, SafeTensors, GGUF, notebooks, reST, images, PDF, fonts, glTF/GLB '
          + 'and common media containers. '
          + 'For other previewable files it returns a preview-only capability envelope instead of an error.',
        parameters: PARAMETERS,
        output: {
          schema: OUTPUT_SCHEMA,
          render: (_args: unknown, value: InspectResult): unknown[] => [{
            type: 'text',
            text: [
              `${value.capability === undefined || value.capability === 'inspected' ? '' : `[${value.capability}] `}${value.summary}`,
              ...value.facts.map(line => `  ${line}`),
              ...value.schema.map(line => `  ${line}`),
              ...value.notes.map(line => `! ${line}`),
              ...value.next.map(line => `→ ${line}`),
            ].join('\n'),
          }],
        },
        async execute(args: { path?: string } | undefined, exec?: { agent?: { session?: unknown } }) {
          const path = args?.path
          if (typeof path !== 'string' || path === '') throw new Error('path is required')
          const marker = path.indexOf('!/')
          const archivePath = marker < 0 ? path : path.slice(0, marker)
          const entryName = marker < 0 ? undefined : path.slice(marker + 2)
          if (archivePath === '') throw new Error('archive path is required')
          if (entryName === '') throw new Error('entry name is required')
          const signal = AbortSignal.timeout(10_000)

          // Absolute paths go through the host-path mapping; a relative path is
          // resolved against the session workspace root the sandbox policy knows.
          let target: unknown
          if (isAbsolute(archivePath)) {
            const mapped = ctx.fs.processPathFromHostPath(archivePath)
            if (mapped === undefined) throw new Error('path is outside the workspace')
            target = await ctx.fs.resolve(mapped, { signal })
          } else {
            let cwd: string | undefined
            try {
              const policy = sandbox?.resolve(exec?.agent === undefined ? {} : { session: exec.agent.session })
              cwd = policy?.workspaceRoot ?? policy?.root
            } catch {
              // No policy: fall back to the service default.
            }
            target = await ctx.fs.resolve(archivePath, cwd === undefined ? { signal } : { cwd, signal })
          }

          const info = await ctx.fs.stat(target, signal)
          const size = info?.size ?? 0
          const read: Reader = async (offset, length) =>
            new Uint8Array(await ctx.fs.readByteRange(target, { offset, length }, signal))

          if (entryName !== undefined) {
            return await inspectArchiveEntry(archivePath, entryName, size, read)
          }

          const suffix = extname(path).slice(1).toLowerCase()

          if (suffix === 'csv' || suffix === 'tsv' || suffix === 'tab') {
            const length = Math.min(size, TEXT_BYTES)
            const head = new Uint8Array(await ctx.fs.readByteRange(target, { offset: 0, length }, signal))
            // Windows spread across the file: a 150 MB table's first megabyte cannot say
            // how many rows there are, how uniform they are, or whether the delimiter holds.
            const samples: Uint8Array[] = []
            if (size > length) {
              const at = SAMPLE_POINTS.map(point => Math.floor(size * point))
              for (const offset of at) {
                if (offset <= 0 || offset >= size) continue
                const window = Math.min(SAMPLE_BYTES, size - offset)
                samples.push(new Uint8Array(await ctx.fs.readByteRange(target, { offset, length: window }, signal)))
              }
            }
            const tailLength = size > length ? Math.min(TAIL_BYTES, size) : 0
            const tail = tailLength === 0
              ? new Uint8Array()
              : new Uint8Array(await ctx.fs.readByteRange(target, { offset: size - tailLength, length: tailLength }, signal))
            return inspected(inspectCsv({ head, size, samples, tail }))
          }

          const lowerName = path.replaceAll('\\', '/').toLowerCase()
          if (suffix === 'tar' || suffix === 'tgz' || lowerName.endsWith('.tar.gz')) {
            return inspected(await inspectTar(size, read))
          }

          if (suffix === 'docx' || suffix === 'xlsx' || suffix === 'pptx') {
            return inspected(await inspectOffice(size, read))
          }

          if (suffix === 'doc' || suffix === 'xls' || suffix === 'ppt') {
            return previewOnlyResult('office', size, suffix)
          }

          if (suffix === 'eml') {
            const length = Math.min(size, TEXT_BYTES)
            return inspected(inspectEml(new Uint8Array(await read(0, length)), size > TEXT_BYTES))
          }

          const imageSuffixes = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
          if (imageSuffixes.includes(suffix)) {
            return inspected(inspectImage(new Uint8Array(await read(0, Math.min(size, 64 * 1024))), size))
          }

          if (suffix === 'pdf') {
            return inspected(inspectPdf(new Uint8Array(await read(0, Math.min(size, 1024))), size))
          }

          if (suffix === 'ttf' || suffix === 'otf' || suffix === 'woff' || suffix === 'woff2') {
            return inspected(inspectFont(new Uint8Array(await read(0, Math.min(size, 128 * 1024))), size))
          }

          if (suffix === 'gltf' || suffix === 'glb') {
            return inspected(inspectModel(new Uint8Array(await read(0, Math.min(size, HEAD_BYTES))), size))
          }

          if (suffix === 'diff' || suffix === 'patch') {
            const length = Math.min(size, TEXT_BYTES)
            return inspected(inspectDiff(new Uint8Array(await read(0, length)), size > TEXT_BYTES))
          }

          const mediaFamily = PREVIEW_FAMILIES[suffix]
          if (mediaFamily === 'video' || mediaFamily === 'audio') {
            try {
              return inspected(inspectMedia(new Uint8Array(await read(0, Math.min(size, 64 * 1024))), size))
            } catch {
              return previewOnlyResult(mediaFamily, size, suffix)
            }
          }

          if (suffix === 'jsonl' || suffix === 'ndjson') {
            const length = Math.min(size, TEXT_BYTES)
            return inspected(inspectJsonl(new Uint8Array(await read(0, length)), size > TEXT_BYTES))
          }

          if (suffix === 'zip') return inspected(await inspectZip(size, read))

          if (suffix === 'sqlite' || suffix === 'sqlite3' || suffix === 'db' || suffix === 'db3') {
            return inspected(await inspectSqlite(read))
          }

          if (suffix === '7z') return inspected(await inspectSevenZip(read))

          if (suffix === 'safetensors') return inspected(await inspectSafetensors(size, read))

          if (suffix === 'ipynb') {
            const length = Math.min(size, HEAD_BYTES)
            return inspected(inspectNotebook(new Uint8Array(await read(0, length))))
          }

          if (suffix === 'rst') {
            const length = Math.min(size, TEXT_BYTES)
            return inspected(inspectRst(new Uint8Array(await read(0, length)), size > TEXT_BYTES))
          }

          if (suffix === 'epub') return inspected(await inspectEpub(size, read))

          if (suffix === 'gguf') {
            const length = Math.min(size, HEAD_BYTES)
            const head = await ctx.fs.readByteRange(target, { offset: 0, length }, signal)
            const bytes = new Uint8Array(head)
            if (!looksLikeGguf(bytes)) throw new Error('not a GGUF file (magic mismatch)')
            return inspected(inspectGguf(bytes))
          }

          // Extension preview families are a successful, preview-only answer. The
          // file is usable through the sidebar; only structural inspection is absent.
          const family = previewFamily(path)
          if (family !== undefined) {
            const format = path.replaceAll('\\', '/').toLowerCase().endsWith('.tar.gz') ? 'tar.gz' : suffix
            return previewOnlyResult(family, size, format)
          }

          // Unknown or renamed file: a small magic probe can still recover a real
          // inspector, or at least name the preview family.
          const head = size === 0
            ? new Uint8Array()
            : new Uint8Array(await read(0, Math.min(size, 1024)))
          const detected = sniffFormat(head)
          if (detected === 'zip') return inspected(await inspectZip(size, read))
          if (detected === '7z') return inspected(await inspectSevenZip(read))
          if (detected === 'sqlite') return inspected(await inspectSqlite(read))
          if (detected === 'tar') return inspected(await inspectTar(size, read))
          if (detected === 'png' || detected === 'jpeg' || detected === 'gif' || detected === 'webp') {
            return inspected(inspectImage(new Uint8Array(await read(0, Math.min(size, 64 * 1024))), size))
          }
          if (detected === 'pdf') {
            return inspected(inspectPdf(new Uint8Array(await read(0, Math.min(size, 1024))), size))
          }
          if (detected === 'glb') {
            return inspected(inspectModel(new Uint8Array(await read(0, Math.min(size, HEAD_BYTES))), size))
          }
          if (detected === 'video' || detected === 'audio') {
            try {
              return inspected(inspectMedia(new Uint8Array(await read(0, Math.min(size, 64 * 1024))), size))
            } catch {
              return previewOnlyResult(detected === 'video' ? 'video' : 'audio', size)
            }
          }
          if (detected === 'gguf') {
            const bytes = new Uint8Array(await read(0, Math.min(size, HEAD_BYTES)))
            return inspected(inspectGguf(bytes))
          }
          const magicFamily = detected === undefined ? undefined : magicPreviewFamily(detected)
          if (magicFamily !== undefined) return previewOnlyResult(magicFamily, size, detected, detected)
          return unknownResult(size, suffix, detected)
        },
      })
    }, 'any-preview: preview_inspect tool')
  })
  return () => { dispose?.() }
}

// Exported for tests: pure, no fs involved.
export {
  inferType, inspectCsv, inspectGguf, inspectJsonl, inspectZip, inspectSqlite,
  inspectSafetensors, inspectRst, inspectNotebook, inspectEpub, inspectSevenZip,
}
