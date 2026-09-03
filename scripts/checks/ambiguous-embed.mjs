#!/usr/bin/env node
/**
 * Guard: an un-hinted PostgREST embed between two tables that share more than
 * one foreign key.
 *
 * PostgREST resolves `.from('a').select('b(...)')` by looking for THE foreign
 * key between a and b, in either direction. When several exist it refuses the
 * request with PGRST201 ("Could not embed because more than one relationship
 * was found") instead of picking one. The embed must then name the
 * relationship, and PostgREST accepts two spellings for that:
 *
 *   b!a_b_id_fkey(...)   the constraint name
 *   b!b_column_id(...)   the foreign key COLUMN name
 *
 * Both are in use here (`fiscal_periods!journal_entries_fiscal_period_id_fkey`
 * in lib/transactions/inbox-underlag.ts, `journal_entries!opening_balance_entry_id`
 * in lib/import/opening-balance/cascade.ts), so either counts as hinted.
 * `!inner` / `!left` are join modifiers, not hints, and do not disambiguate.
 *
 * Why a static guard is the only thing that can catch this: the failure is a
 * runtime PostgREST decision. Unit tests mock the Supabase client and hand back
 * an already-joined row shape, so they never resolve a relationship; pg-real
 * tests talk to Postgres directly and never go through PostgREST at all. The
 * class has now been reasoned about three times and shipped broken twice, both
 * on journal_entries -> fiscal_periods, ambiguous since migration
 * 20240101000019 added fiscal_periods.closing_entry_id and
 * fiscal_periods.opening_balance_entry_id:
 *   - lib/transactions/inbox-underlag.ts (fixed 2026-08-31, PR #2022): the
 *     nightly underlag cron read an empty locked-set and then tried to link
 *     documents into locked periods, ~60 trigger rejections a night.
 *   - lib/core/documents/supplier-invoice-underlag.ts (fixed 2026-09-01): the
 *     error was dropped on the floor, so supplier-invoice underlag never once
 *     anchored in production and users kept seeing "Underlag saknas" on a
 *     verifikat that plainly showed the invoice PDF.
 *
 * The ambiguous pairs are DERIVED from supabase/migrations/*.sql rather than
 * hardcoded, so a migration that adds a second foreign key between two tables
 * arms the guard for that pair on the same commit. To check the derivation
 * against the live schema:
 *
 *   select least(s.relname, t.relname) a, greatest(s.relname, t.relname) b, count(*)
 *   from pg_constraint c
 *   join pg_class s on s.oid = c.conrelid
 *   join pg_class t on t.oid = c.confrelid
 *   join pg_namespace ns on ns.oid = s.relnamespace and ns.nspname = 'public'
 *   join pg_namespace nt on nt.oid = t.relnamespace and nt.nspname = 'public'
 *   where c.contype = 'f'
 *   group by 1, 2 having count(*) > 1 order by 1, 2;
 *
 * On 2026-09-03 that returned the same 17 pairs the parser derives. Composite
 * foreign keys count: until 2026-09-03 the parser only read single-column
 * `FOREIGN KEY (col)`, so the composite (sales_order_id, company_id) guard in
 * 20260902180000_sales_orders_hardening.sql was invisible to it and the
 * un-hinted `items:sales_order_items(*)` embeds shipped, taking every
 * kundorder list and detail load down with PGRST201 (fixed 2026-09-03).
 *
 * No baseline: the count is 0, any new un-hinted ambiguous embed is a hard
 * failure.
 */

import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const SCAN_DIRS = ['app', 'components', 'contexts', 'extensions', 'lib', 'scripts']
const IGNORE_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'coverage',
  '__tests__',
])

/** Undirected pair key: PostgREST considers foreign keys in both directions. */
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)

