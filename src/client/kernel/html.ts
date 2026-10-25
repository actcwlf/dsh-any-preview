/**
 * Sanitizing for HTML that arrives inside a document (notebook outputs, EPUB
 * chapters). The goal is to keep tables and basic formatting while removing
 * anything executable.
 */

/** Elements dropped with their contents. */
const DROP_BLOCK = /<(script|style|iframe|object|embed|template|noscript)\b[\s\S]*?<\/\1>/giu
/** Elements dropped as empty tags. */
const DROP_TAG = /<\/?(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select)\b[^>]*>/giu

/**
 * Remove executable or page-level markup from a fragment.
 * @param html - untrusted fragment.
 * @returns a fragment safe to inject into a styled container.
 */
export function sanitizeHtml(html: string): string {
  let output = html.replace(DROP_BLOCK, '').replace(DROP_TAG, '')
  // Inline event handlers and javascript: URLs are the two remaining ways to run.
  output = output.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, '')
  output = output.replace(/\s(href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/giu, '')
  return output
}
