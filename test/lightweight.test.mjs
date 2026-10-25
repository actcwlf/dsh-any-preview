/** Lightweight markup readers: reST, notebooks, and the EPUB helpers. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRst } from '../src/client/previews/rst/parse.ts'
import { parseNotebook } from '../src/client/previews/ipynb/parse.ts'
import {
  containerOpfPath, decodeEntities, htmlToMarkdownText, imageMimeType, parseNav, parseNcx, parseOpf,
  resolveHref, scopeCss,
} from '../src/client/previews/epub/parse.ts'
import { sanitizeHtml } from '../src/client/kernel/html.ts'

test('rst headings take their level from the order the adornments appear', () => {
  const blocks = parseRst([
    'Title',
    '=====',
    '',
    'Section',
    '-------',
    '',
    'text',
  ].join('\n'))
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'heading', 'paragraph'])
  assert.equal(blocks[0].level, 1)
  assert.equal(blocks[1].level, 2)
  assert.equal(blocks[2].text, 'text')
})

test('rst keeps bullet and enumerated lists apart', () => {
  const blocks = parseRst(['- one', '- two', '', '1. first', '2. second'].join('\n'))
  assert.equal(blocks[0].kind, 'list')
  assert.equal(blocks[0].ordered, false)
  assert.deepEqual(blocks[0].items, ['one', 'two'])
  assert.equal(blocks[1].kind, 'list')
  assert.equal(blocks[1].ordered, true)
  assert.deepEqual(blocks[1].items, ['first', 'second'])
})

test('rst code-block and note directives produce code and a callout', () => {
  const blocks = parseRst([
    '.. code-block:: python',
    '',
    '   print("hi")',
    '   print("there")',
    '',
    '.. note::',
    '   Something worth knowing.',
  ].join('\n'))
  assert.equal(blocks[0].kind, 'code')
  assert.equal(blocks[0].language, 'python')
  assert.equal(blocks[0].text, 'print("hi")\nprint("there")')
  assert.equal(blocks[1].kind, 'quote')
  assert.match(blocks[1].text, /Something worth knowing/u)
})

test('rst literal blocks follow a paragraph ending in a double colon', () => {
  const blocks = parseRst(['Example::', '', '   line one', '   line two'].join('\n'))
  assert.equal(blocks[0].kind, 'paragraph')
  assert.equal(blocks[0].text, 'Example:')
  assert.equal(blocks[1].kind, 'code')
  assert.equal(blocks[1].text, 'line one\nline two')
})

test('rst roles degrade to their label', () => {
  const blocks = parseRst('See :ref:`the section` for details.')
  assert.equal(blocks[0].text, 'See `the section` for details.')
})

test('a notebook yields markdown and code cells with outputs', () => {
  const notebook = parseNotebook(JSON.stringify({
    metadata: { language_info: { name: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Title', '\n', 'body'] },
      {
        cell_type: 'code',
        execution_count: 3,
        source: 'print(1)',
        outputs: [
          { output_type: 'stream', text: ['1\n'] },
          { output_type: 'display_data', data: { 'image/png': 'AAAA' } },
          { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['line a', 'line b'] },
        ],
      },
    ],
  }))
  assert.equal(notebook.language, 'python')
  assert.equal(notebook.cells.length, 2)
  assert.equal(notebook.cells[0].kind, 'markdown')
  assert.equal(notebook.cells[0].source, '# Title\nbody')
  const code = notebook.cells[1]
  assert.equal(code.kind, 'code')
  assert.equal(code.executionCount, 3)
  assert.equal(code.outputs[0].kind, 'text')
  assert.equal(code.outputs[0].text, '1\n')
  assert.equal(code.outputs[1].kind, 'image')
  assert.match(code.outputs[1].dataUri, /^data:image\/png;base64,AAAA$/u)
  assert.equal(code.outputs[2].kind, 'error')
  assert.equal(code.outputs[2].text, 'line a\nline b')
})

test('a malformed notebook is empty rather than throwing', () => {
  assert.deepEqual(parseNotebook('{not json').cells, [])
  assert.deepEqual(parseNotebook('{"cells": 5}').cells, [])
})

test('the container document points at the package document', () => {
  const xml = '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
  assert.equal(containerOpfPath(xml), 'OEBPS/content.opf')
  assert.equal(containerOpfPath('<container/>'), undefined)
})

test('manifest hrefs resolve against the package directory', () => {
  assert.equal(resolveHref('OEBPS', 'Text/ch1.xhtml'), 'OEBPS/Text/ch1.xhtml')
  assert.equal(resolveHref('OEBPS/Text', '../Images/cover.jpg'), 'OEBPS/Images/cover.jpg')
  assert.equal(resolveHref('', 'a%20b.xhtml'), 'a b.xhtml')
  assert.equal(resolveHref('OEBPS', '/root.xhtml'), 'root.xhtml')
})

test('the spine lists chapter entries in reading order and skips stylesheets', () => {
  const opf = [
    '<package><metadata><dc:title>A &amp; B</dc:title></metadata><manifest>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    '<item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>',
    '<item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>',
    '</manifest><spine><itemref idref="c1"/><itemref idref="css"/><itemref idref="c2"/></spine></package>',
  ].join('')
  const parsed = parseOpf(opf, 'OEBPS/content.opf')
  assert.equal(parsed.title, 'A & B')
  assert.deepEqual(parsed.spine, ['OEBPS/Text/ch1.xhtml', 'OEBPS/Text/ch2.xhtml'])
})

test('chapter XHTML becomes headings, list items and code fences', () => {
  const text = htmlToMarkdownText([
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>',
    '<h2>Chapter &amp; One</h2>',
    '<p>Some <em>text</em>.</p>',
    '<ul><li>alpha</li><li>beta</li></ul>',
    '<pre>code here</pre>',
    '<script>alert(1)</script>',
    '</body></html>',
  ].join(''))
  assert.match(text, /^## Chapter & One$/mu)
  assert.match(text, /^- alpha$/mu)
  assert.match(text, /^```$/mu)
  assert.match(text, /^code here$/mu)
  assert.ok(!text.includes('alert'), 'scripts are removed')
  assert.ok(!text.includes('<'), 'tags are removed')
})

test('named and numeric entities decode', () => {
  assert.equal(decodeEntities('a &lt; b &amp;&amp; c &#65;&#x42;'), 'a < b && c AB')
})

test('rst simple tables keep header and body rows', () => {
  const blocks = parseRst(['=====  =====', 'Name   Age', '=====  =====', 'Ada    36', '=====  ====='].join('\n'))
  assert.equal(blocks[0].kind, 'table')
  assert.deepEqual(blocks[0].header, ['Name', 'Age'])
  assert.deepEqual(blocks[0].rows, [['Ada', '36']])
})

test('rst grid tables keep header and body rows', () => {
  const blocks = parseRst(['+-----+-----+', '| a   | b   |', '+=====+=====+', '| 1   | 2   |', '+-----+-----+'].join('\n'))
  assert.equal(blocks[0].kind, 'table')
  assert.deepEqual(blocks[0].header, ['a', 'b'])
  assert.deepEqual(blocks[0].rows, [['1', '2']])
})

test('rst footnotes move to a trailing list and references lose the underscore', () => {
  const blocks = parseRst(['Text[1]_ here.', '', '.. [1] The note.'].join('\n'))
  assert.equal(blocks[0].text, 'Text[1] here.')
  const last = blocks[blocks.length - 1]
  assert.equal(last.kind, 'list')
  assert.deepEqual(last.items, ['[1] The note.'])
})

test('rst substitutions are applied to the text', () => {
  const blocks = parseRst(['.. |name| replace:: World', '', 'Hello |name|!'].join('\n'))
  assert.equal(blocks[0].text, 'Hello World!')
})

test('rst toctree becomes a directory list', () => {
  const blocks = parseRst(['.. toctree::', '   :maxdepth: 2', '', '   intro', '   usage'].join('\n'))
  assert.equal(blocks[0].text, '目录')
  assert.equal(blocks[1].kind, 'list')
  assert.deepEqual(blocks[1].items, ['intro', 'usage'])
})

test('epub nav and ncx both yield titled chapter entries', () => {
  const nav = parseNav('<nav><ol><li><a href="Text/ch1.xhtml">One</a></li></ol></nav>', 'OEBPS')
  assert.deepEqual(nav, [{ title: 'One', href: 'OEBPS/Text/ch1.xhtml' }])
  const ncx = parseNcx('<navPoint><navLabel><text>Two</text></navLabel><content src="ch2.xhtml"/></navPoint>', 'OEBPS')
  assert.deepEqual(ncx, [{ title: 'Two', href: 'OEBPS/ch2.xhtml' }])
})

test('epub stylesheets are scoped and filtered', () => {
  const scoped = scopeCss('.drop { color: blue } p, .x { color: red; background-image: url(a.png) }', 'dsh-epub-body')
  assert.equal(scoped.replaceAll(' ', ''), '.dsh-epub-body p{color:red}'.replaceAll(' ', ''))
})

test('images are typed by suffix and turned into data URIs', () => {
  assert.equal(imageMimeType('OEBPS/Images/a.PNG'), 'image/png')
  assert.equal(imageMimeType('OEBPS/a.pdf'), undefined)
  const text = htmlToMarkdownText('<p><img src="a.png" alt="cover"/></p>', () => 'data:image/png;base64,AA')
  assert.match(text, /!\[cover\]\(data:image\/png;base64,AA\)/u)
})

test('unresolved images are dropped instead of producing broken links', () => {
  const text = htmlToMarkdownText('<p><img src="missing.png"/></p>', () => undefined)
  assert.ok(!text.includes('!['), text)
})

test('sanitizing keeps markup and removes every way to execute', () => {
  const clean = sanitizeHtml(
    '<div onclick="steal()"><script>evil()</script><a href="javascript:boom()">t</a><p>ok</p></div>',
  )
  assert.ok(!clean.includes('<script'), clean)
  assert.ok(!clean.includes('onclick'), clean)
  assert.ok(!clean.includes('javascript:'), clean)
  assert.ok(clean.includes('<p>ok</p>'), clean)
})

test('a notebook html output is kept as html', () => {
  const notebook = parseNotebook(JSON.stringify({
    cells: [{
      cell_type: 'code', execution_count: 1, source: 'df',
      outputs: [{ output_type: 'execute_result', data: { 'text/html': '<table><tr><td>1</td></tr></table>' } }],
    }],
  }))
  assert.equal(notebook.cells[0].outputs[0].kind, 'html')
  assert.match(notebook.cells[0].outputs[0].text, /<table>/u)
})
