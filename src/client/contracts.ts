/** What the client half needs from the host, checked at activation. */
import type { ContractIssue } from '../shared/contracts.ts'

/**
 * Check the client capabilities this package registers into.
 * @param ctx - the client context handed to apply.
 * @returns an empty list when everything looks usable.
 */
export function checkClientContracts(ctx: unknown): ContractIssue[] {
  const record = ctx as Record<string, unknown> | undefined
  const issues: ContractIssue[] = []

  const previews = record?.documentPreviews as { register?: unknown } | undefined
  if (typeof previews?.register !== 'function') {
    issues.push({ area: 'documentPreviews.register', detail: '不是函数，任何预览都不会被注册' })
  }

  const slots = record?.slots as { register?: unknown; inject?: unknown } | undefined
  if (typeof slots?.register !== 'function' || typeof slots?.inject !== 'function') {
    issues.push({ area: 'slots', detail: '缺少 register/inject，预览面板无法挂载' })
  }

  return issues
}
