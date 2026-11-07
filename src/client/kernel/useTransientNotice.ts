/**
 * One transient operation notice and its timer.
 *
 * The notice lives in the owning preview, not in the visual toast, so closing
 * and reopening the list cannot resurrect an expired message. The timer is
 * cleared on unmount and restarted when another action reports a result.
 */
import { useEffect, useRef, useState } from 'react'

/** One transient operation result. `id` lets a repeated message restart the timer. */
export interface TransientNotice {
  readonly id: number
  readonly text: string
  readonly tone?: 'normal' | 'critical'
}

/** What a preview gets back from the hook. */
export interface TransientNoticeState {
  readonly notice: TransientNotice | undefined
  readonly showNotice: (text: string, tone?: 'normal' | 'critical') => void
}

export function useTransientNotice(): TransientNoticeState {
  const [notice, setNotice] = useState<TransientNotice | undefined>(undefined)
  const id = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  const showNotice = (text: string, tone: 'normal' | 'critical' = 'normal'): void => {
    id.current += 1
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    setNotice({ id: id.current, text, tone })
    timer.current = window.setTimeout(() => {
      setNotice(undefined)
      timer.current = undefined
    }, tone === 'critical' ? 6000 : 4000)
  }

  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
  }, [])

  return { notice, showNotice }
}
