/**
 * Path arithmetic for archive extraction, shared by the Host write route and the
 * client address builder.
 *
 * The extraction layout is deliberately nested:
 *
 *   <archive directory>/.dsh-any-preview/<archive name>/<entry relative path>
 *
 * Flattening an entry to its basename made two different archives (and two
 * directories inside one archive) write to the same file, so the archive name
 * and the member's relative path are both part of the destination.
 */

/** Folder the viewer extracts into, relative to the archive. */
export const EXTRACTION_DIR = '.dsh-any-preview'

/**
 * Sanitize one path segment while preserving a normal file name.
 * @param segment - one member path segment.
 * @returns a safe segment, or `_` when nothing remains.
 */
function safeSegment(segment: string): string {
  const cleaned = segment
    .replace(/[\0<>:"|?*]/gu, '_')
    .replace(/^\.+$/u, '_')
  return cleaned === '' ? '_' : cleaned
}

/**
 * Reduce a member path to a safe relative path.
 *
 * `..`, `.` and empty segments are dropped; the remaining segments are cleaned
 * and joined with `/`. The Host joins this path under `targetDir`, so no input
 * can escape that directory.
 * @param name - member name as stored in the archive.
 * @returns a safe relative path.
 */
export function safeEntryPath(name: string): string {
  const segments = name
    .replaceAll('\\', '/')
    .split('/')
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    .map(safeSegment)
  return segments.length === 0 ? 'entry' : segments.join('/')
}

/**
 * Last segment of {@link safeEntryPath}; kept for callers that need a display
 * name for one member.
 * @param name - member name.
 * @returns a safe basename.
 */
export function safeEntryName(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() ?? ''
  if (base === '') return 'entry'
  const cleaned = base
    .replace(/[\0<>:"|?*]/gu, '_')
    .replace(/^\.+$/u, '_')
  return cleaned === '' ? 'entry' : cleaned
}

/**
 * Folder name for one archive under `EXTRACTION_DIR`.
 * @param path - archive path.
 * @returns a safe archive filename, or `archive` when empty.
 */
export function safeArchiveName(path: string): string {
  const base = path.replaceAll('\\', '/').split('/').pop() ?? ''
  return safeSegment(base) === '_' ? 'archive' : safeSegment(base)
}
