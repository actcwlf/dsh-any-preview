/**
 * Loads the built client bundle the way the browser module loader does, mounts
 * the bodies against a fake ctx, and server-renders them.
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

// The bundle is a classic script: ESM caches the import, so it executes once.
let entryPromise
let React
let renderToStaticMarkup

/**
 * Load the bundle exactly once and resolve its captured factory.
 * @returns {Promise<{factory: Function}>} the loader entry.
 */
function loadEntry() {
  entryPromise ??= (async () => {
    const repoRequire = createRequire(anchor)
    React = repoRequire('react')
    renderToStaticMarkup = repoRequire('react-dom/server').renderToStaticMarkup
    let captured
    globalThis.window = { __ModuleLoader__: { load: entry => { captured = entry } } }
    await import(new URL('../lib/client.js', import.meta.url).href)
    assert.ok(captured, 'bundle must call __ModuleLoader__.load')
    return captured
  })()
  return entryPromise
}

/**
 * Load the bundle and register it against a fresh fake client context.
 * @returns {Promise<{definitions: object[], seats: object[]}>} what it registered.
 */
async function mount() {
  const entry = await loadEntry()
  const repoRequire = createRequire(anchor)
  const mod = entry.factory(specifier => repoRequire(specifier))
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
  return { definitions, seats }
}

test('client bundle registers every preview in the list', { skip: !available }, async () => {
  const { definitions } = await mount()
  assert.deepEqual(definitions.map(definition => definition.id), [
    'dsh-any-preview/csv',
    'dsh-any-preview/video',
    'dsh-any-preview/audio',
  ])
  for (const definition of definitions) {
    assert.equal(definition.priority, 'extension')
    assert.ok(definition.extensions.length > 0)
  }
  const video = definitions.find(definition => definition.id.endsWith('/video'))
  assert.equal(video.loading, 'renderer')
  assert.ok(video.binaryExtensions.includes('mp4'))
  assert.ok(video.binaryExtensions.includes('mkv'))
  const csv = definitions.find(definition => definition.id.endsWith('/csv'))
  assert.equal(csv.binaryExtensions, undefined)
})

test('csv body renders a table', { skip: !available }, async () => {
  const { seats } = await mount()
  const seat = seats.find(entry => entry.entry.key === 'dsh-any-preview/csv')
  const csv = [
    'name,city,note',
    '"Ada, Lovelace",London,"quoted ""inside"""',
    'Grace,New York,',
    'Linus',
  ].join('\n')
  const html = renderToStaticMarkup(React.createElement(seat.component, {
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

test('media bodies stream from the range route', { skip: !available }, async () => {
  const { seats } = await mount()
  // The player builds its URL against document.baseURI, like the built-ins do.
  globalThis.document = { baseURI: 'http://127.0.0.1:1234/' }
  const content = { kind: 'renderer', revision: 1, loaded: () => {}, failed: () => {}, reload: () => {} }
  const useResource = () => ({
    value: { absolutePath: '/media/clip.mp4', version: 'v1', size: 30_000_000 },
  })

  const videoSeat = seats.find(entry => entry.entry.key === 'dsh-any-preview/video')
  const videoHtml = renderToStaticMarkup(React.createElement(videoSeat.component, {
    content,
    resourceAddress: 'dsh-resource://file/session/s/clip.mp4',
    wrap: false,
    useResource,
  }))
  assert.match(videoHtml, /<video/)
  assert.match(videoHtml, /controls/)
  assert.match(videoHtml, /http:\/\/127\.0\.0\.1:1234\/api\/any-preview\/media\?path=%2Fmedia%2Fclip\.mp4/)
  assert.match(videoHtml, /clip\.mp4/)
  assert.match(videoHtml, /download=1/)

  const audioSeat = seats.find(entry => entry.entry.key === 'dsh-any-preview/audio')
  const audioHtml = renderToStaticMarkup(React.createElement(audioSeat.component, {
    content,
    resourceAddress: 'dsh-resource://file/session/s/clip.mp4',
    wrap: false,
    useResource,
  }))
  assert.match(audioHtml, /<audio/)
  assert.doesNotMatch(audioHtml, /<video/)
})
