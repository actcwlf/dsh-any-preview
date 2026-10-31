/** CRC32 (IEEE), the checksum 7z writes into its signature header. */

const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** CRC32 of a byte range. */
export function crc32(bytes: Uint8Array): number {
  let value = 0xFFFFFFFF
  for (const byte of bytes) {
    value = (TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  }
  return (value ^ 0xFFFFFFFF) >>> 0
}
