#!/usr/bin/env node
/**
 * Placeholder builder for the future decode wasm.
 *
 * There is no codec in this repository yet, and no emscripten toolchain in the
 * usual build environment, so this script explains the contract and exits
 * non-zero when asked to actually build. Keeping it here means the delivery
 * path (lib/<name>.wasm -> asset route -> loadWasm) is already wired when the
 * decoder arrives.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const wasm = join(root, 'lib', 'lzma.wasm')
const source = join(root, 'wasm', 'lzma')

if (existsSync(wasm) && process.argv.includes('--check')) {
  process.stdout.write(`present: ${wasm}\n`)
  process.exit(0)
}

process.stdout.write([
  'Decode wasm is not built: this repository ships no codec yet.',
  '',
  `  source directory: ${source}`,
  `  output:           ${wasm}`,
  '',
  'Required exports: alloc, free, decode, last_error, memory.',
  'Suggested build (LZMA SDK, no filesystem, no CLI):',
  '',
  '  emcc lzma/C/LzmaDec.c -O3 -flto -sSTANDALONE_WASM=1 \\',
  '    -sALLOW_MEMORY_GROWTH=1 \\',
  '    -sEXPORTED_FUNCTIONS=_alloc,_free,_decode,_last_error \\',
  '    -Wl,--no-entry -o lib/lzma.wasm',
  '',
  'The asset route already serves any name listed in src/shared/assets.ts,',
  'so no build wiring is needed once the file exists.',
  '',
].join('\n'))

const emcc = spawnSync('emcc', ['--version'], { stdio: 'ignore' })
if (emcc.status !== 0) {
  process.stderr.write('emcc not found: install emscripten or build elsewhere.\n')
  process.exit(1)
}
process.stdout.write('emcc is available; see wasm/README.md for the contract.\n')
