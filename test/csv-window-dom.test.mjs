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
const { createRoot } = available ? anchorRequire('react-dom/client') : {}
// React 18.3 exposes act itself; older checkouts keep it in the test utilities.
const act = available ? (React.act ?? anchorRequire('react-dom/test-utils').act) : undefined
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
  for (const key of [
    'window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    if (key === 'window') globalThis.window = window
    else if (key === 'document') globalThis.document = window.document
    else if (key === 'IS_REACT_ACT_ENVIRONMENT') globalThis.IS_REACT_ACT_ENVIRONMENT = true
    else globalThis[key] = window[key]
  }
  // Warming the 3D chunk is a browser-only concern; keep it out of the test's timer queue.
  globalThis.requestIdleCallback = () => 0

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

/** Mount the body over `text`; returns the root, the scroller and row helpers. */
async function render(component, text) {
  const container = document.getElementById('root')
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(component, {
      content: { kind: 'text', text, eof: true },
      resourceAddress: 'dsh-resource://file/session/s/huge.csv',
      wrap: false,
    }))
  })
  const table = container.querySelector('table')
  assert.ok(table, 'the table is mounted')
  const scroller = table.parentElement
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
  /** Unmount, so a pending settle timer cannot update React after the test ends. */
  const dispose = async () => { await act(async () => { root.unmount() }) }
  return { container, scroller, painted, scrollToBodyRow, dispose }
}

test('a windowed csv spends the first paint on placeholders', { skip: !available }, async (t) => {
  const { component } = await mountCsv()
  const text = csvOf(120_000)
  assert.ok(text.length > 2 * 1024 * 1024, 'the fixture is past the windowing threshold')
  const view = await render(component, text)
  t.after(view.dispose)
  // The header and the row count are known immediately; the rows are not read yet.
  assert.match(view.container.textContent, /120,000 行/)
  assert.equal(view.painted().length, 0, 'no window is read during the first paint')
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
