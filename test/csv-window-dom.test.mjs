/**
 * Mounts the built CSV body in a DOM, the way the document owner does, and checks the
 * two-tier window load: placeholders while the scroll moves, real rows once it settles,
 * and the cached window when the scroll comes back.
 *
 * Requires the DSH checkout for React and jsdom; override with DSH_REPO. The last test
 * also uses the 22 MB `samples/huge.csv` fixture when it is on this machine; point
 * DSH_HUGE_CSV at it to use another path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { alignTextSlice } from '../src/host/text-route.ts'

const repo = process.env.DSH_REPO ?? 'D:/DSH/deepseek-harness'
const anchor = `${repo}/packages/client/ui-sidebar-documentpreview/package.json`
const available = existsSync(anchor) && existsSync(new URL('../lib/client.js', import.meta.url))

const rootRequire = createRequire(`${repo}/package.json`)
const anchorRequire = createRequire(anchor)

const ROW = 22
/** Longer than the 200 ms settle the preview waits for. */
const SETTLE = 320

/** The 22 MB fixture the windowing was designed against, when the machine has it. */
const hugeCsv = process.env.DSH_HUGE_CSV ?? new URL('../../samples/huge.csv', import.meta.url)
const hugeAvailable = available && existsSync(hugeCsv)

const React = available ? anchorRequire('react') : undefined
/**
 * `react-dom` must be required *after* the DOM globals exist: it captures
 * `canUseDOM` at import time, and without a DOM React's delegated events (input,
 * click) never fire — only element-attached ones like scroll do.
 */
let createRoot
/** React's own act, from the react-dom copy the DOM was built for. */
let act
/** Each mount needs its own module instance, so the bundle registers a fresh body. */
let mounts = 0

/** A CSV of `rows` data rows, header first, no trailing newline. */
function csvOf(rows) {
  const lines = ['id,name,note']
  for (let i = 1; i <= rows; i++) lines.push(`${i},user_${i},note ${i}`)
  return lines.join('\n')
}

/** Wait `ms` inside act, so React flushes what the timers and scroll events caused. */
async function tick(ms) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

/**
 * Tick until `check` passes. The suite shares one process and one event loop, so a scan
 * that publishes as it goes has no reliable duration; waiting on the outcome is stable.
 * @param {() => boolean} check - condition to wait for.
 * @param {number} timeout - milliseconds after which the wait gives up.
 * @returns {Promise<boolean>} whether the condition became true.
 */
async function waitFor(check, timeout = 6_000) {
  const started = Date.now()
  for (;;) {
    if (check()) return true
    if (Date.now() - started > timeout) return false
    await tick(50)
  }
}

/**
 * Install a DOM, load the built bundle into it, and return the registered CSV seat.
 * @returns {Promise<{window: object, component: Function}>} what to mount.
 */
async function mountCsv() {
  const { JSDOM } = rootRequire('jsdom')
  const dom = new JSDOM('<!doctype html><html lang="zh"><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:4233/',
  })
  const { window } = dom
  // jsdom has no layout: give every element the height a sidebar document has.
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return 480 },
  })
  for (const key of ['HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    globalThis[key] = window[key]
  }
  globalThis.window = window
  globalThis.document = window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // Warming the 3D chunk is a browser-only concern; keep it out of the test's timer queue.
  globalThis.requestIdleCallback = () => 0
  // Only now is it safe to load react-dom: it decides at import time whether there is a
  // DOM, and a copy loaded earlier never delegates input/click events.
  createRoot = anchorRequire('react-dom/client').createRoot
  act = React.act

  let captured
  window.__ModuleLoader__ = { load: (entry) => { captured = entry } }
  // A distinct specifier per mount, so the bundle runs again even in a process that
  // already loaded it for another test or another DOM.
  mounts += 1
  await import(`${new URL('../lib/client.js', import.meta.url).href}?dom=${String(mounts)}`)
  assert.ok(captured, 'the bundle registers through the module loader')

  const mod = captured.factory(specifier => anchorRequire(specifier))
  const seats = []
  mod.apply({
    effect: run => { run(); return () => {} },
    documentPreviews: { register: () => () => {} },
    slots: {
      inject: (_key, run) => (run(), () => {}),
      register: (entry, component) => (seats.push({ entry, component }), () => {}),
    },
  })
  const seat = seats.find(entry => entry.entry.key === 'dsh-any-preview/csv')
  assert.ok(seat, 'the csv preview registers a body')
  return { window, component: seat.component }
}

