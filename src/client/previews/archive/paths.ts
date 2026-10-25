/**
 * Pure path arithmetic for archive extraction.
 *
 * Kept out of the body component so it can be tested without rendering: these
 * two functions decide where a member is written and whether that location can
 * be opened by the standard preview at all.
 */

/** Folder the viewer extracts into, relative to the archive. */
export const EXTRACTION_DIR = '.dsh-any-preview'

/**
 * Default extraction directory: a hidden folder beside the archive.
 * @param archivePath - absolute path of the archive.
 * @returns that folder's path, sharing the archive's separators.
 */
export function defaultTargetDir(archivePath: string): string {
  const normalized = archivePath.replaceAll('\\', '/')
  const cut = normalized.lastIndexOf('/')
  return `${cut < 0 ? '.' : normalized.slice(0, cut)}/${EXTRACTION_DIR}`
}

/**
 * Address of an extracted member, when the archive is a session file and the
 * member landed in the default directory beside it. Anything else cannot be
 * referenced by the file resource.
 * @param resourceAddress - address of the archive itself.
 * @param entryName - member name as stored in the archive.
 * @param targetDir - directory the member was written to.
 * @param expectedDir - the default directory for this archive.
 * @returns the extracted file's address, or undefined when it is not addressable.
 */
export function extractedAddress(
  resourceAddress: string,
  entryName: string,
  targetDir: string,
  expectedDir: string,
): string | undefined {
  const prefix = 'dsh-resource://file/session/'
  if (!resourceAddress.startsWith(prefix)) return undefined
  if (targetDir.replaceAll('\\', '/') !== expectedDir) return undefined
  const segments = resourceAddress.slice(prefix.length).split('/')
  const sessionId = segments[0]
  if (sessionId === undefined || sessionId === '') return undefined
  const relative = segments.slice(1).map(decodeURIComponent).join('/')
  const cut = relative.lastIndexOf('/')
  const directory = cut < 0 ? '' : relative.slice(0, cut)
  const name = entryName.replaceAll('\\', '/').split('/').pop() ?? entryName
  const encodedDir = directory === '' ? '' : `${directory.split('/').map(encodeURIComponent).join('/')}/`
  return `${prefix}${sessionId}/${encodedDir}${EXTRACTION_DIR}/${encodeURIComponent(name)}`
}
