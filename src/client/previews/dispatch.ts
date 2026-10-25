/**
 * Extension discriminators.
 *
 * Renderer selection is path-only, so a preview that claims an extension gets
 * every file carrying it. Some extensions name two very different things
 * (`.obj` is both a Wavefront model and a COFF object file; `.ts` is both
 * TypeScript and MPEG-TS), and the cheap way to tell them apart is to look at
 * a few bytes.
 *
 * A discriminator is only attached where the ambiguity is real; unambiguous
 * extensions skip this layer entirely. The first kilobyte is enough for every
 * format handled here, so callers pass the head they already fetched.
 */

/** Reads a small head and says whether it belongs to the claimed format. */
export type Discriminator = (head: Uint8Array) => boolean

/** Text decoders tolerate a truncated multi-byte character at the end. */
function latin1(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

/**
 * MPEG-TS / M2TS: the sync byte 0x47 repeats every 188 bytes (192 with the
 * 4-byte M2TS prefix). Three matches are enough to rule out coincidence.
 * @param head - first kilobyte of the file.
 * @returns whether the bytes look like a transport stream.
 */
export function looksLikeTransportStream(head: Uint8Array): boolean {
  const atOffsets = (offsets: readonly number[]): boolean =>
    offsets.every((offset) => head[offset] === 0x47)
  return atOffsets([0, 188, 376]) || atOffsets([4, 196, 388])
}

/**
 * Wavefront OBJ is a text format whose statements start with `v`, `f`, `vt`,
 * `vn`, `o`, `g`, `s`, `mtllib` or `usemtl`. A COFF object file starts with a
 * machine word, so the first statement is almost never one of these.
 * @param head - first kilobyte of the file.
 * @returns whether the bytes look like a Wavefront model.
 */
export function looksLikeWavefront(head: Uint8Array): boolean {
  const text = latin1(head)
  if (text.includes('\u0000')) return false
  return /(?:^|[\r\n])\s*(?:v|vt|vn|f|o|g|s|mtllib|usemtl|vp)\s/u.test(text)
}

/** Discriminators by extension; only ambiguous extensions appear here. */
export const DISCRIMINATORS: Readonly<Record<string, Discriminator>> = {
  obj: looksLikeWavefront,
  ts: looksLikeTransportStream,
  m2ts: looksLikeTransportStream,
}

/**
 * Whether a file belongs to the format the extension claims.
 *
 * Extensions without a discriminator are trusted: the ambiguity is not real
 * there, and probing would only add a round trip.
 * @param extension - lowercase extension without the dot.
 * @param head - first bytes of the file, or undefined when not fetched.
 * @returns true when the caller should keep the preview, false when it should
 *   fall back, and true for extensions that need no check.
 */
export function claimsFile(extension: string, head: Uint8Array | undefined): boolean {
  const discriminate = DISCRIMINATORS[extension]
  if (discriminate === undefined) return true
  if (head === undefined) return true
  return discriminate(head)
}
