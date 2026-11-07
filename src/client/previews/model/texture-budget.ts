/**
 * Decoded texture budget.
 *
 * A 64 MB compressed atlas can decode to hundreds of megabytes of GPU memory;
 * the byte budget alone cannot see that. The planner keeps the longest edge and
 * the total pixel count bounded, and the browser half downsizes images before
 * three uploads them for the first time.
 */

/** Limits applied to decoded images. */
export interface TextureBudget {
  readonly maxDimension: number
  readonly maxPixels: number
}

/** One image dimension used by the planner. */
export interface TextureSize {
  readonly width: number
  readonly height: number
}

/** What the planner would do to one image. */
export interface TexturePlan extends TextureSize {
  readonly targetWidth: number
  readonly targetHeight: number
  readonly resized: boolean
}

/**
 * Plan downscales for a set of images.
 *
 * The scale is global so a model keeps the relative resolution of its atlas
 * pieces; the dimension cap is applied per image. A plan never enlarges.
 * @param sizes - decoded image dimensions.
 * @param budget - maximum edge and total pixels.
 * @returns one plan per input, in the same order.
 */
export function planTextureResizes(
  sizes: readonly TextureSize[],
  budget: TextureBudget,
): TexturePlan[] {
  const maxDimension = Number.isFinite(budget.maxDimension) && budget.maxDimension > 0
    ? budget.maxDimension
    : Infinity
  const maxPixels = Number.isFinite(budget.maxPixels) && budget.maxPixels > 0
    ? budget.maxPixels
    : Infinity
  let totalPixels = 0
  for (const size of sizes) {
    totalPixels += Math.max(0, size.width) * Math.max(0, size.height)
  }
  const globalScale = totalPixels > maxPixels ? Math.sqrt(maxPixels / totalPixels) : 1
  return sizes.map((size) => {
    const width = Math.max(0, Math.floor(size.width))
    const height = Math.max(0, Math.floor(size.height))
    const edge = Math.max(width, height)
    const edgeScale = edge > maxDimension ? maxDimension / edge : 1
    const scale = Math.min(1, globalScale, edgeScale)
    const targetWidth = Math.max(1, Math.floor(width * scale))
    const targetHeight = Math.max(1, Math.floor(height * scale))
    return {
      width,
      height,
      targetWidth,
      targetHeight,
      resized: targetWidth !== width || targetHeight !== height,
    }
  })
}

/**
 * Collect the distinct, non-compressed images attached to a scene's materials.
 * @param root - loaded model root.
 * @returns texture entries with usable dimensions.
 */
export function collectTextures(root: any): Array<{ texture: any; width: number; height: number }> {
  const seen = new Set<any>()
  const found: Array<{ texture: any; width: number; height: number }> = []
  root.traverse((child: any) => {
    const material = child.material
    for (const one of Array.isArray(material) ? material : material === undefined ? [] : [material]) {
      if (one === null || typeof one !== 'object') continue
      for (const value of Object.values(one)) {
        const texture = value as any
        if (texture === null || typeof texture !== 'object' || texture.isTexture !== true) continue
        if (texture.isCompressedTexture === true || texture.isDataTexture === true) continue
        if (seen.has(texture)) continue
        seen.add(texture)
        const width = Number(texture.image?.width)
        const height = Number(texture.image?.height)
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
        found.push({ texture, width, height })
      }
    }
  })
  return found
}

/** Canvas type accepted by both DOM and worker implementations. */
type CanvasLike = {
  width: number
  height: number
  getContext(type: '2d'): any
  toBlob?: (callback: (blob: Blob | null) => void, type?: string) => void
  convertToBlob?: (options?: { type?: string }) => Promise<Blob>
}

/**
 * Downscale images before three uploads them.
 *
 * Best effort: a browser without `createImageBitmap`/canvas keeps the original
 * textures rather than failing the whole model. Returns whether any image was
 * replaced.
 * @param root - loaded model root.
 * @param budget - maximum edge and total decoded pixels.
 * @returns true when at least one texture was replaced.
 */
export async function enforceTextureBudget(root: any, budget: TextureBudget): Promise<boolean> {
  const entries = collectTextures(root)
  const plans = planTextureResizes(entries, budget)
  if (!plans.some((plan) => plan.resized)) return false
  if (typeof createImageBitmap !== 'function') return false

  let changed = false
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]
    const entry = entries[index]
    if (plan === undefined || entry === undefined || !plan.resized) continue
    try {
      const bitmap = await createImageBitmap(entry.texture.image)
      const canvas = createCanvas(plan.targetWidth, plan.targetHeight)
      if (canvas === null) {
        bitmap.close?.()
        continue
      }
      const context = canvas.getContext('2d')
      if (context === null) {
        bitmap.close?.()
        continue
      }
      context.drawImage(bitmap, 0, 0, plan.targetWidth, plan.targetHeight)
      bitmap.close?.()
      const blob = await canvasToBlob(canvas)
      if (blob === null) continue
      const url = URL.createObjectURL(blob)
      try {
        const image = new Image()
        image.src = url
        if (typeof image.decode === 'function') {
          await image.decode()
        } else {
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve()
            image.onerror = () => reject(new Error('texture image failed'))
          })
        }
        entry.texture.image = image
        entry.texture.needsUpdate = true
        changed = true
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (error) {
      console.warn('[dsh-any-preview] texture downscale failed', error)
    }
  }
  return changed
}

/** Create a 2D canvas in the DOM or a worker. */
function createCanvas(width: number, height: number): CanvasLike | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

/** Encode a canvas as PNG. */
async function canvasToBlob(canvas: CanvasLike): Promise<Blob | null> {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' })
  }
  if (typeof canvas.toBlob === 'function') {
    return new Promise((resolve) => {
      canvas.toBlob?.((blob) => resolve(blob), 'image/png')
    })
  }
  return null
}
