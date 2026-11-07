/**
 * Scene colours for the model viewport.
 *
 * The host theme provides the default surface; the reader may pin a light or
 * dark backdrop. Grid and wireframe colours are chosen together with the
 * surface so a fixed backdrop stays readable even when the host theme differs.
 */
import type { ThreeBundle } from '../../../chunk/three.ts'

/** How the backdrop relates to the host theme. */
export type BackgroundMode = 'theme' | 'light' | 'dark'

/** Scene colours read from the host's theme tokens or a fixed palette. */
export interface SceneTheme {
  readonly background: any
  readonly gridMajor: any
  readonly gridMinor: any
  /** Wireframe lines: unlit, so they need a fixed contrast against the surface. */
  readonly wire: any
}

/**
 * Resolve one inherited CSS custom property through the host element.
 * @param host - element whose computed style carries the tokens.
 * @param property - custom property name, including `--`.
 * @param fallback - colour used when the token is absent.
 * @returns a CSS colour string.
 */
function resolveColor(host: HTMLElement, property: string, fallback: string): string {
  const view = host.ownerDocument.defaultView
  if (view === null) return fallback
  const probe = host.ownerDocument.createElement('span')
  probe.style.color = `var(${property}, ${fallback})`
  probe.style.display = 'none'
  host.appendChild(probe)
  const color = view.getComputedStyle(probe).color
  probe.remove()
  return color === '' ? fallback : color
}

/**
 * Read the viewport colours for the host's current theme.
 * @param THREE - three.js module.
 * @param host - element whose inherited tokens decide the surface.
 * @returns background and grid/wire colours.
 */
export function themeOf(THREE: ThreeBundle['THREE'], host: HTMLElement): SceneTheme {
  const background = new THREE.Color(resolveColor(host, '--dsw-alias-bg-base', '#101216'))
  // Colour components are linear here, so the threshold is on linear luminance.
  const luminance = background.r * 0.2126 + background.g * 0.7152 + background.b * 0.0722
  const light = luminance > 0.4
  // Fixed rather than derived from the surface: a background-relative grid
  // stayed a few percent off white in the light theme and read as almost gone.
  return {
    background,
    gridMajor: new THREE.Color(light ? 0x9aa1aa : 0x5f6672),
    gridMinor: new THREE.Color(light ? 0xd2d6db : 0x363c46),
    wire: new THREE.Color(light ? 0x2b3038 : 0xe3e7ec),
  }
}

/** Fixed palettes for the explicit light/dark backdrop, independent of the host. */
const LIGHT_THEME = { background: 0xf5f6f8, gridMajor: 0x9aa1aa, gridMinor: 0xd2d6db, wire: 0x2b3038 }
const DARK_THEME = { background: 0x101216, gridMajor: 0x5f6672, gridMinor: 0x363c46, wire: 0xe3e7ec }

/**
 * Pick the scene colours for a background mode.
 * @param THREE - three.js module.
 * @param host - element whose inherited tokens decide the theme.
 * @param mode - theme-following or an explicit light/dark backdrop.
 * @returns background and grid/wire colours.
 */
export function sceneThemeFor(
  THREE: ThreeBundle['THREE'],
  host: HTMLElement,
  mode: BackgroundMode,
): SceneTheme {
  if (mode === 'theme') return themeOf(THREE, host)
  const fixed = mode === 'light' ? LIGHT_THEME : DARK_THEME
  return {
    background: new THREE.Color(fixed.background),
    gridMajor: new THREE.Color(fixed.gridMajor),
    gridMinor: new THREE.Color(fixed.gridMinor),
    wire: new THREE.Color(fixed.wire),
  }
}

/**
 * Compare two theme snapshots by their rendered colours.
 * @param left - previous snapshot.
 * @param right - candidate snapshot.
 * @returns whether every colour is unchanged.
 */
export function sameTheme(left: SceneTheme, right: SceneTheme): boolean {
  return left.background.getHexString() === right.background.getHexString()
    && left.gridMajor.getHexString() === right.gridMajor.getHexString()
    && left.gridMinor.getHexString() === right.gridMinor.getHexString()
    && left.wire.getHexString() === right.wire.getHexString()
}
