/**
 * A CSV read as byte slices, with a sparse row index built in the background.
 *
 * The document owner delivers text in order and keeps one contiguous prefix, so it
 * cannot answer "row 200,000". This source reads the file itself through the Host's
 * text route: a background pass walks the file once and remembers where its slices
 * start, and a window read begins at the nearest anchor — or, before the pass has
 * reached that far, at a byte offset estimated from the average row length. Rows
 * read that way are real; only their *numbers* are estimates, and the caller is told
 * which it got.
 */
import { LIMITS } from '../../shared/limits.ts'
import { textUrl } from './file-url.ts'
import { createLineCounter } from './search-scan.ts'
import { createRowParser } from './text-pipeline.ts'

/** Bytes one background index slice covers. */
const SLICE_BYTES = 1024 * 1024

/** Largest window one request may ask for; the Host refuses more. */
const MAX_SLICE_BYTES = 4 * 1024 * 1024

/** Smallest window a viewport read asks for, so a jump still lands inside rows. */
const MIN_READ_BYTES = 64 * 1024

/** Bytes probed at spread positions to learn the file's average row length. */
const SAMPLE_BYTES = 32 * 1024

/** Where those probes are taken, as fractions of the file. */
const SAMPLE_POINTS = [1 / 3, 2 / 3, 5 / 6] as const

/** One line-aligned slice as the Host reports it. */
interface Slice {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly size: number
  readonly eof: boolean
}

/** What one window read produced. */
export interface FileWindow {
  /** File row (header included) the first returned row claims to be. */
  readonly startRow: number
  readonly rows: string[][]
  /** True when {@link FileWindow.startRow} comes from the index, not an estimate. */
  readonly exact: boolean
  /** True when a row passed the line cap and parsing stopped there. */
  readonly overlong: boolean
}

/** What a whole-file scan found. */
export interface FileScan {
  /** Matches in the whole file. */
  readonly matches: number
  /** Zero-based line of each collected match, in order (line 0 is the header). */
  readonly lines: readonly number[]
}

/** A file-backed CSV: byte windows in, rows out. */
export interface CsvFile {
  /** Bytes in the file. */
  readonly size: number
  /** Rows counted in the scanned prefix, header included. */
  readonly counted: number
  /** Bytes counted so far. */
  readonly scanned: number
  /** True once the whole file has been walked. */
  readonly complete: boolean
  /** Bumps whenever the index grows, so cached windows can be dropped. */
  readonly revision: number
  /** Best-known total rows: exact once complete, an estimate before. */
  totalRows(): number
  /** Count the next slice. Resolves false when there is nothing left to do. */
  advance(): Promise<boolean>
  /** Rows for one window; the caller may ask for any row. */
  read(startRow: number, count: number): Promise<FileWindow>
  /**
   * Search the whole file without blocking the page.
   *
   * Slices are line-aligned, so a match that stays inside a row is never split; a match
   * across rows is found in the row it starts in. Because the walk is in order it also
   * leaves an anchor per slice behind, which is what makes a jump to a match exact.
   * @param pattern - compiled expression; global, so `lastIndex` advances.
   * @param options - abort signal, progress callback, and how many match lines to keep.
   */
  scan(pattern: RegExp, options: {
    readonly signal: AbortSignal
    readonly onProgress?: (fraction: number) => void
    readonly lineLimit?: number
  }): Promise<FileScan>
  /** Forget everything read so far. */
  dispose(): void
}

/** One anchor: a row that starts at a byte offset. */
interface Anchor {
  readonly row: number
  readonly byte: number
}

/**
 * Count the rows a slice holds.
 * @param text - slice text, whole lines except at end of file.
 * @param eof - whether the slice reached the end of the file.
 */
export function countRows(text: string, eof: boolean): number {
  let rows = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) rows += 1
  // The last line of a file that does not end in a newline is still a row.
  return rows + (eof && text.length > 0 && !text.endsWith('\n') ? 1 : 0)
}

/**
 * Character offset just past the `rows`-th newline from `from`.
 * @param text - text to walk.
 * @param rows - lines to step over.
 * @param from - character to start at.
 * @returns the offset of the next line, or the end of the text.
 */
export function skipLines(text: string, rows: number, from = 0): number {
  let index = from
  for (let seen = 0; seen < rows; seen += 1) {
    const next = text.indexOf('\n', index)
    if (next === -1) return text.length
    index = next + 1
  }
  return index
}

/**
 * Parse slice text into rows.
 * @param text - whole lines, possibly with an open final line.
 * @param delimiter - field separator.
 */
