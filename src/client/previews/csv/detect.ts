/** Pick the delimiter that appears most often on the first line. */

const CANDIDATES = [',', '\t', ';', '|'] as const

/**
 * Choose a delimiter from the first line of the text prefix.
 * @param text - accumulated text.
 * @returns the best candidate, defaulting to a comma.
 */
export function detectDelimiter(text: string): string {
  const head = text.slice(0, 8192).split(/\r?\n/u)[0] ?? ''
  let best = ','
  let bestCount = 0
  for (const candidate of CANDIDATES) {
    const count = head.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/** Human label for the delimiter shown in the info bar. */
export const DELIMITER_LABEL: Record<string, string> = {
  ',': '逗号',
  '\t': '制表符',
  ';': '分号',
  '|': '竖线',
}
