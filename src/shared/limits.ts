/**
 * Every size, count and window the plugin refuses to exceed, in one place.
 *
 * They were scattered across thirteen files with no explanation of why a value
 * differed from its neighbour (why 100 MB for a model but 64 MB for a book?).
 * Keeping them together makes the trade-offs visible and gives a single point
 * to raise once the plugin exposes a config schema.
 */

/** One mebibyte in bytes. */
export const MB = 1024 * 1024

/** The caps. Names describe the reader, values the current trade-off. */
export const LIMITS = {
  /** Members listed from an archive before the table stops. */
  archiveEntries: 5_000,
  /** An archive read whole (tar, or a zip whose length is unknown). */
  archiveWhole: 64 * MB,
  /** One archive member expanded inline into the pane. */
  archiveEntry: 2 * MB,
  /** Desktop fallback that pulls a whole media file into a Blob to seek. */
  mediaBuffer: 64 * MB,
  /** A 3D scene loaded into the renderer. */
  modelBytes: 100 * MB,
  /** Triangles accepted after parsing (WebGL buffers are the real cost). */
  modelTriangles: 3_000_000,
  /** Declared image bytes accepted before decoding; decoded pixels can be several times larger. */
  modelTextureBytes: 64 * MB,
  /** A book read whole; EPUB is a zip, so the container must fit. */
  epubBook: 64 * MB,
  /** Chapters rendered from one book. */
  epubChapters: 200,
  /** Table rows the CSV viewer will virtualize. */
  csvRows: 20_000,
  /** Longest single CSV line kept; longer input stops parsing to avoid unbounded growth. */
  csvLineChars: 8 * 1024 * 1024,
  /** reST source characters parsed. */
  rstChars: 2 * MB,
  /** Notebook source characters parsed. */
  notebookChars: 8 * MB,
  /** Notebook cells rendered. */
  notebookCells: 1_000,
  /** SafeTensors header JSON, before it is refused as unreasonable. */
  safetensorsHeader: 16 * MB,
  /** Largest GGUF header window tried. */
  ggufWindow: 8 * MB,
  /** SQLite pages walked while reading the schema. */
  sqlitePages: 256,
  /** Schema objects listed from one database. */
  sqliteObjects: 500,
  /** Host-side archive read before extraction. */
  hostArchive: 256 * MB,
  /** Host-side member expanded and written to disk. */
  hostEntry: 128 * MB,
} as const
