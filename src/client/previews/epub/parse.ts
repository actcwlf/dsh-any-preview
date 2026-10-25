/**
 * EPUB reader helpers: locate the package document, read its spine, and turn a
 * chapter's XHTML into the markdown subset the shared block renderer consumes.
 *
 * EPUB is a zip, so the container work reuses the archive readers.
 */

/** One manifest item, resolved to a zip entry name. */
export interface EpubItem {
  readonly id: string
  readonly href: string
  readonly mediaType: string
}

/** What the viewer needs from the package document. */
export interface EpubPackage {
  readonly title?: string
  readonly spine: readonly string[]
  /** EPUB 3 navigation document, when the book declares one. */
  readonly nav?: string
  /** EPUB 2 NCX table of contents, when present. */
  readonly ncx?: string
  /** Linked stylesheets, in manifest order. */
  readonly stylesheets: readonly string[]
}

/** Directories and links that never carry reading content. */
const SKIP = /\.(css|js|ncx|opf|xml)$/iu

/**
 * Read the package document path out of `META-INF/container.xml`.
 * @param xml - container document.
 * @returns the OPF path, or undefined when the file is not an EPUB.
 */
export function containerOpfPath(xml: string): string | undefined {
  const match = /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/iu.exec(xml)
  if (match === null) return undefined
  return match[1]!.trim()
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    result[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? ''
  }
  return result
}

/**
 * Resolve a manifest href against the package document's directory.
 * @param baseDir - directory of the OPF inside the zip, without a trailing slash.
 * @param href - href as written in the manifest.
 * @returns a normalized zip entry name.
 */
export function resolveHref(baseDir: string, href: string): string {
  let target = href
  try {
    target = decodeURIComponent(href)
  } catch {
    // A malformed escape sequence is not worth failing the whole book for.
  }
  const cleaned = target.split('#')[0]!.split('?')[0]!.trim()
  if (cleaned === '') return ''
  const segments = cleaned.startsWith('/')
    ? cleaned.slice(1).split('/')
    : [...baseDir.split('/').filter(part => part !== ''), ...cleaned.split('/')]
  const stack: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  return stack.join('/')
}

/**
 * Parse an OPF package document.
 * @param xml - package document text.
 * @param opfPath - its zip entry name, used to resolve relative hrefs.
 * @returns the title and the spine's chapter entry names, in reading order.
 */
export function parseOpf(xml: string, opfPath: string): EpubPackage {
  const cut = opfPath.lastIndexOf('/')
  const baseDir = cut < 0 ? '' : opfPath.slice(0, cut)
  const titleMatch = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/iu.exec(xml)
  const title = titleMatch === null ? undefined : decodeEntities(titleMatch[1]!).replace(/\s+/gu, ' ').trim()

  const byId = new Map<string, EpubItem>()
  const stylesheets: string[] = []
  let nav: string | undefined
  let ncx: string | undefined
  for (const match of xml.matchAll(/<item\b([^>]*?)\/?>/giu)) {
    const attrs = attributes(match[1]!)
    const id = attrs.id
    const href = attrs.href
    if (id === undefined || href === undefined) continue
    const resolved = resolveHref(baseDir, href)
    if (resolved === '') continue
    const item: EpubItem = { id, href: resolved, mediaType: attrs['media-type'] ?? '' }
    byId.set(id, item)
    if (item.mediaType === 'text/css') stylesheets.push(resolved)
    if ((attrs.properties ?? '').split(/\s+/u).includes('nav')) nav = resolved
    if (item.mediaType === 'application/x-dtbncx+xml' || resolved.toLowerCase().endsWith('.ncx')) ncx = resolved
  }

  const spine: string[] = []
  for (const match of xml.matchAll(/<itemref\b([^>]*?)\/?>/giu)) {
    const attrs = attributes(match[1]!)
    const idref = attrs.idref
    if (idref === undefined) continue
    const item = byId.get(idref)
    if (item === undefined || SKIP.test(item.href)) continue
    spine.push(item.href)
  }

  return {
    ...(title === undefined || title === '' ? {} : { title }),
    spine,
    ...(nav === undefined ? {} : { nav }),
    ...(ncx === undefined ? {} : { ncx }),
    stylesheets,
  }
}

/**
 * Decode the common XML entities.
 * @param text - escaped text.
 * @returns unescaped text.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_whole, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_whole, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/**
 * Convert chapter XHTML into markdown-ish text for the shared block parser.
 * @param html - one XHTML document.
 * @param resolveImage - maps an image `src` to a data URI (undefined drops it).
 * @returns text with headings, lists, quotes, images and code fences.
 */
