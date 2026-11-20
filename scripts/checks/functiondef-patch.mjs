#!/usr/bin/env node
/**
 * Guard: a migration that changes a function by patching its installed
 * definition instead of stating it.
 *
 * 19 migrations (20260703180000 through 20261011140000) rewrote function
 * bodies by reading pg_get_functiondef(), running replace() on fragments of
 * it and executing the result. Each one refused a body it did not recognise,
 * so none was unsafe on its own, but the function that runs then existed in
 * no file: 24 functions could only be read by replaying an original CREATE
 * plus a chain of string edits, a review saw only the fragments, and every
 * later patch had to match text nobody could grep for. Migration
 * 20261012100100_restate_patched_functions put 20 of them back in the repo as
 * full definitions; 20261011135800 had already restated insert_bank_transaction
 * in full, and the other three are being dropped.
 *
 * The rule: no migration outside the frozen file set in
 * antipatterns-baseline.json (functiondefPatch) calls pg_get_functiondef(),
 * wherever the call stands (top level, a DO block, a function body, an
 * EXECUTE string). Comments do not count: they are blanked first, including
 * the comments inside dollar-quoted bodies. To change a function, copy its
 * newest full definition into the migration as CREATE OR REPLACE FUNCTION and
 * edit it there. A read-only check that only needs to know whether a body
 * changed hashes pg_proc.prosrc (md5(p.prosrc)) instead of reading the
 * definition.
 *
 * The baseline is a frozen set like tableWithoutGrant: migration files are
 * immutable, so it never shrinks, and --update never adds a new file to it.
 */

import fs from 'node:fs'
import path from 'node:path'

const CALL_RE = /\bpg_get_functiondef\s*\(/gi

/** A run of characters that cannot start a comment, literal or quoted identifier. */
const PLAIN_RUN = /[^-/'$"]+/y

const blank = (s) => s.replace(/[^\n]/g, ' ')

/**
 * The SQL with every comment replaced by spaces (newlines and offsets kept, so
 * line numbers survive). String literals and quoted identifiers are kept as
 * they are and skipped over, so a `--` inside one is not a comment. A
 * dollar-quoted body (DO block, function body) is plpgsql or SQL with the same
 * comment syntax, so its comments are blanked too.
 */
export function stripSqlComments(sql) {
  const parts = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      parts.push(blank(sql.slice(i, stop)))
      i = stop
    } else if (ch === '/' && next === '*') {
      // Postgres block comments nest.
      let depth = 1
      let j = i + 2
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      parts.push(blank(sql.slice(i, j)))
      i = j
    } else if (ch === "'") {
      // '' is an escaped quote; E'' strings may also escape with a backslash.
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '')
      let j = i + 1
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") break
        else j++
      }
      parts.push(sql.slice(i, j + 1))
      i = j + 1
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1)
      const stop = end === -1 ? sql.length : end + 1
      parts.push(sql.slice(i, stop))
      i = stop
    } else if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (tag && !/\w/.test(sql[i - 1] ?? '')) {
        const bodyStart = i + tag[0].length
        const close = sql.indexOf(tag[0], bodyStart)
        const bodyEnd = close === -1 ? sql.length : close
        parts.push(tag[0], stripSqlComments(sql.slice(bodyStart, bodyEnd)))
        if (close !== -1) parts.push(tag[0])
        i = close === -1 ? sql.length : close + tag[0].length
      } else {
        parts.push(ch)
        i++
      }
    } else {
      PLAIN_RUN.lastIndex = i + 1
      const run = PLAIN_RUN.exec(sql)
      const stop = run ? i + 1 + run[0].length : i + 1
      parts.push(sql.slice(i, stop))
      i = stop
    }
  }
  return parts.join('')
}

/** 1-based line numbers of every pg_get_functiondef( call outside a comment. */
export function functiondefCallLines(sql) {
  const code = stripSqlComments(sql)
  const lines = []
  for (const m of code.matchAll(CALL_RE)) {
    lines.push(code.slice(0, m.index).split('\n').length)
  }
  return lines
}

/** Every call across supabase/migrations, in filename (= apply) order. */
export function findFunctiondefPatches(root) {
  const dir = path.join(root, 'supabase', 'migrations')
  let files
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  } catch {
    return []
  }
  const findings = []
  for (const file of files) {
    for (const line of functiondefCallLines(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      findings.push({ file: `supabase/migrations/${file}`, line })
    }
  }
  return findings
}

/** The guard's explanation, printed under the offending lines. */
export const FUNCTIONDEF_PATCH_HINT = [
  'A function patched through pg_get_functiondef + replace() exists in no file: the next reader',
  'has to replay the chain of string edits to know what runs. Copy the newest full definition',
  '(git grep -l "FUNCTION public.<name>(" -- supabase/migrations | sort | tail -1) into the',
  'migration as CREATE OR REPLACE FUNCTION and edit it there. A read-only check that only needs',
  'to know whether a body changed should hash pg_proc.prosrc (md5(p.prosrc)) instead.',
]