function parseSlice(text: string, delimiter: string): { rows: string[][], overlong: boolean } {
  const rows: string[][] = []
  const parser = createRowParser(delimiter, cells => { rows.push([...cells]) }, LIMITS.csvLineChars)
  parser.push(text)
  parser.finish()
  return { rows, overlong: parser.overlong }
}

/**
 * Ask the Host for one slice.
 * @param url - text-route URL of the file.
 * @param offset - first byte.
 * @param length - bytes wanted.
 * @param rowStart - whether `offset` is known to begin a row.
 * @param signal - caller lifetime.
 */
async function fetchSlice(
  url: string,
  offset: number,
  length: number,
  rowStart: boolean,
  signal: AbortSignal,
): Promise<Slice> {
  const query = `&offset=${String(offset)}&length=${String(Math.min(length, MAX_SLICE_BYTES))}${rowStart ? '&rowStart=1' : ''}`
  const response = await fetch(`${url}${query}`, { signal })
  if (!response.ok) throw new Error(`text slice failed: ${String(response.status)}`)
  return await response.json() as Slice
}

/**
 * Open a file-backed CSV.
 * @param path - absolute path of the file.
 * @param delimiter - field separator.
 * @param signal - caller lifetime; aborts every request made from here on.
 * @returns the source, after its first slice has been counted.
 */
