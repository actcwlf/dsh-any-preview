/**
 * A file read as byte slices, with a sparse row index built in the background.
 *
 * The document owner delivers text in order and keeps one contiguous prefix, so it
 * cannot answer "row 200,000". This source reads the file itself through the Host's
 * text route: a background pass walks the file once and remembers where its slices
 * start, and a window read begins at the nearest anchor — or, before the pass has
 * reached that far, at a byte offset estimated from the average row length. Rows
 * read that way are real; only their *numbers* are estimates, and the caller is told
 * which it got.
 *
 * Nothing here knows about delimiters: a slice is turned into rows by the `parse`
 * function the caller supplies, so a CSV splits cells and a log keeps one cell per line.
 */
import { countRows, skipLines } from './lines.ts'
import { textUrl } from './file-url.ts'
import { forEachMatch } from './search.ts'
import type { MatchRange, SearchOccurrence } from './search.ts'
import { rowsAt, rowsPerByte } from '../../shared/inspect/density.ts'
import type { DensityProbe } from '../../shared/inspect/density.ts'

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
export interface RowWindow {
  /** File row (header included) the first returned row claims to be. */
  readonly startRow: number
  readonly rows: string[][]
  /** True when {@link RowWindow.startRow} comes from the index, not an estimate. */
  readonly exact: boolean
  /** True when a row passed the line cap and parsing stopped there. */
  readonly overlong: boolean
}

/** Turns one line-aligned slice of text into rows. */
export type RowParse = (text: string) => { readonly rows: string[][], readonly overlong: boolean }

/** How to open a file source. */
export interface RowFileOptions {
  /** Slice text to rows: a delimiter split for a table, one cell per line otherwise. */
  readonly parse: RowParse
}

/** What a whole-file scan found. */
export interface FileScan {
  /** Total occurrences in the whole file. */
  readonly matches: number
  /** First occurrences for navigation, in file order. */
  readonly occurrences: readonly SearchOccurrence[]
}

/** What a whole-file line scan found; one result per matching line. */
export interface FileLineScan {
  /** Total matching lines in the whole file. */
  readonly matches: number
  /** First matching lines for navigation, in file order (0-based). */
  readonly lines: readonly number[]
}

/** A file-backed row source: byte windows in, rows out. */
export interface RowFile {
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
  read(startRow: number, count: number): Promise<RowWindow>
  /**
   * Search the whole file without blocking the page.
   *
   * Slices are line-aligned, so a match that stays inside a row is never split; a match
   * across rows is found in the row it starts in. Because the walk is in order it also
   * leaves an anchor per slice behind, which is what makes a jump to a match exact.
   *
   * The scan starts at `from` when an anchor reaches it and wraps around to cover the
   * rest, so a reader looking at row 1,500,000 gets a hit near them first while the
   * count still ends up whole. Each slice reports what it found, so the first hit can be
   * shown long before the last one.
   * @param pattern - compiled expression; global, so `lastIndex` advances.
   * @param options - abort signal, where to start, and per-slice reporting.
   */
  scan(pattern: RegExp, options: {
    readonly signal: AbortSignal
    /** File row to start at; the scan wraps around to cover everything before it. */
    readonly from?: number
    readonly lineLimit?: number
    readonly onSlice?: (fraction: number, matches: number, occurrences: readonly SearchOccurrence[]) => void
  }): Promise<FileScan>
  /**
   * Search the whole file for matching lines, one result per line.
   *
   * Unlike {@link RowFile.scan} this is used by line-oriented formats: the first line is
   * content, not a header, and a line is counted once no matter how often the pattern
   * occurs inside it.
   * @param pattern - compiled expression; global, so `lastIndex` advances.
   * @param options - abort signal, navigable-line limit and per-slice reporting.
   */
  scanLines(pattern: RegExp, options: {
    readonly signal: AbortSignal
    readonly lineLimit?: number
    /** Ignore blank lines; line-oriented JSONL skips them, log does not. */
    readonly skipEmpty?: boolean
    readonly onSlice?: (fraction: number, matches: number, lines: readonly number[]) => void
  }): Promise<FileLineScan>
  /** Forget everything read so far. */
  dispose(): void
}

