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
  for (const match of xml.matchAll(/<item\b([^>]*?)\/?>/giu)) {
    const attrs = attributes(match[1]!)
    const id = attrs.id
    const href = attrs.href
    if (id === undefined || href === undefined) continue
    const resolved = resolveHref(baseDir, href)
    if (resolved === '') continue
    byId.set(id, { id, href: resolved, mediaType: attrs['media-type'] ?? '' })
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

  return { ...(title === undefined || title === '' ? {} : { title }), spine }
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
 * @returns text with headings, lists, quotes and code fences.
 */
export function htmlToMarkdownText(html: string): string {
  let text = html
    .replace(/<\?xml[\s\S]*?\?>/giu, '')
    .replace(/<!DOCTYPE[\s\S]*?>/giu, '')
    .replace(/<head\b[\s\S]*?<\/head>/giu, '')
    .replace(/<script\b[\s\S]*?<\/script>/giu, '')
    .replace(/<style\b[\s\S]*?<\/style>/giu, '')

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
