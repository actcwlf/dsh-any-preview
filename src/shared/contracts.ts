/**
 * Upstream contract checks.
 *
 * This plugin sits on three host capabilities: the document-preview registry,
 * the slot system, and the authenticated Fetch carrier. If a DSH upgrade renames
 * or reshapes one of them, nothing throws — the plugin simply stops rendering.
 * These checks turn that silence into one diagnostic line.
 */

/** One capability that did not look the way the plugin expects. */
export interface ContractIssue {
  readonly area: string
  readonly detail: string
}

/**
 * Report issues without throwing: this runs during activation, and a throw
 * there is a fatal boot error in the desktop shell.
 * @param scope - which half is reporting.
 * @param issues - what looks wrong.
 */
export function reportContractIssues(scope: 'client' | 'host', issues: readonly ContractIssue[]): void {
  if (issues.length === 0) return
  const lines = issues.map(issue => `  - ${issue.area}: ${issue.detail}`)
  console.error(`[dsh-any-preview] ${scope} 契约检查未通过，部分功能会静默缺失：\n${lines.join('\n')}`)
}
