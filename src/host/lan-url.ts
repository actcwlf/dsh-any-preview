/**
 * Signed, session-scoped URLs for the loopback media route.
 *
 * The page lives on `dsh-app://app`, so a media request to `http://127.0.0.1`
 * is cross-site and carries no session cookie — `/api` answers 401. The URL
 * therefore carries its own credential.
 *
 * There is deliberately **no expiry**: a `<video>` keeps issuing Range requests
 * for as long as it plays, so any time-based token would cut a long video (or a
 * long pause followed by a seek) off mid-stream. Instead the signature binds one
 * path to a secret that lives only as long as the process: a restart invalidates
 * every URL, and one URL can only ever read the file it names.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Fresh per-process secret; a restart invalidates every minted URL. */
export function createLanSecret(): Uint8Array {
  return randomBytes(32)
}

/**
 * Sign one path.
 * @param secret - per-process secret.
 * @param path - the exact file path the URL may serve.
 * @returns base64url signature.
 */
export function signLanPath(secret: Uint8Array, path: string): string {
  return createHmac('sha256', secret).update(path).digest('base64url')
}

/**
 * Verify that a signature was minted for this exact path.
 * @param secret - per-process secret.
 * @param path - path from the request.
 * @param signature - signature from the request.
 * @returns whether the URL may serve that path.
 */
export function verifyLanPath(secret: Uint8Array, path: string, signature: string): boolean {
  if (signature === '' || path === '') return false
  const expected = Buffer.from(signLanPath(secret, path), 'utf8')
  const given = Buffer.from(signature, 'utf8')
  return expected.length === given.length && timingSafeEqual(expected, given)
}