/**
 * Install a fake Host for one file: the text route over `text`, and the media route
 * answering the one-byte probe the size comes from.
 * @param {string} text - the file's contents.
 * @returns {{ bytes: number, restore: () => void }} its size, and how to undo this.
 */
function installHost(text, options = {}) {
  const bytes = Buffer.from(text, 'utf8')
  const delay = options.delay ?? 0
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    // A slow host lets a test stop a scan while it is still in flight.
    if (delay > 0) await new Promise(resolve => { setTimeout(resolve, delay) })
    const url = new URL(String(input), 'http://127.0.0.1:4233/')
    if (url.pathname === '/api/any-preview/media') {
      return new Response(null, { status: 206, headers: { 'content-range': `bytes 0-0/${String(bytes.length)}` } })
    }
    if (url.pathname !== '/api/any-preview/text') return new Response('no route', { status: 404 })
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const length = Number(url.searchParams.get('length') ?? String(bytes.length))
    const rowStart = url.searchParams.get('rowStart') === '1'
    const window = bytes.subarray(offset, Math.min(bytes.length, offset + length))
    return Response.json(alignTextSlice(window, offset, bytes.length, rowStart))
  }
  return { bytes: bytes.length, restore: () => { globalThis.fetch = original } }
}

/**
 * Mount the body over `text`; returns the root, the scroller and row helpers.
 * @param component - the CSV body.
 * @param text - text the document owner delivered.
 * @param {{ path?: string }} [options] - `path` makes the owner report a Host file,
 *   which lets the body read the file itself.
 */
async function render(component, text, options = {}) {
  const container = document.getElementById('root')
  const root = createRoot(container)
  const { path } = options
  // The owner's metadata hook: a stable identity across renders, like the real one.
  const useResource = path === undefined ? undefined : () => ({ value: { absolutePath: path, version: 'v1' } })
  await act(async () => {
    root.render(React.createElement(component, {
      content: { kind: 'text', text, eof: true },
      resourceAddress: 'dsh-resource://file/session/s/huge.csv',
      wrap: false,
      useResource,
    }))
  })
  const table = container.querySelector('table')
  assert.ok(table, 'the table is mounted')
  // table -> pinned block -> content (a fixed-height spacer when proportional) -> scroller.
  const content = table.parentElement?.parentElement ?? null
  const scroller = content?.parentElement ?? null
  assert.ok(content !== null && scroller !== null, 'the table sits inside the scroller')
  const painted = () => [...container.querySelectorAll('tr[data-row-index]')].map(row => ({
    index: Number(row.getAttribute('data-row-index')),
    cells: [...row.children].map(cell => cell.textContent ?? ''),
  }))
  /** Scroll the table and report what is painted before anything else happens. */
  const scrollToBodyRow = async (row) => {
    await act(async () => {
      scroller.scrollTop = row * ROW
      scroller.dispatchEvent(new window.Event('scroll'))
    })
  }
  /** Scroll to a fraction of the scroller's travel. */
  const scrollToFraction = async (fraction) => {
    // jsdom has no layout, so the travel comes from the spacer's declared height when
    // the table is proportional, and from scrollHeight (0) otherwise.
    const declared = Number.parseFloat(content.style.height)
    const travel = Number.isFinite(declared)
      ? Math.max(0, declared - scroller.clientHeight)
      : Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    await act(async () => {
      scroller.scrollTop = travel * fraction
      scroller.dispatchEvent(new window.Event('scroll'))
    })
  }
  /** Unmount, so a pending settle timer cannot update React after the test ends. */
  const dispose = async () => { await act(async () => { root.unmount() }) }
  /** The row count the summary claims, as a number. */
  const summaryRows = () => {
    const match = /([\d,]+) 行/u.exec(container.textContent ?? '')
    return match === null ? Number.NaN : Number(match[1].replaceAll(',', ''))
  }
  return { container, scroller, content, painted, scrollToBodyRow, scrollToFraction, dispose, summaryRows }
}

