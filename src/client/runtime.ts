/**
 * Handles the plugin borrows from the surrounding app at activation time.
 *
 * Both are optional: a profile without the right sidebar or without a
 * directory-picker backend still renders every preview, it only loses the
 * "open this elsewhere" and "choose a directory" affordances.
 */

type OpenResource = (address: string) => void
type PickDirectory = (signal: AbortSignal) => Promise<string | null>

let openResource: OpenResource | undefined
let pickDirectory: PickDirectory | undefined

/** @param next - called with a resource address to reveal it in the sidebar. */
export function setOpenResource(next: OpenResource): void {
  openResource = next
}

/** @param next - opens the Host's directory chooser; resolves null on cancel. */
export function setDirectoryPicker(next: PickDirectory): void {
  pickDirectory = next
}

/**
 * Reveal a resource address in the right sidebar.
 * @param address - `dsh-resource://` address.
 * @returns whether a sidebar was available to open it.
 */
export function openResourceAddress(address: string): boolean {
  if (openResource === undefined) return false
  openResource(address)
  return true
}

/**
 * Ask the Host for a directory.
 * @param signal - caller lifetime.
 * @returns the chosen path, or undefined when no picker is available.
 */
export async function chooseDirectory(signal: AbortSignal): Promise<string | undefined> {
  if (pickDirectory === undefined) return undefined
  const chosen = await pickDirectory(signal)
  return chosen ?? undefined
}

/** Whether the sidebar navigation handle is available. */
export function canOpenResources(): boolean {
  return openResource !== undefined
}
