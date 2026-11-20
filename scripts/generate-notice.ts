#!/usr/bin/env npx tsx
/**
 * Generate the third-party package list in NOTICE from package-lock.json.
 *
 * Why generated (not hand-authored): the hand-kept table drifted. It named
 * LangChain, the OpenAI SDK and Sentry, none of which ship, and missed
 * libheif-js, DOMPurify, SheetJS and the AI SDK. The lockfile is the record of
 * what npm installs, so the list is derived from it.
 *
 * Shipped means every package `npm ci --omit=dev` installs: each lockfile entry
 * without `"dev": true`. Optional platform binaries are listed for every
 * platform, so the output does not depend on the machine that ran it.
 *
 * Only the block between the BEGIN/END GENERATED markers is rewritten. The
 * header and the hand-written notes above it (code the lockfile cannot see,
 * copyleft notes, dual-license choices) stay as written.
 *
 * Two guards keep the hand-written part honest:
 *   - a shipped package without a license field fails until LICENSE_OVERRIDES
 *     records the license read from its LICENSE file;
 *   - an installed shipped package with its own NOTICE file (Apache-2.0 §4(d)
 *     requires carrying it forward) fails until the hand-written part names it.
 *
 * Deterministic: sorted, no timestamps; --check regenerates in memory and fails
 * (exit 1) when the committed NOTICE is stale, mirroring skills:check.
 *
 * Usage:
 *   npm run notice:generate   # rewrite NOTICE
 *   npm run notice:check      # CI guard: exit 1 if NOTICE is stale
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.cwd()
const NOTICE_PATH = join(ROOT, 'NOTICE')
const LOCKFILE_PATH = join(ROOT, 'package-lock.json')

export const BEGIN = '--- BEGIN GENERATED: npm run notice:generate ---'
export const END = '--- END GENERATED ---'

/** Packages whose package.json has no license field; value read from their LICENSE file. */
export const LICENSE_OVERRIDES: Record<string, string> = {
  'png-js': 'MIT',
}

export interface Lockfile {
  lockfileVersion: number
  packages?: Record<string, LockEntry>
}

interface LockEntry {
  name?: string
  version?: string
  license?: unknown
  dev?: boolean
  link?: boolean
}

export interface ShippedPackage {
  name: string
  version: string
  license: string
  path: string
}

function packageNameFromPath(path: string): string {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

export function collectShippedPackages(lock: Lockfile): { packages: ShippedPackage[]; errors: string[] } {
  if (!lock.packages) {
    return { packages: [], errors: [`package-lock.json v${lock.lockfileVersion} has no "packages" map`] }
  }

  const errors: string[] = []
  const seen = new Set<string>()
  const packages: ShippedPackage[] = []
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.dev || entry.link) continue
    const name = entry.name ?? packageNameFromPath(path)
    const version = entry.version ?? 'unknown'
    const license = typeof entry.license === 'string' ? entry.license : LICENSE_OVERRIDES[name]
    if (!license) {
      errors.push(`${name}@${version} declares no license: read its LICENSE file and add it to LICENSE_OVERRIDES`)
      continue
    }
    const key = `${name}@${version}`
    if (seen.has(key)) continue
    seen.add(key)
    packages.push({ name, version, license, path })
  }
  return { packages, errors }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function renderGenerated(packages: ShippedPackage[]): string {
  const byLicense = new Map<string, ShippedPackage[]>()
  for (const pkg of packages) {
    const group = byLicense.get(pkg.license) ?? []
    group.push(pkg)
    byLicense.set(pkg.license, group)
  }
  const licenses = [...byLicense.keys()].sort(
    (a, b) => byLicense.get(b)!.length - byLicense.get(a)!.length || compare(a, b),
  )

  const lines = [
    BEGIN,
    '',
    `Shipped third-party packages (${packages.length}): every package npm installs`,
    'with --omit=dev, read from package-lock.json. Licenses are the SPDX',
    'expressions each package declares; dual-license choices are noted above.',
  ]
  for (const license of licenses) {
    const group = byLicense.get(license)!.sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version))
    lines.push('', `${license} (${group.length})`)
    for (const pkg of group) lines.push(`  ${pkg.name} ${pkg.version}`)
  }
  lines.push('', END)
  return lines.join('\n')
}

/** Installed shipped packages that carry their own NOTICE file. */
function packagesWithUpstreamNotice(packages: ShippedPackage[]): string[] {
  const found: string[] = []
  for (const pkg of packages) {
    const dir = join(ROOT, pkg.path)
    if (!existsSync(dir)) continue
    if (readdirSync(dir).some((file) => file.toUpperCase().startsWith('NOTICE'))) found.push(pkg.name)
  }
  return found
}

/** NOTICE with the generated block replaced; null when the markers are missing. */
export function replaceGenerated(notice: string, generated: string): string | null {
  const begin = notice.indexOf(BEGIN)
  const end = notice.indexOf(END)
  if (begin === -1 || end === -1 || end < begin) return null
  return notice.slice(0, begin) + generated + notice.slice(end + END.length)
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const current = readFileSync(NOTICE_PATH, 'utf8')
  const lock = JSON.parse(readFileSync(LOCKFILE_PATH, 'utf8')) as Lockfile
  const { packages, errors } = collectShippedPackages(lock)
  const handWritten = current.slice(0, Math.max(current.indexOf(BEGIN), 0))
  for (const name of packagesWithUpstreamNotice(packages)) {
    if (!handWritten.includes(name)) {
      errors.push(`${name} ships a NOTICE file: carry its text into the hand-written part of NOTICE under its name`)
    }
  }
  const next = replaceGenerated(current, renderGenerated(packages))
  if (next === null) errors.push(`NOTICE is missing the "${BEGIN}" / "${END}" markers`)
  if (errors.length > 0 || next === null) {
    for (const error of errors) console.error(error)
    process.exit(1)
  }

  if (checkOnly) {
    if (next !== current) {
      console.error('NOTICE is stale: run `npm run notice:generate` and commit the result')
      process.exit(1)
    }
    console.log(`NOTICE is up to date (${packages.length} shipped packages)`)
    return
  }
  writeFileSync(NOTICE_PATH, next)
  console.log(`NOTICE regenerated (${packages.length} shipped packages)`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
