#!/usr/bin/env node
/**
 * Guard: a PostgREST read with `.limit(N)` where N is above one page.
 *
 * PostgREST's max-rows setting caps every response at 1000 rows and says
 * nothing when it does: `.limit(5000)` returns the first 1000 rows, no error,
 * no count. A cap written as 2000, 5000 or 20000 therefore reads as a generous
 * safety bound in the code and behaves as a silent 1000 in production. The
 * Arkiv graph, its facts and lint, the counterparty resolver and the pärm's
 * reconciliation attachments all shipped that shape (2026-10): sums, counts
 * and duplicate checks computed over whichever 1000 rows came back first, and
 * the graph's "truncated" flag, which compared against the written cap, never
 * fired.
 *
 * Flagged: `.limit(<number>)` above 1000, and `.limit(<NAME>)` where the same
 * file declares `const NAME = <number>` above 1000. Page with fetchAllRows
 * (lib/supabase/fetch-all.ts; its `maxRows` option keeps a deliberate cap) or
 * read an aggregate instead. A deliberate sample stays at `.limit(1000)` or
 * below, with a comment saying it is a sample.
 *
 * LIMIT_ABOVE_PAGE_ALLOWED holds the call sites that predate the guard and
 * were outside the fix that introduced it. It may only shrink.
 */

import fs from 'node:fs'
import path from 'node:path'

export const PAGE_SIZE = 1000

export const LIMIT_ABOVE_PAGE_ALLOWED = new Set([
  // Store facet for the filter dropdown: a store list, read off order rows.
  'app/api/webshop-orders/route.ts',
  // Agent composer magnitude rollups over a year of transactions.
  'lib/agent/composer/inputs.ts',
])

const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])

// The argument is either a numeric literal (digits, optional `_` separators)
// or a bare identifier, followed by the closing paren.
const LIMIT_CALL_RE = /\.limit\(\s*(?:(\d[\d_]*)|([A-Za-z_$][\w$]*))\s*\)/g
const numberValue = (literal) => Number(literal.replace(/_/g, ''))

function constantValue(source, name) {
  const escaped = name.replace(/\$/g, '\\$')
  const m = source.match(new RegExp(String.raw`\bconst\s+${escaped}\s*(?::\s*number\s*)?=\s*(\d[\d_]*)\s*[;\n]`))
  return m ? numberValue(m[1]) : null
}

/** Every `.limit()` above one page in one file's source: [{ line, limit, arg }]. */
export function findLimitsAbovePageInSource(source) {
  const out = []
  LIMIT_CALL_RE.lastIndex = 0
  let m
  while ((m = LIMIT_CALL_RE.exec(source)) !== null) {
    const value = m[1] !== undefined ? numberValue(m[1]) : constantValue(source, m[2])
    if (value === null || value <= PAGE_SIZE) continue
    const line = source.slice(0, m.index).split('\n').length
    out.push({ line, limit: value, arg: m[1] ?? m[2] })
  }
  return out
}

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, out)
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

/** Every offending call site under sourceRoot: [{ file, line, limit, arg }], file relative to sourceRoot. */
export function findLimitsAbovePage(sourceRoot) {
  const findings = []
  for (const file of walk(sourceRoot)) {
    const rel = path.relative(sourceRoot, file).split(path.sep).join('/')
    for (const f of findLimitsAbovePageInSource(fs.readFileSync(file, 'utf8'))) findings.push({ file: rel, ...f })
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}
