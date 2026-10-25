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
 *
 * A namespaced remote is only readable from a context that injected it by name,
 * so the sole way in is the deferred `remote.directoryPicker` injection; there
 * is deliberately no lazy fallback, which would throw "without inject".
 * @param signal - caller lifetime.
 * @returns the chosen path, undefined when the operator cancelled.
 * @throws when the environment offers no picker at all.
 */
export async function chooseDirectory(signal: AbortSignal): Promise<string | undefined> {
  if (pickDirectory === undefined) throw new Error('当前环境未提供目录选择器，请直接编辑路径')
  return (await pickDirectory(signal)) ?? undefined
}

/** Whether the sidebar navigation handle is available. */
export function canOpenResources(): boolean {
  return openResource !== undefined
}
