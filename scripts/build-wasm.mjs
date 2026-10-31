#!/usr/bin/env node
/**
 * Build lib/lzma.wasm from the LZMA SDK sources in wasm/lzma.
 *
 * The module is freestanding on purpose: no emscripten runtime, no libc, no
 * filesystem. `wasm/include` supplies the three headers the SDK expects, and
 * wasm/shim.c supplies memcpy/memset and a bump allocator. That keeps the artifact
 * near 17 KB instead of the 200-400 KB an emscripten build would produce, and it
 * removes the cross-drive temp-directory problems emcc hits on Windows.
 *
 * Requires clang + wasm-ld with a wasm32 target:
 *   - emsdk: set EMSDK to its root (default D:\infrastructure\emsdk), or
 *   - any LLVM with wasm32 support on PATH.
 *
 * Usage: node scripts/build-wasm.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(root, 'lib')
const outFile = join(outDir, 'lzma.wasm')
const buildDir = join(root, 'tmp-wasm')

/** Sources, in link order. 7zCrc is absent: crc32 lives in the shim. */
const SOURCES = [
  'wasm/shim.c',
  'wasm/lzma/LzmaDec.c',
  'wasm/lzma/Lzma2Dec.c',
  'wasm/lzma/Bcj2.c',
  'wasm/lzma/CpuArch.c',
]

/** Exports the client depends on; asserted after the build. */
const EXPORTS = ['memory', 'malloc', 'free', 'reset_heap', 'lzma_decode', 'lzma2_decode', 'crc32_buf']

/** Locate a toolchain: emsdk first, then PATH. */
function toolchain() {
  const emsdk = process.env.EMSDK ?? 'D:\\infrastructure\\emsdk'
  const clang = join(emsdk, 'upstream', 'bin', 'clang.exe')
  const wasmLd = join(emsdk, 'upstream', 'bin', 'wasm-ld.exe')
  if (existsSync(clang) && existsSync(wasmLd)) return { clang, wasmLd }
  return { clang: 'clang', wasmLd: 'wasm-ld' }
}

function run(command, args) {
  // stdio is inherited on purpose: the sandbox denies piped child output (EPERM).
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    process.stderr.write(`${command} failed:\n${result.stderr ?? ''}\n`)
    process.exit(result.status ?? 1)
  }
  return result
}

const { clang, wasmLd } = toolchain()
const version = spawnSync(clang, ['--version'], { stdio: 'ignore' })
if (version.status !== 0) {
  process.stderr.write(`no wasm toolchain found (tried ${clang}). Set EMSDK or put clang on PATH.\n`)
  process.exit(1)
}

rmSync(buildDir, { recursive: true, force: true })
mkdirSync(buildDir, { recursive: true })
mkdirSync(outDir, { recursive: true })

const objects = []
for (const source of SOURCES) {
  const object = join(buildDir, `${source.replace(/[\\/]/gu, '_').replace(/\.c$/u, '')}.o`)
  run(clang, [
    '--target=wasm32-unknown-unknown', '-nostdlib', '-O3', '-mbulk-memory',
    '-I', 'wasm/include', '-I', 'wasm/lzma', '-c', source, '-o', object,
  ])
  objects.push(object)
}

run(wasmLd, [
  '--no-entry', '--export-memory',
  '--initial-memory=16777216', '--max-memory=536870912', '-z', 'stack-size=1048576',
  ...EXPORTS.filter(name => name !== 'memory').map(name => `--export=${name}`),
  '-o', outFile, ...objects,
])

const { readFileSync } = await import('node:fs')
const bytes = readFileSync(outFile)
const module = new WebAssembly.Module(bytes)
const present = new Set(WebAssembly.Module.exports(module).map(entry => entry.name))
const missing = EXPORTS.filter(name => !present.has(name))
if (missing.length > 0) {
  process.stderr.write(`lzma.wasm is missing exports: ${missing.join(', ')}\n`)
  process.exit(1)
}

const kilobytes = statSync(outFile).size / 1024
process.stdout.write(`lib/lzma.wasm: ${kilobytes.toFixed(1)} KB, exports ok (${EXPORTS.join(', ')})\n`)

// The object files are only an intermediate; the artifact is what ships.
rmSync(buildDir, { recursive: true, force: true })
