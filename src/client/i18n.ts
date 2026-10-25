/**
 * Translation runtime.
 *
 * The shell exposes `ctx.locale` (register dictionaries, then `bind(namespace)`
 * for a translate function); when a profile has no locale service the plugin
 * still works by translating against the dictionaries bundled here. Both paths
 * answer through {@link t}, so call sites never care which one is active.
 *
 * The active language comes from `<html lang>`, which the shell sets from the
 * operator's preference; the bundled fallback reads it directly.
 */
import { en, zh } from './locales.ts'
import type { MessageKey } from './locales.ts'

/** Supported locales. */
export type Locale = 'zh' | 'en'

/** What a platform-bound translate looks like. */
type Translator = (key: string, params?: Readonly<Record<string, string | number>>) => string

let locale: Locale = 'zh'
let bound: Translator | undefined
const listeners = new Set<() => void>()

/**
 * Resolve the locale from the document.
 * @returns `en` when the shell declares English, `zh` otherwise.
 */
export function detectLocale(): Locale {
  if (typeof document !== 'undefined') {
    const declared = document.documentElement?.lang ?? ''
    if (/^en\b/iu.test(declared)) return 'en'
    if (/^zh\b/iu.test(declared)) return 'zh'
  }
  if (typeof navigator !== 'undefined' && /^en\b/iu.test(navigator.language ?? '')) return 'en'
  return 'zh'
}

/** Current locale of the bundled fallback. */
export function getLocale(): Locale {
  return locale
}

/**
 * Switch the bundled fallback's locale.
 * @param next - the locale to use.
 */
export function setLocale(next: Locale): void {
  if (next === locale) return
  locale = next
  for (const listener of listeners) listener()
}

/** Re-read the locale from the document (used when `lang` changes). */
export function refreshLocale(): void {
  setLocale(detectLocale())
}

/**
 * Install the platform translator.
 * @param next - `ctx.locale.bind(namespace)`, or undefined to fall back.
 */
export function setTranslator(next: Translator | undefined): void {
  bound = next
}

/**
 * Subscribe to locale changes.
 * @param listener - called after each change.
 * @returns an unsubscribe function.
 */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function interpolate(template: string, params?: Readonly<Record<string, string | number>>): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}

/**
 * Translate one message.
 * @param key - semantic message key.
 * @param params - values for `{name}` placeholders.
 * @returns the localized text.
 */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  if (bound !== undefined) return bound(key, params)
  const table = locale === 'en' ? en : zh
  return interpolate(table[key] ?? zh[key] ?? key, params)
}
