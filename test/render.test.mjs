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
  const ids = definitions.map(definition => definition.id)
  for (const expected of [
    'dsh-any-preview/csv',
    'dsh-any-preview/diff',
    'dsh-any-preview/log',
    'dsh-any-preview/jsonl',
    'dsh-any-preview/video',
    'dsh-any-preview/audio',
    'dsh-any-preview/glb',
    'dsh-any-preview/gltf',
    'dsh-any-preview/obj',
    'dsh-any-preview/stl',
    'dsh-any-preview/font',
    'dsh-any-preview/archive',
    'dsh-any-preview/eml',
    'dsh-any-preview/epub',
    'dsh-any-preview/ipynb',
    'dsh-any-preview/rst',
    'dsh-any-preview/safetensors',
    'dsh-any-preview/gguf',
    'dsh-any-preview/sqlite',
  ]) {
    assert.ok(ids.includes(expected), `missing ${expected}`)
  }
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
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

test('apply survives hostile optional capabilities', { skip: !available }, async () => {
  const entry = await loadEntry()
  const repoRequire = createRequire(anchor)
  const mod = entry.factory(specifier => repoRequire(specifier))
  const definitions = []
  const ctx = {
    effect: run => (run(), () => {}),
    documentPreviews: { register: definition => (definitions.push(definition), () => {}) },
    slots: { inject: (_key, run) => (run(), () => {}), register: () => () => {} },
    // The desktop shell turns a failed client entry into a fatal boot error, so
    // an unrouted namespace must never escape apply().
    get: () => new Proxy({}, { get() { throw new Error('namespace not routed') } }),
    inject: () => { throw new Error('inject exploded') },
  }
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.ok(definitions.length >= 10, 'every preview still registers')
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
  // Data rows carry a height attribute, so match the tag prefix and drop the
  // header row from the count.
  assert.equal((html.match(/<tr[ >]/g) ?? []).length - 1, 3, 'three data rows')
  assert.match(html, /Ada, Lovelace/)
  assert.match(html, /quoted &quot;inside&quot;/)
  assert.match(html, /3 行 × 3 列/)
  // No permanent stream-progress chip: the bar carries only real conditions.
  assert.doesNotMatch(html, /读取中/)
  assert.doesNotMatch(html, /已读完/)
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

test('diff body renders a classified patch', { skip: !available }, async () => {
  const { seats } = await mount()
  const seat = seats.find(entry => entry.entry.key === 'dsh-any-preview/diff')
  const patch = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,3 @@',
    ' const keep = 1',
    '-const old = 2',
    '+const next = 2',
    '',
  ].join('\n')
  const html = renderToStaticMarkup(React.createElement(seat.component, {
    content: { kind: 'text', text: patch, eof: true },
    resourceAddress: 'dsh-resource://file/session/s/change.patch',
    wrap: false,
  }))
  assert.match(html, /7 行/)
  assert.match(html, /\+1/)
  assert.match(html, /−1/)
  assert.match(html, /@@ -1,2 \+1,3 @@/)
  assert.match(html, /区分大小写/)
  assert.match(html, /上一个匹配/)
})

test('log body renders lines and a filter', { skip: !available }, async () => {
  const { seats } = await mount()
  const seat = seats.find(entry => entry.entry.key === 'dsh-any-preview/log')
  const log = ['booting', 'ERROR failed to bind', 'INFO listening'].join('\n')
  const html = renderToStaticMarkup(React.createElement(seat.component, {
    content: { kind: 'text', text: log, eof: true },
    resourceAddress: 'dsh-resource://file/session/s/run.log',
    wrap: false,
  }))
  assert.match(html, /搜索/)
  // Following is automatic now: reading history pauses it, returning resumes.\n  assert.doesNotMatch(html, /跟随尾部/)
  // The resting line count was removed as redundant; the field stands alone.\n  assert.doesNotMatch(html, /3 行/)
  assert.match(html, /ERROR failed to bind/)
  assert.match(html, /rgb\(248, 81, 73\)/)
})

test('jsonl body renders records as a table and flags bad lines', { skip: !available }, async () => {
  const { seats } = await mount()
  const seat = seats.find(entry => entry.entry.key === 'dsh-any-preview/jsonl')
  const text = ['{"id":1,"name":"a"}', '{"id":2,"name":"b"}', 'broken'].join('\n')
  const html = renderToStaticMarkup(React.createElement(seat.component, {
    content: { kind: 'text', text, eof: true },
    resourceAddress: 'dsh-resource://file/session/s/events.jsonl',
    wrap: false,
  }))
  assert.match(html, /3 条记录/)
  assert.match(html, /1 坏行/)
  assert.match(html, />id</)
  assert.match(html, />name</)
  assert.match(html, /broken/)
})

/** Previews whose body cannot render without real bytes or a live resource. */
const NEEDS_RESOURCE = new Set([
  'dsh-any-preview/archive', 'dsh-any-preview/media', 'dsh-any-preview/glb',
  'dsh-any-preview/gltf', 'dsh-any-preview/obj', 'dsh-any-preview/stl',
  'dsh-any-preview/font',
])

test('every preview definition is well-formed', { skip: !available }, async () => {
  const { definitions } = await mount()
  const ids = new Set()
  for (const definition of definitions) {
    const label = String(definition.id)
    assert.ok(!ids.has(definition.id), `duplicate id: ${label}`)
    ids.add(definition.id)
    assert.ok(definition.extensions.length > 0, `${label}: no extensions`)
    assert.ok(definition.extensions.every(ext => !ext.startsWith('.')), `${label}: extension must be bare`)
    assert.match(String(definition.title()), /\S/u, `${label}: empty title`)
    assert.ok(['text-pages', 'bytes-complete', 'renderer'].includes(definition.loading), `${label}: unknown loading`)
  }
})

test('every preview body renders without throwing', { skip: !available }, async () => {
  const { seats } = await mount()
  const failures = []
  for (const seat of seats) {
    const id = String(seat.entry.key)
    if (NEEDS_RESOURCE.has(id)) continue
    const extension = seat.entry.extensions?.[0] ?? 'txt'
    try {
      const html = renderToStaticMarkup(React.createElement(seat.component, {
        content: { kind: 'text', text: 'a,b\n1,2\n', eof: true },
        resourceAddress: `dsh-resource://file/session/s/sample.${extension}`,
        wrap: false,
      }))
      assert.ok(html.length > 0, `${id}: empty markup`)
      assert.ok(!html.includes('undefined'), `${id}: rendered undefined`)
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  assert.deepEqual(failures, [], `bodies that threw:\n${failures.join('\n')}`)
})
test('csv body renders a header and its rows', async () => {
  const { seats } = await mount()
  const seat = seats.find(entry => entry.entry.key === 'dsh-any-preview/csv')
  assert.ok(seat, 'the csv preview is registered')
  const text = 'id,name\n1,alpha\n2,beta\n'
  const html = renderToStaticMarkup(React.createElement(seat.component, {
    content: { kind: 'text', text, eof: true },
    resourceAddress: 'dsh-resource://file/session/s/run.csv',
    wrap: false,
  }))
  assert.match(html, /id/u)
  assert.match(html, /alpha/u)
  assert.match(html, /beta/u)
  assert.match(html, /2 行/u, 'the summary counts data rows')
})