/**
 * React binding for the translation runtime.
 *
 * Kept apart from `i18n.ts` so the runtime itself stays importable from pure
 * tests (this file is the only one that needs React).
 */
import { useEffect, useState } from 'react'
import { getLocale, subscribeLocale } from './i18n.ts'
import type { Locale } from './i18n.ts'

/**
 * Subscribe a component to locale changes.
 * Call it in any body that renders `t(...)`, so a language switch re-renders.
 * @returns the locale in effect.
 */
export function useLocale(): Locale {
  const [current, setCurrent] = useState<Locale>(getLocale())
  useEffect(() => {
    setCurrent(getLocale())
    return subscribeLocale(() => { setCurrent(getLocale()) })
  }, [])
  return current
}
