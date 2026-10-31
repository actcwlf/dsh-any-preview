/**
 * URLs for reading workspace files as bytes.
 *
 * One route serves every binary renderer: media streams it with `Range`, and
 * the model viewer fetches it whole. Both go through the Host's authenticated
 * `/api` fence, so no renderer needs its own route.
 */

/** Path of the Host route that serves file bytes. */
export const FILE_ROUTE = 'api/any-preview/media'

/** Path of the Host route that serves line-aligned text slices. */
export const TEXT_ROUTE = 'api/any-preview/text'

/**
 * Build an absolute URL on one of the file routes.
 * The URL stays document-relative: loopback, LAN, MagicDNS and the desktop
 * shell's `dsh-app://` origin all resolve it correctly.
 * @param route - route path without a leading slash.
 * @param path - absolute path reported by the file resource.
 * @returns the URL, or undefined when the page has no usable base URI.
 */
function routeUrl(route: string, path: string): string | undefined {
  try {
    return new URL(`${route}?path=${encodeURIComponent(path)}`, document.baseURI).href
  } catch {
    return undefined
  }
}

/**
 * Build an absolute URL for one file on the serving route.
 * @param path - absolute path reported by the file resource.
 * @param download - ask the Host for an attachment response.
 * @returns the URL, or undefined when the page has no usable base URI.
 */
export function fileUrl(path: string, download = false): string | undefined {
  if (!download) return routeUrl(FILE_ROUTE, path)
  try {
    return new URL(`${FILE_ROUTE}?path=${encodeURIComponent(path)}&download=1`, document.baseURI).href
  } catch {
    return undefined
  }
}

/**
 * Build the URL for line-aligned text slices of one file.
 * @param path - absolute path reported by the file resource.
 * @returns the URL, or undefined when the page has no usable base URI.
 */
export function textUrl(path: string): string | undefined {
  return routeUrl(TEXT_ROUTE, path)
}
