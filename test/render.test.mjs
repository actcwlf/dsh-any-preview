/**
 * Loads the built client bundle the way the browser module loader does, mounts
 * the CSV body against a fake ctx, and server-renders it.
 *
 * Requires the DSH checkout for React; override with DSH_REPO.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const repo = process.env.DSH_REPO ?? 'D:/DSH/deepseek-harness'
const anchor = `${repo}/packages/client/ui-sidebar-documentpreview/package.json`
const available = existsSync(anchor) && existsSync(new URL('../lib/client.js', import.meta.url))

test('client bundle registers the csv preview and renders a table', { skip: !available }, async () => {
  const repoRequire = createRequire(anchor)
  const React = repoRequire('react')
  const { renderToStaticMarkup } = repoRequire('react-dom/server')

  let captured
  globalThis.window = { __ModuleLoader__: { load: entry => { captured = entry } } }
  await import(new URL('../lib/client.js', import.meta.url).href)
  assert.ok(captured, 'bundle must call __ModuleLoader__.load')

  const mod = captured.factory(specifier => repoRequire(specifier))
  assert.deepEqual(mod.inject, ['slots', 'documentPreviews'])

  const definitions = []
  const seats = []
  const ctx = {
    effect: run => (run(), () => {}),
    documentPreviews: { register: definition => (definitions.push(definition), () => {}) },
    slots: {
      inject: (_key, run) => (run(), () => {}),
      register: (entry, component) => (seats.push({ entry, component }), () => {}),
    },
  }
  mod.apply(ctx)

  assert.equal(definitions.length, 1)
  assert.deepEqual(definitions[0].extensions, ['csv', 'tsv'])
  assert.equal(definitions[0].loading, 'text-pages')
  assert.equal(definitions[0].priority, 'extension')
  assert.equal(definitions[0].binaryExtensions, undefined)
  assert.equal(seats.length, 1)
  assert.equal(seats[0].entry.key, definitions[0].id)

  const csv = [
    'name,city,note',
    '"Ada, Lovelace",London,"quoted ""inside"""',
    'Grace,New York,',
    'Linus',
  ].join('\n')

  const html = renderToStaticMarkup(React.createElement(seats[0].component, {
    content: { kind: 'text', text: csv, eof: true },
    resourceAddress: 'dsh-resource://file/session/s/sample.csv',
    wrap: false,
  }))

  assert.equal((html.match(/<tr>/g) ?? []).length - 1, 3, 'three data rows')
  assert.match(html, /Ada, Lovelace/)
  assert.match(html, /quoted &quot;inside&quot;/)
  assert.match(html, /已读完/)
  assert.match(html, /3 行 × 3 列/)
})