const stripSql = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const normIdent = (t) => t.replace(/"/g, '').replace(/^public\./i, '').toLowerCase()

/**
 * Foreign keys declared across the migration history, as a map of
 * `<table>.<column>` -> target table. Keying on the column (rather than
 * counting statements) makes the repeated idempotent re-adds this repo is full
 * of collapse onto one edge, which is what Postgres ends up with.
 *
 * Only the shapes that actually appear in supabase/migrations are parsed:
 * inline `REFERENCES` in a CREATE TABLE column, table-level
 * `FOREIGN KEY (col) REFERENCES`, `ADD COLUMN ... REFERENCES`, and
 * `ADD CONSTRAINT ... FOREIGN KEY (col) REFERENCES`. Drops are honoured so a
 * relationship that was removed again does not keep a pair armed forever.
 */
export function deriveForeignKeys(migrationsDir) {
  const edges = new Map()
  // Constraint name -> edge key, so DROP CONSTRAINT can find what it removes.
  // Unnamed foreign keys get Postgres's default `<table>_<column>_fkey`.
  const byConstraint = new Map()

  // `column` is one column or a composite list ("sales_order_id, company_id").
  // A composite foreign key is its own edge, distinct from a single-column one
  // on its leading column: PostgREST counts both, which is what made
  // sales_order_items -> sales_orders ambiguous (migration 20260902180000)
  // while this parser, then single-column only, still derived one edge.
  const addEdge = (table, column, target, constraintName) => {
    const columns = column.split(',').map((c) => normIdent(c.trim())).filter(Boolean)
    const key = `${table}.${columns.join(',')}`
    edges.set(key, target)
    byConstraint.set(constraintName ?? `${table}_${columns.join('_')}_fkey`, key)
  }

  let files
  try {
    files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  } catch {
    return edges
  }

  for (const file of files) {
    const sql = stripSql(fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
    for (const raw of sql.split(';')) {
      const stmt = raw.trim()
      if (!stmt) continue

      const created = stmt.match(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w".]+)\s*\(/i)
      const altered = stmt.match(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w".]+)/i)
      const dropped = stmt.match(/drop\s+table\s+(?:if\s+exists\s+)?([\w".]+)/i)

      if (created) {
        const table = normIdent(created[1])
        // `col uuid references public.other(id)` inside the column list.
        for (const m of stmt.matchAll(/(?:^|,)\s*([\w"]+)\s+[^,()]*?references\s+([\w".]+)/gis)) {
          addEdge(table, normIdent(m[1]), normIdent(m[2]))
        }
        // `foreign key (col[, col]) references public.other(id[, id])` as a
        // table constraint, named or not.
        for (const m of stmt.matchAll(
          /(?:constraint\s+([\w"]+)\s+)?foreign\s+key\s*\(\s*([\w",\s]+?)\s*\)\s*references\s+([\w".]+)/gi,
        )) {
          addEdge(table, m[2], normIdent(m[3]), m[1] && normIdent(m[1]))
        }
        continue
      }

      if (altered) {
        const table = normIdent(altered[1])
        for (const m of stmt.matchAll(
          /(?:add\s+constraint\s+([\w"]+)\s+)?foreign\s+key\s*\(\s*([\w",\s]+?)\s*\)\s*references\s+([\w".]+)/gi,
        )) {
          addEdge(table, m[2], normIdent(m[3]), m[1] && normIdent(m[1]))
        }
        for (const m of stmt.matchAll(
          /add\s+column\s+(?:if\s+not\s+exists\s+)?([\w"]+)\s+[^,;]*?references\s+([\w".]+)/gi,
        )) {
          addEdge(table, normIdent(m[1]), normIdent(m[2]))
        }
        for (const m of stmt.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?([\w"]+)/gi)) {
          // Postgres drops every foreign key the column takes part in, so a
          // composite edge listing it goes too, not only the single-column key.
          const column = normIdent(m[1])
          for (const key of [...edges.keys()]) {
            if (!key.startsWith(`${table}.`)) continue
            if (!key.slice(table.length + 1).split(',').includes(column)) continue
            edges.delete(key)
            for (const [name, edge] of [...byConstraint]) {
              if (edge === key) byConstraint.delete(name)
            }
          }
        }
        for (const m of stmt.matchAll(/drop\s+constraint\s+(?:if\s+exists\s+)?([\w"]+)/gi)) {
          const edge = byConstraint.get(normIdent(m[1]))
          if (edge) edges.delete(edge)
        }
        continue
      }

      if (dropped) {
        const table = normIdent(dropped[1])
        for (const [key, target] of [...edges]) {
          if (key.startsWith(`${table}.`) || target === table) edges.delete(key)
        }
      }
    }
  }

  return edges
}

/** Table pairs joined by more than one foreign key, as `pairKey` strings. */
export function deriveAmbiguousPairs(migrationsDir) {
  const counts = new Map()
  for (const [key, target] of deriveForeignKeys(migrationsDir)) {
    const source = key.slice(0, key.indexOf('.'))
    // auth.users and other non-public tables are never embedded through PostgREST here.
    if (source.includes('.') || target.includes('.')) continue
    const pair = pairKey(source, target)
    counts.set(pair, (counts.get(pair) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([pair]) => pair))
}

const HEAD_CHARS = /[\w!]/
// An embed head is preceded by the start of the select string, a separator, or
// the `:` of an alias. `fiscal_period:fiscal_periods(...)` is the shape both
// production bugs were written in, so `:` MUST be a delimiter here.
const HEAD_DELIMITERS = new Set([',', ':', '(', ' ', '\t', '\n', '\r'])
const JOIN_MODIFIERS = new Set(['inner', 'left'])

/**
 * The embed head immediately before `index` (which points at its `(`), or null
 * when the paren does not open an embed.
 */
function headBefore(select, index) {
  let end = index
  while (end > 0 && /\s/.test(select[end - 1])) end--
  let start = end
  while (start > 0 && HEAD_CHARS.test(select[start - 1])) start--
  if (start === end) return null
  if (start > 0 && !HEAD_DELIMITERS.has(select[start - 1])) return null

  const [target, ...modifiers] = select.slice(start, end).split('!')
  if (!target) return null
  return { target: target.toLowerCase(), hinted: modifiers.some((m) => !JOIN_MODIFIERS.has(m)) }
}

/**
 * Every embed in one select string, paired with the table it is embedded FROM.
 * Nested embeds resolve against their enclosing embed, not against the root.
 */
export function parseEmbeds(select, rootTable) {
  const embeds = []
  const stack = [rootTable]
  for (let i = 0; i < select.length; i++) {
    if (select[i] === '(') {
      const head = headBefore(select, i)
      const from = stack[stack.length - 1]
      if (head && from) embeds.push({ from, target: head.target, hinted: head.hinted })
      stack.push(head ? head.target : null)
    } else if (select[i] === ')') {
      if (stack.length > 1) stack.pop()
    }
  }
  return embeds
}

/**
 * The table a `.select()` call reads from, resolved by walking ITS OWN method
 * chain back to `.from()`. Never the nearest preceding `.from()` in the file:
 * `.from('journal_entry_lines').select('... journal_entries!inner(...)')` sits
 * a few lines below an unrelated `.from('journal_entries')` in
 * scripts/seed-demo-account.ts, and pairing by proximity flags it wrongly.
 */
function fromTableOfChain(selectCall) {
  let node = selectCall.expression.expression
  while (node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'from') {
        const arg = node.arguments[0]
        return arg && ts.isStringLiteralLike(arg) ? arg.text.toLowerCase() : null
      }
      node = ts.isPropertyAccessExpression(callee) ? callee.expression : callee
      continue
    }
    if (ts.isPropertyAccessExpression(node)) {
      node = node.expression
      continue
    }
    return null
  }
  return null
}

/**
 * Un-hinted embeds of an ambiguous pair in one file's source, as
 * `{ line, from, target }`. Exported for the unit test.
 */
export function findAmbiguousEmbedsInSource(sourceText, fileName, ambiguousPairs) {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const findings = []

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'select' &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const from = fromTableOfChain(node)
      if (from) {
        for (const embed of parseEmbeds(node.arguments[0].text, from)) {
          if (embed.hinted) continue
          if (!ambiguousPairs.has(pairKey(embed.from, embed.target))) continue
          const pos = source.getLineAndCharacterOfPosition(node.getStart(source))
          findings.push({ line: pos.line + 1, from: embed.from, target: embed.target })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

function walk(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Findings across the repo, as `{ where, from, target }`, sorted. */
export function findAmbiguousEmbeds(root) {
  const ambiguousPairs = deriveAmbiguousPairs(path.join(root, 'supabase', 'migrations'))
  if (ambiguousPairs.size === 0) return []

  const findings = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const sourceText = fs.readFileSync(file, 'utf8')
      if (!sourceText.includes('.select(')) continue
      const relPath = path.relative(root, file).split(path.sep).join('/')
      for (const finding of findAmbiguousEmbedsInSource(sourceText, file, ambiguousPairs)) {
        findings.push({
          where: `${relPath}:${finding.line}`,
          from: finding.from,
          target: finding.target,
        })
      }
    }
  }
  return findings.sort((a, b) => a.where.localeCompare(b.where))
}