test('a windowed csv knows its row count and first rows on the first paint', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const text = csvOf(120_000)
  assert.ok(text.length > 2 * 1024 * 1024, 'the fixture is past the windowing threshold')
  const view = await render(component, text)
  t.after(view.dispose)
  // The header and the row count are known immediately, and the first window is read
  // at once: nothing is being dragged, so there is no settle to wait for.
  assert.match(view.container.textContent, /120,000 行/)
  assert.ok(view.painted().length >= 10, 'the first window is painted without a wait')
  // Filtering would hide rows a window does not hold, so the control is not offered.
  assert.equal(view.container.querySelector('input[type="checkbox"]'), null)
})

test('a small csv is not windowed and paints on the first render', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const view = await render(component, 'id,name\n1,alpha\n2,beta\n')
  t.after(view.dispose)
  const rows = view.painted()
  assert.deepEqual(rows.map(row => row.cells), [['1', '1', 'alpha'], ['2', '2', 'beta']])
  // The filter control is still offered where the whole file is in memory.
  assert.ok(view.container.querySelector('input[type="checkbox"]'), 'only-matches is available')
})

test('a table past the scroll limit keeps 22px rows and a proportional scrollbar', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const rows = 800_000
  // 800,000 rows at 22px would need 17.6M px, past the browser's 16.7M cap.
  const view = await render(component, csvOf(rows))
  t.after(view.dispose)
  assert.equal(view.summaryRows(), rows)
  // The content is a fixed-height spacer, not the natural row stack.
  const contentHeight = Number.parseFloat(view.content.style.height)
  assert.ok(Math.abs(contentHeight - 16_777_216) < 1, `spacer height ${String(contentHeight)}`)
  // Rows keep their box; the scrollbar turns proportional instead of the text shrinking.
  const first = view.painted()[0]
  assert.equal(first.cells[0], '1')
  assert.equal(first.cells[2], 'user_1')
  const row = view.container.querySelector('tr[data-row-index]')
  assert.equal(row?.getAttribute('style'), `height: ${String(ROW)}px;`)

  await tick(SETTLE)
  // Half way down the scrollbar is half way through the file, within a screen.
  await view.scrollToFraction(0.5)
  await tick(SETTLE)
  const middle = view.painted()
  assert.ok(middle.length >= 10, 'the middle band is painted')
  const expected = Math.round((rows - 1) * 0.5)
  assert.ok(Math.abs(middle[0].index - expected) < 60, `band starts at ${String(middle[0].index)}, expected ~${String(expected)}`)

  // The very bottom reaches the file's last row.
  await view.scrollToFraction(1)
  await tick(SETTLE)
  const end = view.painted()
  const last = end[end.length - 1]
  assert.equal(last.index, rows - 1, 'the last body row is painted')
  assert.equal(last.cells[0], String(rows), 'and it is labelled with the last file row')
  assert.equal(last.cells[2], `user_${String(rows)}`)
})

test('a windowed csv paints absolute row numbers after the scroll settles', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const view = await render(component, csvOf(120_000))
  t.after(view.dispose)

  await tick(SETTLE)
  const top = view.painted()
  assert.ok(top.length >= 10, `first window painted ${String(top.length)} rows`)
  assert.equal(top[0].index, 0, 'the first body row is file row 1')
  assert.equal(top[0].cells[0], '1', 'the row number is the absolute file row')
  assert.equal(top[0].cells[1], '1', 'the id column of the first data row')
  assert.equal(top[0].cells[2], 'user_1')

  // A drag: the next window is not read yet, so nothing stale stays on screen.
  await view.scrollToBodyRow(100_000)
  assert.equal(view.painted().length, 0, 'a moving viewport paints placeholders')

  await tick(SETTLE)
  const middle = view.painted()
  assert.ok(middle.length >= 10, `window painted ${String(middle.length)} rows`)
  const first = middle[0].index
  assert.ok(first >= 99_900 && first <= 100_000, `first painted body row ${String(first)}`)
  assert.equal(middle[0].cells[0], String(first + 1), 'the row number is its absolute position')
  assert.equal(middle[0].cells[2], `user_${String(first + 1)}`)
  // The row under the scroll position is the row the user asked for.
  const atTop = middle.find(row => row.index === 100_000)
  assert.ok(atTop, 'the viewport row is painted')
  assert.equal(atTop.cells[0], '100001')
  assert.equal(atTop.cells[2], 'user_100001')

  // Back to the first window: the cache answers without waiting for the settle timer.
  await view.scrollToBodyRow(0)
  const again = view.painted()
  assert.ok(again.length >= 10, 'the cached window paints immediately')
  assert.equal(again[0].cells[0], '1')
})

