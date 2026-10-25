/**
 * Signed, expiring URLs for the loopback media route.
 *
 * The page lives on `dsh-app://app`, so a media request to `http://127.0.0.1`
 * is cross-site and carries no session cookie — `/api` answers 401. The URL
 * itself therefore has to be the credential: the authenticated `/api` route
 * mints it, and the loopback route only serves what the signature names.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** How long one minted URL stays valid. */
export const LAN_URL_TTL_MS = 5 * 60_000

/** Fresh per-process secret; a restart invalidates every minted URL. */
export function createLanSecret(): Uint8Array {
  return randomBytes(32)
}

function payloadOf(path: string, expiresAt: number): string {
  return `${path}\n${String(expiresAt)}`
}

/**
 * Sign one path for one expiry.
 * @param secret - per-process secret.
 * @param path - the exact file path the URL may serve.
 * @param expiresAt - epoch milliseconds.
 * @returns base64url signature.
 */
export function signLanPath(secret: Uint8Array, path: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(payloadOf(path, expiresAt)).digest('base64url')
}

/**
 * Verify a signature, its expiry and (implicitly) the path it covers.
 * @param secret - per-process secret.
 * @param path - path from the request.
 * @param expiresAt - expiry from the request.
 * @param signature - signature from the request.
 * @param now - clock, injectable for tests.
 * @returns whether the URL may serve that path.
 */
export function verifyLanPath(
  secret: Uint8Array,
  path: string,
  expiresAt: number,
  signature: string,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false
  if (signature === '') return false
  const expected = Buffer.from(signLanPath(secret, path, expiresAt), 'utf8')
  const given = Buffer.from(signature, 'utf8')
  return expected.length === given.length && timingSafeEqual(expected, given)
}
