/**
 * The two little state machines behind the table, as pure reducers.
 *
 * Keeping them here means the transitions can be tested without a DOM: when the file
 * source becomes ready or fails, and what a scan reports while it runs, is exactly the
 * logic that used to be spread over five `setState` calls in two effects.
 */
import { isHeaderRow, toBodyRow } from '../../kernel/row-numbering.ts'

/** Where the file-backed source stands. `failed` means the text path keeps the table. */
export type FileStatus = 'idle' | 'opening' | 'ready' | 'failed'

/** What the table knows about the file source. */
export interface FileState {
  readonly status: FileStatus
  /** Best-known rows, header included. */
  readonly total: number
  /** Fraction of the file walked so far, 0..1. */
  readonly progress: number
  /** True once the walk reached the end. */
  readonly complete: boolean
}

/** No file source: the delivered text is all there is. */
export const IDLE_FILE: FileState = { status: 'idle', total: 0, progress: 0, complete: false }
/** The size probe is running. */
export const OPENING_FILE: FileState = { status: 'opening', total: 0, progress: 0, complete: false }
/** No route, no permission, or a small file: the text path keeps the table. */
export const FAILED_FILE: FileState = { status: 'failed', total: 0, progress: 0, complete: false }

/** One step of the file source's life. */
export type FileEvent =
  | { readonly type: 'open' }
  | { readonly type: 'ready', readonly total: number, readonly progress: number, readonly complete: boolean }
  | { readonly type: 'fail' }

/**
 * Advance the file source.
 * @param state - current state.
 * @param event - what just happened.
 */
export function fileState(state: FileState, event: FileEvent): FileState {
  switch (event.type) {
    case 'open':
      return OPENING_FILE
    case 'ready':
      // A slice that lands after a failure keeps the table on the text path: the file
      // source is gone, and resurrecting it would fight the fallback.
      if (state.status === 'failed') return state
      return { status: 'ready', total: event.total, progress: event.progress, complete: event.complete }
    case 'fail':
      return FAILED_FILE
  }
}

/** No match rows yet; a stable identity so a scan effect does not churn. */
export const NO_ROWS: readonly number[] = []

/** What a whole-file scan has found so far. */
export interface ScanState {
  /** The query this scan belongs to; hits for an older one are dropped. */
  readonly query: string
  /** 0..1 of the file looked at. */
  readonly progress: number
  /** Matches seen so far, which may be more than {@link ScanState.rows}. */
  readonly matches: number
  /** Body rows of the first matches, in the order the scan met them. */
  readonly rows: readonly number[]
  /** True when the scan reached the last slice or was stopped. */
  readonly done: boolean
  /** True when the reader stopped it. */
  readonly aborted: boolean
}

/** One step of a scan. */
export type ScanEvent =
  | { readonly type: 'clear' }
  | { readonly type: 'start', readonly query: string }
  | { readonly type: 'slice', readonly progress: number, readonly matches: number, readonly lines: readonly number[] }
  | { readonly type: 'done', readonly matches: number, readonly lines: readonly number[] }
  | { readonly type: 'stop' }

/**
 * Turn the lines a scan found into body rows: line 0 is the header, so a hit there has
 * no row to jump to and is dropped.
 * @param lines - zero-based file lines of the matches.
 */
export function linesToRows(lines: readonly number[]): number[] {
  const rows: number[] = []
  for (const line of lines) if (!isHeaderRow(line)) rows.push(toBodyRow(line))
  return rows
}

/**
 * Advance a scan, or drop it.
 * @param state - current scan, or undefined before the first one.
 * @param event - what just happened.
 */
export function scanState(state: ScanState | undefined, event: ScanEvent): ScanState | undefined {
  switch (event.type) {
    case 'clear':
      return undefined
    case 'start':
      return { query: event.query, progress: 0, matches: 0, rows: NO_ROWS, done: false, aborted: false }
    case 'slice':
      if (state === undefined) return state
      return { ...state, progress: event.progress, matches: event.matches, rows: linesToRows(event.lines) }
    case 'done':
      if (state === undefined) return state
      return { ...state, progress: 1, matches: event.matches, rows: linesToRows(event.lines), done: true }
    case 'stop':
      // Stopping keeps what it found: the rows stay reachable, only the run ends.
      if (state === undefined) return state
      return { ...state, done: true, aborted: true }
  }
}
