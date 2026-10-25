/** What the Host half needs from the platform, checked at activation. */
import type { ContractIssue } from '../shared/contracts.ts'

/** Filesystem methods the routes call. */
const FS_METHODS = ['readByteRange', 'readBytes', 'readText', 'resolve', 'stat'] as const

/**
 * Check the Host capabilities this package registers into.
 * @param ctx - the Host context handed to apply.
 * @returns an empty list when everything looks usable.
 */
export function checkHostContracts(ctx: unknown): ContractIssue[] {
  const record = ctx as Record<string, unknown> | undefined
  const issues: ContractIssue[] = []

  const connection = record?.connection as { fetch?: { register?: unknown } } | undefined
  if (typeof connection?.fetch?.register !== 'function') {
    issues.push({
      area: 'connection.fetch.register',
      detail: '不是函数，字节读取与解压路由都不会注册（音视频、3D、电子书、解压全部不可用）',
    })
  }

  const fs = record?.fs as Record<string, unknown> | undefined
  for (const method of FS_METHODS) {
    if (typeof fs?.[method] !== 'function') {
      issues.push({ area: `fs.${method}`, detail: '不是函数，相关读取会失败' })
    }
  }

  return issues
}