test('a windowed csv keeps its filler the height of the whole file', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const view = await render(component, csvOf(120_000))
  t.after(view.dispose)
  await tick(SETTLE)
  await view.scrollToBodyRow(60_000)
  await tick(SETTLE)
  const rows = [...view.container.querySelectorAll('tr')]
  const header = rows[0]
  const bodyRows = rows.slice(1)
  const heights = bodyRows.map((row) => {
    const value = row.style.height
    return value.endsWith('px') ? Number.parseFloat(value) : Number.NaN
  })
  assert.ok(heights.every(value => Number.isFinite(value)), 'every painted row states its height')
  const total = heights.reduce((sum, value) => sum + value, 0)
  // The header row is drawn outside this sum; the body covers all 120,000 data rows.
  assert.equal(Math.round(total), 120_000 * ROW)
  assert.ok(header, 'the header is still drawn once')
})

test('the 22 MB fixture browses to row 200,000', { skip: !hugeAvailable }, async (t) => {
  const text = readFileSync(hugeCsv, 'utf8')
  assert.ok(text.length > 20 * 1024 * 1024, 'the fixture is the 22 MB one')
  const { component } = await mountCsv()
  const view = await render(component, text)
  t.after(view.dispose)
  assert.match(view.container.textContent, /300,000 行/, 'every row of the file is counted')

  await tick(SETTLE)
  await view.scrollToBodyRow(200_000)
  await tick(SETTLE)
  const rows = view.painted()
  const atTop = rows.find(row => row.index === 200_000)
  assert.ok(atTop, 'the row at the scroll position is painted')
  assert.equal(atTop.cells[0], '200001', 'row numbers count the header as row 0')
  assert.match(atTop.cells[2] ?? '', /^user_200001$/u)

  // Filler above, painted band and filler below still add up to the whole file, so the
  // scrollbar keeps its length however far into the file the reader is.
  const heights = [...view.container.querySelectorAll('tr')].slice(1)
    .map(row => Number.parseFloat(row.style.height))
  assert.ok(heights.every(Number.isFinite), 'every painted row states its height')
  assert.equal(Math.round(heights.reduce((sum, value) => sum + value, 0)), 300_000 * ROW)
})

test('a file the owner would page reads a jump straight from the file', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const total = 120_000
  const host = installHost(csvOf(total))
  t.after(host.restore)
  // No background walk in this test: the jump has to work without one.
  globalThis.requestIdleCallback = () => 0
  // The owner delivered its first page only; `eof` says more pages exist, but the table
  // never asks for page two.
  const view = await render(component, csvOf(5_000), { path: '/data/big.csv' })
  t.after(view.dispose)
  await tick(SETTLE)

  // The whole file's size gives the row count before a single page is indexed.
  const shown = view.summaryRows()
  assert.ok(Number.isFinite(shown), 'the summary states a row count')
  assert.ok(Math.abs(shown - total) < total * 0.05, `estimated ${String(shown)} of ${String(total)} rows from ${String(host.bytes)} bytes`)

  // Jump far past the rows the owner delivered.
  await view.scrollToBodyRow(100_000)
  await tick(SETTLE)
  const rows = view.painted()
  assert.ok(rows.length >= 10, 'the jump is painted')
  assert.match(rows[0].cells[0], /^~/u, 'a number the index has not reached yet is marked')
  const id = Number(rows[0].cells[2].replace('user_', ''))
  assert.ok(id > 90_000 && id < 110_000, `content is near the jump: ${String(id)}`)

  // The very bottom shows the file's last rows, not the start of its last slice.
  await view.scrollToBodyRow(shown - 1)
  await tick(SETTLE)
  const tail = view.painted()
  assert.match(tail[tail.length - 1].cells[2], /^user_120000$/u, 'the file ends here')
})

