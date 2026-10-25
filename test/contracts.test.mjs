/** Upstream contract checks: they report, they never throw. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkClientContracts } from '../src/client/contracts.ts'
import { checkHostContracts } from '../src/host/self-check.ts'
import { reportContractIssues } from '../src/shared/contracts.ts'

function clientContext() {
  return {
    documentPreviews: { register: () => () => {} },
    slots: { register: () => () => {}, inject: (_key, run) => run() },
  }
}

function hostContext() {
  const noop = () => {}
  return {
    connection: { fetch: { register: () => () => {} } },
    fs: { readByteRange: noop, readBytes: noop, readText: noop, resolve: noop, stat: noop },
  }
}

test('a complete client context reports no issues', () => {
  assert.deepEqual(checkClientContracts(clientContext()), [])
})

test('a missing client capability is reported, not thrown', () => {
  const issues = checkClientContracts({})
  assert.equal(issues.length, 2)
  assert.ok(issues.some(issue => issue.area === 'documentPreviews.register'))
  assert.ok(issues.some(issue => issue.area === 'slots'))
})

test('a complete host context reports no issues', () => {
  assert.deepEqual(checkHostContracts(hostContext()), [])
})

test('the host check names every missing filesystem method', () => {
  const issues = checkHostContracts({ connection: { fetch: { register: () => {} } }, fs: { readText: () => {} } })
  const areas = issues.map(issue => issue.area)
  assert.ok(areas.includes('fs.readByteRange'))
  assert.ok(areas.includes('fs.readBytes'))
  assert.ok(!areas.includes('fs.readText'))
})

test('reporting an empty list is silent and reporting issues does not throw', () => {
  const original = console.error
  const seen = []
  console.error = message => seen.push(message)
  try {
    reportContractIssues('client', [])
    assert.equal(seen.length, 0)
    reportContractIssues('host', [{ area: 'fs.readBytes', detail: 'missing' }])
    assert.equal(seen.length, 1)
    assert.match(seen[0], /fs\.readBytes/u)
  } finally {
    console.error = original
  }
})
