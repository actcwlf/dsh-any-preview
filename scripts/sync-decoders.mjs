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
 * Run after the tsdown build; `npm run build` does both.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Where three keeps the builds; the destination is flat because assets are served by name. */
const DECODERS = [
  ['examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js', 'draco_wasm_wrapper.js'],
  ['examples/jsm/libs/draco/gltf/draco_decoder.wasm', 'draco_decoder.wasm'],
  ['examples/jsm/libs/basis/basis_transcoder.js', 'basis_transcoder.js'],
  ['examples/jsm/libs/basis/basis_transcoder.wasm', 'basis_transcoder.wasm'],
]

const three = fileURLToPath(new URL('../node_modules/three/', import.meta.url))
const lib = fileURLToPath(new URL('../lib/', import.meta.url))
mkdirSync(lib, { recursive: true })

let copied = 0
for (const [source, target] of DECODERS) {
  const from = `${three}${source}`
  const to = `${lib}${target}`
  if (!existsSync(from)) {
    throw new Error(`decoder missing from three: ${source} (is the devDependency installed?)`)
  }
  copyFileSync(from, to)
  copied += 1
  console.log(`[dsh-any-preview] ${target} <- ${source} (${String(statSync(to).size)} B)`)
}
console.log(`[dsh-any-preview] ${String(copied)} decoder files ready in lib/`)