export async function openCsvFile(path: string, delimiter: string, signal: AbortSignal): Promise<CsvFile> {
  const url = textUrl(path)
  if (url === undefined) throw new Error('the page cannot address the workspace')

  let size = 0
  let counted = 0
  let scanned = 0
  let complete = false
  let revision = 0
  let disposed = false
  const anchors: Anchor[] = []
  /** Anchors left by a scan; the walk may not have reached them yet. */
  const scanAnchors: Anchor[] = []
  /** Rows a scan has counted so far, which is how far its anchors are trustworthy. */
  let scanCounted = 0

  /**
   * Count one slice and remember where it started.
   * @param slice - the slice just read.
   */
  const ingest = (slice: Slice): void => {
    size = slice.size
    if (slice.text.length > 0) anchors.push({ row: counted, byte: slice.start })
    counted += countRows(slice.text, slice.eof)
    scanned = slice.end
    complete = slice.eof || slice.end >= size
    revision += 1
  }

  /** Rows per byte: the whole-file average once sampled, the scanned prefix before. */
  let bytesPerRow = (): number => (counted > 0 && scanned > 0 ? scanned / counted : 1)

  /** The last anchor of one list at or before `row`. */
  const lastBefore = (list: readonly Anchor[], row: number): Anchor | undefined => {
    let found: Anchor | undefined
    for (const anchor of list) {
      if (anchor.row > row) break
      found = anchor
    }
    return found
  }

  /** The nearest anchor at or before `row`, from either the walk or a scan. */
  const anchorBefore = (row: number): Anchor | undefined => {
    const walked = row < counted ? lastBefore(anchors, row) : undefined
    const searched = row < scanCounted ? lastBefore(scanAnchors, row) : undefined
    if (walked === undefined) return searched
    if (searched === undefined) return walked
    return searched.row > walked.row ? searched : walked
  }

  /** Best-known total rows, header included. */
  let totalRows = (): number => {
    if (counted === 0) return 1
    if (complete) return counted
    // The prefix has a known density; the open last line is at least one more row.
    return Math.max(counted + 1, Math.round((counted * size) / Math.max(1, scanned)))
  }

  /** The end of the file is where a bottom-of-scroll read wants its rows. */
  const nearEnd = (startRow: number, rowsWanted: number): boolean => startRow + rowsWanted * 2 >= totalRows()

  const head = await fetchSlice(url, 0, SLICE_BYTES, true, signal)
  ingest(head)

  // A CSV's row length grows with its ids and notes, so the density of the first
  // megabyte misplaces a jump by several percent. Probe the rest of the file cheaply
  // and estimate from the average density instead; the index still wins where it has
  // counted the rows itself.
  const densities: number[] = counted > 0 && scanned > 0 ? [counted / scanned] : []
  for (const point of SAMPLE_POINTS) {
    if (size <= 0) break
    const at = Math.floor(size * point)
    if (at <= 0 || at >= size) continue
    const sample = await fetchSlice(url, at, SAMPLE_BYTES, false, signal)
    const rows = countRows(sample.text, sample.eof)
    const bytes = sample.end - sample.start
    if (rows > 0 && bytes > 0) densities.push(rows / bytes)
  }
  const density = densities.length === 0 ? 0 : densities.reduce((sum, value) => sum + value, 0) / densities.length
  if (density > 0) {
    bytesPerRow = () => 1 / density
    totalRows = () => (complete ? counted : Math.max(counted + 1, Math.round(size * density)))
  }

  return {
    get size(): number { return size },
    get counted(): number { return counted },
    get scanned(): number { return scanned },
    get complete(): boolean { return complete },
    get revision(): number { return revision },
    totalRows,
    async advance(): Promise<boolean> {
      if (disposed || complete) return false
      let slice = await fetchSlice(url, scanned, SLICE_BYTES, true, signal)
      if (slice.start !== scanned && slice.text.length > 0) {
        // The index assumed the scan was contiguous; it no longer is.
        throw new Error('the file changed while it was being indexed')
      }
      if (slice.text.length === 0 && !slice.eof) {
        // A row longer than the slice: take the largest window before giving up.
        slice = await fetchSlice(url, scanned, MAX_SLICE_BYTES, true, signal)
      }
      if (slice.end <= scanned || slice.text.length === 0) {
        // No progress is possible (one enormous row); stop claiming more rows.
        complete = true
        revision += 1
        return false
      }
      ingest(slice)
      return true
    },
    async read(startRow: number, rowsWanted: number): Promise<FileWindow> {
      const count = Math.max(1, rowsWanted)
      // An anchor means the row can be reached exactly: the walk's anchors cover the
      // counted prefix, a scan's anchors cover the whole file once it has been searched.
      const anchor = anchorBefore(startRow)
      if (anchor !== undefined) {
        const skip = startRow - anchor.row
        let length = Math.min(MAX_SLICE_BYTES, Math.max(MIN_READ_BYTES, Math.ceil((skip + count) * bytesPerRow() * 2)))
        for (;;) {
          const slice = await fetchSlice(url, anchor.byte, length, true, signal)
          const available = countRows(slice.text, slice.eof)
          if (available >= skip + count || slice.eof || length >= MAX_SLICE_BYTES) {
            const from = skipLines(slice.text, skip)
            const to = skipLines(slice.text, count, from)
            const parsed = parseSlice(slice.text.slice(from, to), delimiter)
            return { startRow, rows: parsed.rows.slice(0, count), exact: true, overlong: parsed.overlong }
          }
          length = Math.min(MAX_SLICE_BYTES, length * 2)
        }
      }
      // Past the scanned prefix: the row exists, its number is the caller's estimate.
      const length = Math.min(MAX_SLICE_BYTES, Math.max(MIN_READ_BYTES, Math.ceil(count * bytesPerRow() * 2)))
      const end = nearEnd(startRow, count)
      const guess = end
        ? Math.max(0, size - length)
        : Math.min(Math.round(startRow * bytesPerRow()), Math.max(0, size - length))
      const slice = await fetchSlice(url, guess, length, false, signal)
      const from = end ? skipLines(slice.text, Math.max(0, countRows(slice.text, slice.eof) - count)) : 0
      const to = skipLines(slice.text, count, from)
      const parsed = parseSlice(slice.text.slice(from, to), delimiter)
      return { startRow, rows: parsed.rows.slice(0, count), exact: false, overlong: parsed.overlong }
    },
    async scan(pattern: RegExp, options: {
      readonly signal: AbortSignal
      readonly onProgress?: (fraction: number) => void
      readonly lineLimit?: number
    }): Promise<FileScan> {
      const counter = createLineCounter(options.lineLimit)
      let matches = 0
      let line = 0
      let from = 0
      for (;;) {
        const slice = await fetchSlice(url, from, SLICE_BYTES, true, options.signal)
        if (slice.text.length > 0) {
          scanAnchors.push({ row: line, byte: slice.start })
          counter.nextSlice(line)
          pattern.lastIndex = 0
          for (;;) {
            const found = pattern.exec(slice.text)
            if (found === null) break
            matches += 1
            counter.record(slice.text, found.index)
            if (found[0].length === 0) pattern.lastIndex += 1
          }
          line += countRows(slice.text, false)
          scanCounted = line
        }
        options.onProgress?.(Math.min(1, slice.end / Math.max(1, slice.size)))
        if (slice.eof || slice.end <= slice.start) break
        from = slice.end
        // Yield so a search over a huge file never blocks input for long.
        await new Promise(resolve => { setTimeout(resolve, 0) })
      }
      options.onProgress?.(1)
      return { matches, lines: counter.lines }
    },
    dispose(): void {
      disposed = true
      anchors.length = 0
      scanAnchors.length = 0
      scanCounted = 0
    },
  }
}