test('the background walk makes the row count and the numbers exact', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const host = installHost(csvOf(120_000))
  t.after(host.restore)
  // Idle callbacks stand in for the browser's: one slice per callback, like the real one.
  globalThis.requestIdleCallback = (callback) => setTimeout(callback, 0)
  const view = await render(component, csvOf(5_000), { path: '/data/big.csv' })
  t.after(view.dispose)
  await tick(SETTLE)
  // The walk is a handful of slices; give the timers room to finish it.
  await tick(600)

  // The exact total is adopted on a drag longer than three screens, not before.
  await view.scrollToBodyRow(6_000)
  await tick(SETTLE)
  assert.equal(view.summaryRows(), 120_000, 'the index has counted every row')

  await view.scrollToBodyRow(100_000)
  await tick(SETTLE)
  const rows = view.painted()
  const atTop = rows.find(row => row.index === 100_000)
  assert.ok(atTop, 'the row at the scroll position is painted')
  assert.equal(atTop.cells[0], '100001', 'the number is exact once the index covers it')
  assert.equal(atTop.cells[2], 'user_100001')
})

test('the table never goes blank while the file is being indexed', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const host = installHost(csvOf(400_000))
  t.after(host.restore)
  // A slow idle walk keeps indexing running while the samples below are taken.
  globalThis.requestIdleCallback = (callback) => setTimeout(callback, 20)
  const view = await render(component, csvOf(5_000), { path: '/data/big.csv' })
  t.after(view.dispose)

  let sawRows = false
  const samples = []
  let blanks = 0
  for (let sample = 0; sample < 30; sample += 1) {
    const rows = view.painted().length
    samples.push(rows)
    if (rows > 0) sawRows = true
    else if (sawRows) blanks += 1
    await tick(20)
  }
  assert.ok(sawRows, 'the table painted its first window')
  // Regression: an index slice used to invalidate the window cache, and the read that
  // would have refilled it never ran again — the table then showed placeholders forever.
  assert.equal(blanks, 0, `the table went blank while indexing: ${samples.join(',')}`)
})

test('a scan hit past the loaded rows is one click away', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const host = installHost(csvOf(120_000))
  t.after(host.restore)
  globalThis.requestIdleCallback = () => 0
  // The owner delivered its first page only (5,000 rows); the match is at row 100,000.
  const view = await render(component, csvOf(5_000), { path: '/data/big.csv' })
  t.after(view.dispose)
  await tick(SETTLE)

  /** Type into the search field the way a reader would. */
  const search = async (value) => {
    const input = view.container.querySelector('input[type="search"]')
    assert.ok(input, 'the search field is mounted')
    const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
    })
  }
  /** Press Enter in the search field, which is what starts a whole-file scan. */
  const enter = async () => {
    const input = view.container.querySelector('input[type="search"]')
    assert.ok(input, 'the search field is mounted')
    await act(async () => {
      input.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
  }
  const nextButton = () => view.container.querySelector('button[title="下一个匹配"]')

  await search('user_100000')
  // Typing alone only searches the rows in memory; the file is not walked until Enter.
  await tick(300)
  assert.doesNotMatch(view.container.textContent ?? '', /全文扫描/u, 'no scan before Enter')
  await enter()
  // The scan walks the file; the row search cannot see this match at all.
  await tick(600)
  assert.match(view.container.textContent ?? '', /共 1 处匹配/u)
  const next = nextButton()
  assert.equal(next?.disabled, false, 'the arrow is enabled by the scan result')

  await act(async () => { next.click() })
  await tick(SETTLE)
  const rows = view.painted()
  const hit = rows.find(row => row.index === 99_999)
  assert.ok(hit, `the hit row is painted, painted ${String(rows[0]?.index)}..${String(rows[rows.length - 1]?.index)}`)
  assert.equal(hit.cells[2], 'user_100000')
  assert.match(view.container.querySelector('tr[data-row-index="99999"]')?.getAttribute('style') ?? '', /rgba\(255, 196, 0/u,
    'the hit row is marked')

  // A query that matches every row keeps the count whole and caps what is navigable.
  await search('user_')
  await enter()
  await tick(800)
  assert.match(view.container.textContent ?? '', /共 120,000 处匹配（可跳转前 5,000 处）/u)
})

test('an active search hit does not pin the view in the proportional mode', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const rows = 800_000
  const view = await render(component, csvOf(rows))
  t.after(view.dispose)
  await tick(SETTLE)
  // The table is past the scroll limit, so the bar is proportional.
  const contentHeight = Number.parseFloat(view.content.style.height)
  assert.ok(Math.abs(contentHeight - 16_777_216) < 1, 'proportional mode')

  const input = view.container.querySelector('input[type="search"]')
  const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, 'user_400000')
    input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  // The scan publishes as it goes; wait for the revealed band instead of guessing a
  // duration, since the whole suite shares one process and one event loop.
  const revealed = await waitFor(() => view.painted().some(row => row.index === 399_999))
  assert.ok(revealed, `the hit is revealed, painted ${String(view.painted()[0]?.index)}`)

  // A reader scrolling away from a hit must stay where they scroll: the reveal runs on
  // the navigated row, not on every render.
  await view.scrollToFraction(0.9)
  await tick(SETTLE)
  const moved = view.painted()
  assert.ok(moved[0].index > 600_000, `the band followed the scroll, painted ${String(moved[0]?.index)}`)
  assert.ok(!moved.some(row => row.index === 399_999), 'and no longer sits on the hit')
})

