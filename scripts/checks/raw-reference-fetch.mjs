#!/usr/bin/env node
/**
 * Guard: reference data fetched outside lib/reference-data.
 *
 * Fiscal periods, company settings, the chart of accounts, cash accounts,
 * dimensions, booking templates, customers, suppliers and articles are
 * session-cached behind the hooks in lib/reference-data/hooks.ts (seeded
 * from the dashboard layout, invalidated after writes). Before that layer
 * existed the same lists were fetched raw from 47 / 27 / 14 / 8 / 12 / 5
 * independent call sites, uncached, on every mount and every dialog open,
 * which is what a customer described as "it takes time before all fields
 * load when clicking around" (2026-08-26). This check keeps that number
 * going down: an existing raw call site is grandfathered in the baseline,
 * a NEW one fails CI.
 *
 * Two shapes are flagged:
 *   1. A GET-shaped `fetch('/api/<reference path>')` anywhere under app/,
 *      components/, extensions/ or lib/ (a relative URL is client code by
 *      definition). Writes (`method: 'POST' | 'PUT' | ...`) are fine: they
 *      go through the API and then call invalidateReferenceData().
 *   2. A browser-side `.from('<reference table>').select(` in a file that
 *      carries the 'use client' directive. Server code reading those tables
 *      is legitimate and is not scanned.
 *
 * Sanctioned (RAW_REFERENCE_SANCTIONED): the fetchers themselves, the
 * pre-existing SWR settings hook, and the static BAS catalog loader (a
 * different, module-cached data set).
 */

import fs from 'node:fs'
import path from 'node:path'

export const REFERENCE_API_PATHS = [
  'bookkeeping/fiscal-periods',
  'settings/booking-templates',
  'settings',
  'bookkeeping/accounts',
  'cash-accounts',
  'dimensions',
  'customers',
  'suppliers',
  'articles',
]

export const REFERENCE_TABLES = [
  'fiscal_periods',
  'company_settings',
  'chart_of_accounts',
  'cash_accounts',
]

export const RAW_REFERENCE_SANCTIONED = new Set([
  'lib/reference-data/fetchers.ts',
  'components/settings/useSettings.ts',
  'lib/bookkeeping/bas-catalog-client.ts',
])

const SCAN_DIRS = ['app/(dashboard)', 'components', 'extensions', 'lib']
const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

// fetch(`/api/settings`), fetch('/api/settings?x=1'), fetch('/api/settings', { signal })
// The init object may nest one level ({ headers: { ... } }); its text is
// captured so a write method can be excluded. Trailing commas (prettier's
// multi-line call style) are tolerated before the closing paren.
const API_FETCH_RE = new RegExp(
  String.raw`fetch\(\s*[\x60'"]/api/(?:${REFERENCE_API_PATHS.map(escape).join('|')})(?:\?[^\x60'"]*)?[\x60'"]\s*(?:,?\s*\)|,\s*(\{(?:[^{}]|\{[^{}]*\})*\})\s*,?\s*\))`,
  'g',
)
const WRITE_METHOD_RE = /method\s*:\s*[\x60'"](?!GET\b)/i

const TABLE_SELECT_RE = new RegExp(
  String.raw`\.from\(\s*['"](?:${REFERENCE_TABLES.map(escape).join('|')})['"]\s*\)\s*\.\s*select\(`,
  'g',
)

const USE_CLIENT_RE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/

export function isClientSource(source) {
  return USE_CLIENT_RE.test(source)
}

/**
 * Findings for one file's source: `{ kind: 'api' | 'table', index }`.
 * Exported for the unit test; the file-level scan below uses it.
 */
export function findRawReferenceFetchesInSource(source) {
  const findings = []
  for (const match of source.matchAll(API_FETCH_RE)) {
    const init = match[1]
    if (init && WRITE_METHOD_RE.test(init)) continue
    findings.push({ kind: 'api', index: match.index ?? 0 })
  }
  if (isClientSource(source)) {
    for (const match of source.matchAll(TABLE_SELECT_RE)) {
      findings.push({ kind: 'table', index: match.index ?? 0 })
    }
  }
  return findings
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
}

/** Sorted repo-relative paths of files with at least one raw reference fetch. */
export function findRawReferenceFetches(root) {
  const files = []
  for (const dir of SCAN_DIRS) walk(path.join(root, dir), files)
  const offenders = []
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    if (rel.startsWith('app/api/') || RAW_REFERENCE_SANCTIONED.has(rel)) continue
    const source = fs.readFileSync(file, 'utf8')
    if (findRawReferenceFetchesInSource(source).length) offenders.push(rel)
  }
  return [...new Set(offenders)].sort()
}
