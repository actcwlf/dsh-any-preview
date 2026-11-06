/**
 * Camera and grid arithmetic for the 3D preview.
 *
 * These rules used to live inside the renderer effect, where no test could
 * reach them: the camera distance ignored the pane's aspect ratio (a narrow
 * sidebar cropped a long model), and a fixed 1000-unit floor on the far plane
 * left millimetre-scale models z-fighting. Keeping the numbers pure makes the
 * trade-offs visible and lets `test/model-frame.test.mjs` pin them.
 */

/** Distance and clip planes for a camera that must contain a sphere. */
export interface Framing {
  /** Distance from the sphere's centre along the view direction. */
  readonly distance: number
  /** Near clip plane. */
  readonly near: number
  /** Far clip plane. */
  readonly far: number
}

/** Grid divisions drawn across a model's footprint. */
export const GRID_DIVISIONS = 20

/**
 * Fit a perspective camera to a bounding sphere.
 *
 * The limiting field of view is the smaller of the vertical one and the
 * horizontal one derived from the aspect ratio, so a pane narrower than it is
 * tall pulls the camera back instead of cropping the model's sides.
 * @param radius - bounding sphere radius; non-positive or invalid values fall back to 1.
 * @param fovDeg - vertical field of view in degrees.
 * @param aspect - viewport width divided by height.
 * @param padding - extra room around the sphere, as a factor (1 = touching).
 * @returns distance and clip planes; the far plane also covers the orbit zoom-out limit.
 */
export function frameForSphere(radius: number, fovDeg: number, aspect: number, padding = 1.15): Framing {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 1
  const fov = (Math.min(Math.max(Number.isFinite(fovDeg) ? fovDeg : 45, 1), 170) * Math.PI) / 180
  const halfVertical = Math.tan(fov / 2)
  const halfHorizontal = halfVertical * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1)
  const distance = (r * Math.max(padding, 1)) / Math.max(Math.min(halfVertical, halfHorizontal), 1e-6)
  return {
    distance,
    // Well in front of the closest orbit distance (1.1 r), so zooming in cannot clip.
    near: Math.max(r / 20, distance / 10_000, 1e-6),
    // The viewer may zoom out to eight distances; the far plane must still hold the model.
    far: distance * 12 + r * 4,
  }
}

/** Grid extent, divisions and height for a model footprint. */
export interface GridSpec {
  readonly size: number
  readonly divisions: number
  readonly y: number
}

/**
 * Size a floor grid to a model's footprint.
 *
 * A fixed 10-unit grid was meaningless for anything that was not roughly ten
 * units across; the grid carries the model's scale instead.
 * @param sizeX - bounding box width.
 * @param sizeZ - bounding box depth.
 * @param minY - lowest point of the model, in the frame the grid is placed in.
 * @returns grid extent (twice the larger footprint side), divisions, and its height.
 */
export function gridForBox(sizeX: number, sizeZ: number, minY: number): GridSpec {
  const width = Number.isFinite(sizeX) ? Math.abs(sizeX) : 0
  const depth = Number.isFinite(sizeZ) ? Math.abs(sizeZ) : 0
  const span = Math.max(width, depth)
  return {
    size: (span > 0 ? span : 1) * 2,
    divisions: GRID_DIVISIONS,
    y: Number.isFinite(minY) ? minY : 0,
  }
}