export function htmlToMarkdownText(html: string, resolveImage?: (src: string) => string | undefined): string {
  let text = html
    .replace(/<\?xml[\s\S]*?\?>/giu, '')
    .replace(/<!DOCTYPE[\s\S]*?>/giu, '')
    .replace(/<head\b[\s\S]*?<\/head>/giu, '')
    .replace(/<script\b[\s\S]*?<\/script>/giu, '')
    .replace(/<style\b[\s\S]*?<\/style>/giu, '')

  text = text.replace(/<img\b([^>]*?)\/?>/giu, (_whole, attrs: string) => {
    const src = /src\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(attrs)
    const alt = /alt\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(attrs)
    const source = src?.[1] ?? src?.[2] ?? ''
    if (source === '') return ''
    const resolved = resolveImage?.(source)
    if (resolved === undefined) return ''
    return `\n\n![${decodeEntities(alt?.[1] ?? alt?.[2] ?? '')}](${resolved})\n\n`
  })

  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_whole, level: string, inner: string) =>
    `\n\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()}\n\n`)
  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/giu, (_whole, inner: string) =>
    `\n\n${inner.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim().split(/(?<=\.)\s+/u).join('\n> ')}\n\n`)
  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/giu, (_whole, inner: string) =>
    `\n\n\`\`\`\n${decodeEntities(inner.replace(/<[^>]+>/gu, ''))}\n\`\`\`\n\n`)
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/giu, (_whole, inner: string) =>
    `\n- ${inner.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()}`)
  text = text
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|section|article|li|ul|ol|table|tr|h[1-6])>/giu, '\n\n')
    .replace(/<[^>]+>/gu, '')

  return decodeEntities(text)
    .split('\n')
    .map(line => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** One table-of-contents entry. */
export interface TocEntry {
  readonly title: string
  /** Chapter entry name inside the zip, fragment removed. */
  readonly href: string
}

/**
 * Read an EPUB 3 navigation document.
 * @param html - nav.xhtml text.
 * @param baseDir - directory of the nav document inside the zip.
 * @returns entries in document order.
 */
export function parseNav(html: string, baseDir: string): TocEntry[] {
  const entries: TocEntry[] = []
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/giu)) {
    const href = (match[1] ?? match[2] ?? '').trim()
    if (href === '') continue
    const title = decodeEntities(match[3]!.replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim()
    const resolved = resolveHref(baseDir, href)
    if (resolved === '') continue
    entries.push({ title: title === '' ? resolved : title, href: resolved })
  }
  return entries
}

/**
 * Read an EPUB 2 NCX table of contents.
 * @param xml - toc.ncx text.
 * @param baseDir - directory of the NCX inside the zip.
 * @returns entries in document order.
 */
export function parseNcx(xml: string, baseDir: string): TocEntry[] {
  const entries: TocEntry[] = []
  for (const match of xml.matchAll(/<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')[\s\S]*?<\/navPoint>/giu)) {
    const title = decodeEntities(match[1]!.replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim()
    const href = (match[2] ?? match[3] ?? '').trim()
    const resolved = resolveHref(baseDir, href)
    if (resolved === '') continue
    entries.push({ title: title === '' ? resolved : title, href: resolved })
  }
  return entries
}

/** Image suffixes the pane can render from a data URI. */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp',
}

/**
 * MIME type for an image entry, by suffix.
 * @param name - zip entry name.
 * @returns the MIME type, or undefined when the file is not a supported image.
 */
export function imageMimeType(name: string): string | undefined {
  const suffix = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return IMAGE_MIME[suffix]
}

/** Properties safe to copy from a book's stylesheet. */
const SAFE_PROPERTY = /^(font-(size|weight|style|family)|margin(-[a-z]+)?|padding(-[a-z]+)?|text-align|line-height|color|background-color|font-variant|letter-spacing|text-indent)$/u

/**
 * Scope a book stylesheet to the viewer container, keeping only element
 * selectors and a safe property whitelist. Anything else is dropped: a book's
 * CSS must never reach the application's own elements.
 * @param css - stylesheet text.
 * @param scope - container class, without the leading dot.
 * @returns scoped CSS text (possibly empty).
 */
export function scopeCss(css: string, scope: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, '')
  const rules: string[] = []
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = match[1]!
      .split(',')
      .map(part => part.trim())
      .filter(part => /^[a-z][\w-]*$/iu.test(part))
    if (selectors.length === 0) continue
    const declarations = match[2]!
      .split(';')
      .map(part => part.trim())
      .filter(part => part !== '')
      .filter((part) => {
        const colon = part.indexOf(':')
        if (colon <= 0) return false
        const property = part.slice(0, colon).trim().toLowerCase()
        const value = part.slice(colon + 1).trim()
        return SAFE_PROPERTY.test(property) && !/url\s*\(|expression|javascript:/iu.test(value)
      })
    if (declarations.length === 0) continue
    rules.push(`${selectors.map(selector => `.${scope} ${selector}`).join(',')}{${declarations.join(';')}}`)
  }
  return rules.join('\n')
}
