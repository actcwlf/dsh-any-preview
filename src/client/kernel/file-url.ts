/**
 * URLs for reading workspace files as bytes.
 *
 * One route serves every binary renderer: media streams it with `Range`, and
 * the model viewer fetches it whole. Both go through the Host's authenticated
 * `/api` fence, so no renderer needs its own route.
 */

/** Path of the Host route that serves file bytes. */
export const FILE_ROUTE = 'api/any-preview/media'

/**
 * Build an absolute URL for one file on the serving route.
 * The URL stays document-relative: loopback, LAN, MagicDNS and the desktop
 * shell's `dsh-app://` origin all resolve it correctly.
 * @param path - absolute path reported by the file resource.
 * @param download - ask the Host for an attachment response.
 * @returns the URL, or undefined when the page has no usable base URI.
 */
export function fileUrl(path: string, download = false): string | undefined {
  try {
    const suffix = download ? '&download=1' : ''
    return new URL(`${FILE_ROUTE}?path=${encodeURIComponent(path)}${suffix}`, document.baseURI).href
  } catch {
    return undefined
  }
}