/** One anchor: a row that starts at a byte offset. */
interface Anchor {
  readonly row: number
  readonly byte: number
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
 * Open a file-backed row source.
 * @param path - absolute path of the file.
 * @param options - how a slice becomes rows.
 * @param signal - caller lifetime; aborts every request made from here on.
 * @returns the source, after its first slice has been counted.
 */
export async function openRowFile(path: string, options: RowFileOptions, signal: AbortSignal): Promise<RowFile> {
  const url = textUrl(path)
  if (url === undefined) throw new Error('the page cannot address the workspace')
  const parse = options.parse

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
  // counted the rows itself. `preview_inspect` measures the same probes, with the same
  // shared arithmetic, so the two never quote different row counts for one file.
  const probes: DensityProbe[] = counted > 0 && scanned > 0 ? [{ rows: counted, bytes: scanned }] : []
  for (const point of SAMPLE_POINTS) {
    if (size <= 0) break
    const at = Math.floor(size * point)
    if (at <= 0 || at >= size) continue
    const sample = await fetchSlice(url, at, SAMPLE_BYTES, false, signal)
    const rows = countRows(sample.text, sample.eof)
    const bytes = sample.end - sample.start
    if (rows > 0 && bytes > 0) probes.push({ rows, bytes })
  }
  if (rowsPerByte(probes) > 0) {
    bytesPerRow = () => 1 / rowsPerByte(probes)
    totalRows = () => (complete ? counted : Math.max(counted + 1, rowsAt(size, probes)))
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
    async read(startRow: number, rowsWanted: number): Promise<RowWindow> {
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
            const parsed = parse(slice.text.slice(from, to))
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
      const parsed = parse(slice.text.slice(from, to))
      return { startRow, rows: parsed.rows.slice(0, count), exact: false, overlong: parsed.overlong }
    },
    async scan(pattern: RegExp, options: {
      readonly signal: AbortSignal
      readonly from?: number
      readonly lineLimit?: number
      readonly onSlice?: (fraction: number, matches: number, occurrences: readonly SearchOccurrence[]) => void
    }): Promise<FileScan> {
      const limit = options.lineLimit ?? Number.POSITIVE_INFINITY
      const requested = Math.max(0, options.from ?? 0)
      // Only an anchor starts a walk: a guessed byte offset would misnumber every hit
      // after it, which is worse than starting at the top.
      const anchor = requested > 0 ? anchorBefore(requested) : undefined
      const start = anchor === undefined ? { byte: 0, line: 0 } : { byte: anchor.byte, line: anchor.row }
      const occurrences: SearchOccurrence[] = []
      let matches = 0
      let scanned = 0

      /**
       * Walk `[from, stop)`, parsing rows and counting cell occurrences.
       * @param from - byte offset to start at (a row boundary).
       * @param line - file row of that offset.
       * @param stop - byte offset to stop before.
       */
      const walk = async (from: number, line: number, stop: number): Promise<void> => {
        let offset = from
        while (offset < stop) {
          if (options.signal.aborted === true) return
          const slice = await fetchSlice(url, offset, Math.max(1, Math.min(SLICE_BYTES, stop - offset)), true, options.signal)
          if (slice.text.length === 0 || slice.end <= slice.start) return
          const previous = scanAnchors[scanAnchors.length - 1]
          if (previous === undefined || previous.byte !== slice.start) scanAnchors.push({ row: line, byte: slice.start })
          const parsed = parse(slice.text)
          for (let rowOffset = 0; rowOffset < parsed.rows.length; rowOffset += 1) {
            const fileRow = line + rowOffset
            if (fileRow !== 0) {
              const bodyRow = fileRow - 1
              const cells = parsed.rows[rowOffset] ?? []
              for (let cell = 0; cell < cells.length; cell += 1) {
                matches += forEachMatch(cells[cell] ?? '', pattern, (range: MatchRange) => {
                  if (occurrences.length < limit) {
                    occurrences.push({ row: bodyRow, cell, start: range.start, end: range.end })
                  }
                })
              }
            }
          }
          line += parsed.rows.length
          scanCounted = Math.max(scanCounted, line)
          scanned += slice.end - slice.start
          options.onSlice?.(Math.min(1, scanned / Math.max(1, size)), matches, occurrences.slice())
          if (slice.eof) return
          offset = slice.end
          // Yield so a search over a huge file never blocks input for long.
          await new Promise(resolve => { setTimeout(resolve, 0) })
        }
      }

      await walk(start.byte, start.line, size)
      // Finish the file when the walk began in the middle of it.
      if (start.byte > 0 && options.signal.aborted !== true) await walk(0, 0, start.byte)
      return { matches, occurrences }
    },
    async scanLines(pattern: RegExp, options: {
      readonly signal: AbortSignal
      readonly lineLimit?: number
      readonly skipEmpty?: boolean
      readonly onSlice?: (fraction: number, matches: number, lines: readonly number[]) => void
    }): Promise<FileLineScan> {
      const limit = options.lineLimit ?? Number.POSITIVE_INFINITY
      const lines: number[] = []
      let matches = 0
      let scanned = 0
      let line = 0

      while (scanned < size) {
        if (options.signal.aborted === true) break
        const slice = await fetchSlice(url, scanned, SLICE_BYTES, true, options.signal)
        if (slice.text.length === 0 || slice.end <= slice.start) break
        const previous = scanAnchors[scanAnchors.length - 1]
        if (previous === undefined || previous.byte !== slice.start) scanAnchors.push({ row: line, byte: slice.start })
        const parsed = parse(slice.text)
        for (let rowOffset = 0; rowOffset < parsed.rows.length; rowOffset += 1) {
          const cells = parsed.rows[rowOffset] ?? []
          let matched = false
          for (const cell of cells) {
            if (forEachMatch(cell, pattern, () => {}) > 0) {
              matched = true
              break
            }
          }
          if (matched) {
            const raw = cells[0] ?? ''
            if (options.skipEmpty === true && raw.trim() === '') continue
            matches += 1
            if (lines.length < limit) lines.push(line + rowOffset)
          }
        }
        line += parsed.rows.length
        scanCounted = Math.max(scanCounted, line)
        scanned = slice.end
        options.onSlice?.(Math.min(1, scanned / Math.max(1, size)), matches, lines.slice())
        if (slice.eof) break
        await new Promise(resolve => { setTimeout(resolve, 0) })
      }
      return { matches, lines }
    },
    dispose(): void {
      disposed = true
      anchors.length = 0
      scanAnchors.length = 0
      scanCounted = 0
    },
  }
}
