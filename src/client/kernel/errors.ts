/**
 * Localized failures from parsers.
 *
 * A parser must not decide which language the reader uses, and a Chinese string
 * thrown from a pure module cannot be translated afterwards. Parsers therefore
 * throw a key (plus values), and the body renders it through `t`.
 *
 * Fields are assigned in the constructor rather than declared as parameter
 * properties: this file is loaded by Node's type stripping in the tests, which
 * does not support parameter properties.
 */
import { t } from '../i18n.ts'
import type { MessageKey } from '../locales.ts'

/** A failure that carries a message key instead of finished prose. */
export class PreviewError extends Error {
  /** Message key resolved at render time. */
  readonly key: MessageKey

  /** Values for the key's placeholders. */
  readonly params: Readonly<Record<string, string | number>> | undefined

  /**
   * @param key - message key resolved at render time.
   * @param params - values for the key's placeholders.
   */
  constructor(key: MessageKey, params?: Readonly<Record<string, string | number>>) {
    super(key)
    this.name = 'PreviewError'
    this.key = key
    this.params = params
  }
}

/**
 * Create a localized failure.
 * @param key - message key.
 * @param params - placeholder values.
 * @returns the error to throw.
 */
export function previewError(key: MessageKey, params?: Readonly<Record<string, string | number>>): PreviewError {
  return new PreviewError(key, params)
}

/**
 * Turn any thrown value into display text.
 * @param error - the caught value.
 * @param fallback - key used when the value carries no message.
 * @returns localized text for the pane.
 */
export function errorText(error: unknown, fallback: MessageKey): string {
  if (error instanceof PreviewError) return t(error.key, error.params)
  if (error instanceof Error && error.message !== '') return error.message
  return t(fallback)
}
