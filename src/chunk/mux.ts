/**
 * The lazy MPEG-TS chunk.
 *
 * `.ts` / `.m2ts` files carry H.264/AAC inside a container Chromium cannot
 * demux. mux.js remuxes the packets into fragmented MP4 — no decoding, no
 * transcoding — and MediaSource plays the result.
 *
 * Loaded on demand through the loopback asset route so a reader who never opens
 * a transport stream does not pay for it at startup.
 */
import muxjs from 'mux.js'

/** The slice of mux.js this preview uses. */
export interface Mp4Transmuxer {
  push(bytes: Uint8Array): void
  flush(): void
  on(event: 'data', handler: (segment: { initSegment?: Uint8Array, data: Uint8Array }) => void): void
  off?(event: 'data', handler: (segment: { initSegment?: Uint8Array, data: Uint8Array }) => void): void
}

/** Everything the transport-stream player needs. */
export interface MuxBundle {
  readonly Transmuxer: new () => Mp4Transmuxer
}

export const Transmuxer = muxjs.mp4.Transmuxer
