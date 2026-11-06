/**
 * 3D model preview registrations.
 *
 * The body lives in `ModelBody.tsx`; the viewer lifecycle, controls and
 * overlay are separate modules. One module per extension, so the toolbar can
 * still offer the text view.
 */
import { t } from '../../i18n.ts'
import { ModelBody } from './ModelBody.tsx'
import type { PreviewModule } from '../../kernel/types.ts'

/**
 * Declare one suffix's preview.
 * @param id - renderer id, unique across the package.
 * @param extensions - suffixes claimed without a leading dot.
 * @param binary - suffixes whose bytes are not text, when the text fallback must be suppressed.
 * @param title - toolbar label.
 * @returns the preview module.
 */
function moduleFor(
  id: string,
  extensions: readonly string[],
  binary: readonly string[] | undefined,
  title: () => string,
): PreviewModule {
  return {
    id,
    extensions,
    ...(binary === undefined ? {} : { binary }),
    load: 'renderer',
    wrap: false,
    title,
    Body: ModelBody,
  }
}

export const glbPreview = moduleFor('dsh-any-preview/glb', ['glb'], ['glb'], () => t('model.title'))
export const gltfPreview = moduleFor('dsh-any-preview/gltf', ['gltf'], undefined, () => t('model.title'))
export const objPreview = moduleFor('dsh-any-preview/obj', ['obj'], undefined, () => t('model.title'))
export const stlPreview = moduleFor('dsh-any-preview/stl', ['stl'], undefined, () => t('model.title'))
