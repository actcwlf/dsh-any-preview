#!/usr/bin/env node
/**
 * Publish the package with the npm-specific README.
 *
 * npm reads README.md from the tarball; it has no separate "npm readme" file.
 * Pack once with README.npm.md in place, restore README.md, then publish the
 * prepared tarball. Restoring before the network step means a failed upload
 * never leaves the working tree with the wrong README.
 *
 * Usage:
 *   node scripts/publish-npm.mjs [npm publish args]
 *
 * With no `--tag`, a prerelease version is published under its prerelease
 * identifier (`beta`, `test`, `rc`, …); a stable version uses npm's normal
 * default. Pass any npm publish flags after the script name:
 *   node scripts/publish-npm.mjs --tag beta
 *   node scripts/publish-npm.mjs --dry-run
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readmePath = join(root, 'README.md')
const npmReadmePath = join(root, 'README.npm.md')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const args = process.argv.slice(2).filter(argument => argument !== '--')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const hasTag = args.some(argument => argument === '--tag' || argument.startsWith('--tag='))
const prereleaseTag = packageJson.version.match(/-([0-9A-Za-z-]+)(?:\.|$)/u)?.[1]
const needsPrereleaseTag = prereleaseTag !== undefined && !hasTag
const publishArgs = [
  ...args,
  ...(needsPrereleaseTag ? ['--tag', prereleaseTag] : []),
]

const originalReadme = readFileSync(readmePath)
const npmReadme = readFileSync(npmReadmePath)
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-any-preview-publish-'))

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    // npm on Windows is npm.cmd, which Node cannot spawn directly.
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed with status ${String(result.status)}`)
}

try {
  writeFileSync(readmePath, npmReadme)
  console.log('[publish:npm] packing with README.npm.md')

  run(npm, ['pack', '--pack-destination', tempDir], { stdio: 'inherit' })

  const tarballs = readdirSync(tempDir).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`expected one tarball in ${tempDir}, found ${String(tarballs.length)}`)
  }
  const tarball = join(tempDir, tarballs[0])

  // Restore before publishing so the network step cannot leave a swapped tree.
  writeFileSync(readmePath, originalReadme)
  console.log(`[publish:npm] publishing ${tarballs[0]}`)
  console.log(`[publish:npm] npm publish ${publishArgs.join(' ')}`)
  run(npm, ['publish', tarball, ...publishArgs], { stdio: 'inherit' })
} finally {
  writeFileSync(readmePath, originalReadme)
  rmSync(tempDir, { recursive: true, force: true })
}
