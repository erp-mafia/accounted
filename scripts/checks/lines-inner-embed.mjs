#!/usr/bin/env node
/**
 * Guard: a journal_entry_lines read filtered through a `journal_entries!inner`
 * embed.
 *
 * `.from('journal_entry_lines').select('..., journal_entries!inner(...)')`
 * with the tenant filter on the embed (`.eq('journal_entries.company_id', x)`)
 * reads naturally, but PostgREST compiles the embed into an INNER JOIN
 * LATERAL with a LIMIT inside, which Postgres cannot reorder. The plan has
 * to start from the line side: journal_entry_lines has no company_id
 * (7 M rows across every tenant in production), so the read walks every
 * tenant's lines, or every line on an account, and probes journal_entries
 * once per line. It shipped and timed out (8 s statement timeout) over and
 * over: the reports until lib/bookkeeping/entry-lines.ts, the onboarding
 * findings (5 625 calls at a mean of 4.2 s until 2026-09-21), the MCP
 * journal query, and the ROT/RUT payout picker (a debit filter with no index:
 * a sequential scan of every line, 2026-10-23).
 *
 * Read entry first instead: fetchEntryLines (or fetchLinesByEntryIds) in
 * lib/bookkeeping/entry-lines.ts filters journal_entries on its own indexed
 * columns and then reads the lines by journal_entry_id, or call a ledger RPC.
 *
 * Flagged: a `.select()` string that embeds `journal_entries!inner` (aliased
 * or not) in a chain that starts at `.from('journal_entry_lines')`. A
 * journal_entries embed from another table (kontantmetod_cutoff_entries,
 * ...) starts from that table's own rows and is not this shape.
 *
 * LINES_INNER_EMBED_ALLOWED holds the call sites that predate the guard. It
 * may only shrink.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * The Arkiv brain's loaders, gated off in production (ARKIV_BRAIN_COMPANY_IDS
 * unset, no traffic on 2026-10-26). Move them to fetchEntryLines or the
 * ledger_account_days readers before the brain rolls out.
 * @type {Set<string>}
 */
export const LINES_INNER_EMBED_ALLOWED = new Set([
  'lib/arkiv/facts/derive-company.ts',
  'lib/arkiv/graph/build.ts',
  'lib/arkiv/lint/run.ts',
])

const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])

const FROM_RE = /\.from\(\s*(['"`])([a-z_]+)\1\s*\)/g
const SELECT_RE = /\.select\(\s*(['"`])([\s\S]*?)\1/
const INNER_EMBED_RE = /\bjournal_entries\s*!\s*inner\s*\(/

/**
 * Every journal_entry_lines chain in one file's source whose select embeds
 * journal_entries!inner, in source order. The chain runs from its `.from()`
 * to the next `.from()` (or the end of the file); its first `.select()` is
 * the one checked.
 * @param {string} source
 * @returns {Array<{ line: number, select: string }>}
 */
export function findLinesInnerEmbedsInSource(source) {
  const lineOf = (index) => source.slice(0, index).split('\n').length
  const froms = [...source.matchAll(FROM_RE)]
  const out = []
  froms.forEach((m, i) => {
    if (m[2] !== 'journal_entry_lines') return
    const end = i + 1 < froms.length ? froms[i + 1].index : source.length
    const chain = source.slice(m.index, end)
    const select = chain.match(SELECT_RE)
    if (!select || !INNER_EMBED_RE.test(select[2])) return
    out.push({ line: lineOf(m.index), select: select[2].replace(/\s+/g, ' ').trim() })
  })
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

/** Every offending read under sourceRoot: [{ file, line, select }], file relative to sourceRoot. */
export function findLinesInnerEmbeds(sourceRoot) {
  const findings = []
  for (const file of walk(sourceRoot)) {
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes('journal_entry_lines')) continue
    const rel = path.relative(sourceRoot, file).split(path.sep).join('/')
    for (const f of findLinesInnerEmbedsInSource(source)) findings.push({ file: rel, ...f })
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}
