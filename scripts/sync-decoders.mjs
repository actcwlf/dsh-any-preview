/**
 * Copy the decoder binaries three ships into `lib/`, where the loopback asset
 * route serves them.
 *
 * They are not dependencies of this package: three already vendors the builds
 * (Draco's glTF variant, Basis Universal's transcoder) under its examples, and
 * esbuild cannot bundle a wasm file into the decoder chunk. Copying at build
 * time keeps the repository free of ~836 KB of third-party binaries while the
 * installed plugin still has everything it needs.
 *
 * Run after the tsdown build; `pnpm build` does both.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * Where three keeps the builds, and the exact bytes this package was tested
 * against. A three upgrade that changes a decoder now fails the build instead
 * of silently shipping a different Draco/Basis pair.
 */
const DECODERS = [
  {
    source: 'examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js',
    target: 'draco_wasm_wrapper.js',
    sha256: '8bb2952d2ba7d67e1414f8df819410cb0434a666be53f671fff75f68843d76f6',
    size: 58_456,
  },
  {
    source: 'examples/jsm/libs/draco/gltf/draco_decoder.wasm',
    target: 'draco_decoder.wasm',
    sha256: 'a680d927bed9cb864ddbd63521868891af2bfbe755092761b4837487618df8ac',
    size: 192_420,
  },
  {
    source: 'examples/jsm/libs/basis/basis_transcoder.js',
    target: 'basis_transcoder.js',
    sha256: '8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1',
    size: 57_529,
  },
  {
    source: 'examples/jsm/libs/basis/basis_transcoder.wasm',
    target: 'basis_transcoder.wasm',
    sha256: '6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a',
    size: 527_333,
  },
]

const three = fileURLToPath(new URL('../node_modules/three/', import.meta.url))
const lib = fileURLToPath(new URL('../lib/', import.meta.url))
const version = JSON.parse(readFileSync(`${three}package.json`, 'utf8')).version
mkdirSync(lib, { recursive: true })

let copied = 0
for (const decoder of DECODERS) {
  const from = `${three}${decoder.source}`
  if (!existsSync(from)) {
    throw new Error(`decoder missing from three: ${decoder.source} (is the devDependency installed?)`)
  }
  const bytes = readFileSync(from)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== decoder.sha256 || bytes.byteLength !== decoder.size) {
    throw new Error(
      `decoder changed in three ${version}: ${decoder.source}\n`
      + `  expected ${decoder.size} B / ${decoder.sha256}\n`
      + `  actual   ${bytes.byteLength} B / ${digest}\n`
      + 'Update the DECODERS manifest in scripts/sync-decoders.mjs after verifying the new build.',
    )
  }
  const to = `${lib}${decoder.target}`
  copyFileSync(from, to)
  copied += 1
  console.log(`[dsh-any-preview] ${decoder.target} <- ${decoder.source} (${String(statSync(to).size)} B)`)
}
console.log(`[dsh-any-preview] ${String(copied)} decoder files ready in lib/ (three ${version})`)