test('stopping a scan keeps the hits it had already found', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  // Each slice waits, so the stop lands while the scan is still in flight.
  const rows = 120_000
  const text = csvOf(rows)
  const host = installHost(text, { delay: 80 })
  t.after(host.restore)
  globalThis.requestIdleCallback = () => 0
  const view = await render(component, csvOf(5_000), { path: '/data/big.csv' })
  t.after(view.dispose)
  // Long enough for the (also delayed) size probe and first slice to land.
  await tick(1_500)

  const input = view.container.querySelector('input[type="search"]')
  const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, 'user_70000')
    input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await tick(60)
  const stop = [...view.container.querySelectorAll('button')].find(button => button.textContent === '终止扫描')
  assert.ok(stop, 'the stop control appears while the scan runs')
  await act(async () => { stop.click() })
  await tick(400)
  assert.match(view.container.textContent ?? '', /已停止扫描/u, 'the status says the scan was stopped')
  assert.doesNotMatch(view.container.textContent ?? '', /全文扫描完成/u, 'and it is not reported as a finished scan')
  // The search still works for the rows in memory, so the field is not wedged.
  assert.equal(view.container.querySelector('input[type="search"]')?.value, 'user_70000')
})

test('the 22 MB fixture reaches row 200,000 the way the app does', { skip: !hugeAvailable }, async (t) => {
  const text = readFileSync(hugeCsv, 'utf8')
  assert.ok(text.length > 20 * 1024 * 1024, 'the fixture is the 22 MB one')
  const { component } = await mountCsv()
  const host = installHost(text)
  t.after(host.restore)
  // Only the first page arrives from the owner, and no background walk yet.
  globalThis.requestIdleCallback = () => 0
  const firstPage = text.split('\n', 5_001).join('\n')
  const view = await render(component, firstPage, { path: '/data/huge.csv' })
  t.after(view.dispose)
  await tick(SETTLE)

  const shown = view.summaryRows()
  assert.ok(Math.abs(shown - 300_000) < 2_000, `estimated ${String(shown)} of 300,000 rows`)

  // One drag to row 200,000: no pages were loaded from the head to get here.
  await view.scrollToBodyRow(200_000)
  await tick(SETTLE)
  const rows = view.painted()
  const atTop = rows.find(row => row.index === 200_000)
  assert.ok(atTop, 'the jumped-to row is painted')
  assert.match(atTop.cells[0], /^~/u, 'its number is still an estimate')
  const id = Number((atTop.cells[2] ?? '').replace('user_', ''))
  assert.ok(Math.abs(id - 200_001) < 3_000, `content lands near row 200,000: ${String(id)}`)

  // Dragging to the bottom lands on the file's own last row.
  await view.scrollToBodyRow(shown - 1)
  await tick(SETTLE)
  const tail = view.painted()
  assert.match(tail[tail.length - 1].cells[2] ?? '', /^user_300000$/u, 'the file ends here')
})

