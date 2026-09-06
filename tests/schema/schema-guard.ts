/**
 * Static phantom-column detector for Supabase query builders.
 *
 * WHY THIS EXISTS
 * ---------------
 * `createQueuedMockSupabase()` returns a chainable stub: every `.eq()`,
 * `.select()` and `.order()` resolves regardless of whether the column exists.
 * A green unit test therefore proves nothing about the column names in a query.
 * That blind spot shipped a broken article delete for ten days, plus sixteen
 * further phantom-column sites, two phantom CHECK-constraint values
 * (`source_type = 'transaction'` when the real value is `bank_transaction`) and
 * one `onConflict` naming a dropped unique constraint (42P10 on every call).
 *
 * This module reads the two things that cannot lie to each other:
 *   1. the schema, replayed from `supabase/migrations/*.sql` in version order;
 *   2. every Supabase query builder chain in the source, via the TypeScript AST.
 * It then asserts that each column named in a query exists on the table it is
 * named against. See `tests/schema/no-phantom-columns.test.ts`.
 *
 * GROUND TRUTH: the migration files, not a live database and not a checked-in
 * snapshot. The migrations are already the repo's contract with prod (CLAUDE.md:
 * "never leave a remote DB ahead of the repo"), replaying them costs ~200ms, and
 * there is no snapshot artifact that can go stale. The cost is parser fidelity:
 * anything this file fails to parse must degrade to "unresolved", never to a
 * false accusation. Every classification below is chosen in that direction.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// ---------------------------------------------------------------------------
// Schema model
// ---------------------------------------------------------------------------

export interface TableModel {
  name: string
  columns: Set<string>
  /** column -> referenced table, used to resolve `alias:fk_column(...)` embeds. */
  fkTargets: Map<string, string>
  /** constraint name -> closed value set, from `CHECK (col IN (...))` or an enum type. */
  checks: Map<string, { column: string; values: Set<string> }>
  /** unique/PK column sets, sorted and joined by ',', for `onConflict` validation. */
  uniqueSets: Set<string>
  /**
   * Named UNIQUE/PK constraint -> its unique-set key, so `DROP CONSTRAINT` can
   * retract the set. Only NAMED constraints are tracked: a column-level bare
   * `UNIQUE` has no name in the DDL, so its set cannot be retracted by name
   * and stays in uniqueSets (a missed retraction there loses strictness, it
   * never invents an accusation).
   */
  uniqueConstraintKeys: Map<string, string>
}

export interface SchemaModel {
  tables: Map<string, TableModel>
  /** Views and materialised views: valid `.from()` targets whose columns we do not model. */
  views: Set<string>
  /** index name -> { table, key } so DROP INDEX can retract a unique set. */
  uniqueIndexes: Map<string, { table: string; key: string }>
}

const CONSTRAINT_LEAD = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'FOREIGN',
  'CHECK',
  'EXCLUDE',
  'LIKE',
  'DEFERRABLE',
])

function emptyTable(name: string): TableModel {
  return {
    name,
    columns: new Set(),
    fkTargets: new Map(),
    checks: new Map(),
    uniqueSets: new Set(),
    uniqueConstraintKeys: new Map(),
  }
}

/**
 * Split a SQL file into statements. Quote-, comment- and dollar-quote-aware, so
 * a `CREATE TABLE` inside a `$$ ... $$` function body never leaks into the model
 * and a `;` inside a string literal never splits a statement. Comments are
 * dropped; string and identifier literals are preserved (CHECK lists need them).
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      buf += ' '
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      buf += ' '
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === ch && sql[j + 1] === ch) {
          j += 2
          continue
        }
        if (sql[j] === ch) {
          j++
          break
        }
        j++
      }
      buf += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === '$') {
      const tag = /^\$\$|^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        const stop = end === -1 ? n : end + tag.length
        buf += sql.slice(i, stop)
        i = stop
        continue
      }
    }
    if (ch === ';') {
      out.push(buf)
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  out.push(buf)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** Split on commas that sit at paren/bracket depth 0, outside quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let buf = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === ch && text[j + 1] === ch) {
          j += 2
          continue
        }
        if (text[j] === ch) {
          j++
          break
        }
        j++
      }
      buf += text.slice(i, j)
      i = j
      continue
    }
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      parts.push(buf)
      buf = ''
      i++
      continue
    }
    buf += ch
    i++
  }
  parts.push(buf)
  return parts.map((p) => p.trim()).filter(Boolean)
}

/** Content of the parenthesised group that starts at or after `from`. */
function balancedParens(text: string, from: number): { body: string; end: number } | null {
  const open = text.indexOf('(', from)
  if (open === -1) return null
  let depth = 0
  let i = open
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === ch && text[j + 1] === ch) {
          j += 2
          continue
        }
        if (text[j] === ch) {
          j++
          break
        }
        j++
      }
      i = j
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 }
    }
    i++
  }
  return null
}

const ident = (raw: string): string => raw.replace(/^"|"$/g, '')

/**
 * Extract a CLOSED value set from a CHECK expression, or null when the
 * expression is anything more complex than `col IN (...)` / `col = ANY(ARRAY[])`
 * (optionally guarded by `col IS NULL OR`). Anything else stays unmodelled, so a
 * compound CHECK never produces a false "phantom value" accusation.
 */
function parseClosedCheck(
  expr: string
): { column: string; values: Set<string> } | null {
  let s = expr.replace(/\s+/g, ' ').trim()
  while (s.startsWith('(') && balancedParens(s, 0)?.end === s.length) {
    s = s.slice(1, -1).trim()
  }
  // Tolerate a nullability guard on either side of the OR.
  s = s.replace(/^"?\w+"?\s+IS\s+NULL\s+OR\s+/i, '').trim()
  s = s.replace(/\s+OR\s+"?\w+"?\s+IS\s+NULL$/i, '').trim()
  while (s.startsWith('(') && balancedParens(s, 0)?.end === s.length) {
    s = s.slice(1, -1).trim()
  }

  const inMatch = /^"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s*::\s*\w+)?\s+IN\s*\(/i.exec(s)
  const anyMatch = /^"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s*::\s*\w+)?\s*=\s*ANY\s*\(/i.exec(s)
  const m = inMatch ?? anyMatch
  if (!m) return null
  const group = balancedParens(s, m[0].length - 1)
  if (!group || group.end !== s.length) return null

  let list = group.body.trim()
  if (anyMatch) {
    const arr = /^ARRAY\s*\[([\s\S]*)\]$/i.exec(list)
    if (!arr) return null
    list = arr[1]
  }
  // The list must be nothing but string literals (casts allowed): a subquery or
  // a column reference means the set is not closed.
  const values = new Set<string>()
  for (const item of splitTopLevel(list)) {
    const lit = /^'((?:[^']|'')*)'(?:\s*::\s*[\w .]+)?$/.exec(item.trim())
    if (!lit) return null
    values.add(lit[1].replace(/''/g, "'"))
  }
  if (values.size === 0) return null
  return { column: m[1], values }
}

function recordUnique(table: TableModel, columns: string[], constraintName?: string | null): void {
  if (columns.length === 0) return
  const key = [...columns].sort().join(',')
  table.uniqueSets.add(key)
  // Remember the name so `ALTER TABLE ... DROP CONSTRAINT <name>` can retract
  // the set again. Unnamed (column-level) uniques have nothing to key on.
  if (constraintName) table.uniqueConstraintKeys.set(constraintName, key)
}

function parseColumnList(body: string): string[] {
  return splitTopLevel(body)
    .map((c) => ident(c.trim().replace(/\s+(ASC|DESC)$/i, '')))
    .filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c))
}

/** One `CREATE TABLE` body item: either a column definition or a constraint. */
function applyTableItem(
  table: TableModel,
  item: string,
  enums: Map<string, Set<string>>
): void {
  const lead = /^"?([A-Za-z_][A-Za-z0-9_$]*)"?/.exec(item.trim())
  if (!lead) return
  const upper = lead[1].toUpperCase()

  if (CONSTRAINT_LEAD.has(upper)) {
    let rest = item.trim()
    let name: string | null = null
    const named = /^CONSTRAINT\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+/i.exec(rest)
    if (named) {
      name = named[1]
      rest = rest.slice(named[0].length).trim()
    }
    if (/^CHECK\s*\(/i.test(rest)) {
      const group = balancedParens(rest, 0)
      if (group) {
        const parsed = parseClosedCheck(group.body)
        if (parsed) {
          table.checks.set(name ?? `${table.name}_${parsed.column}_check`, parsed)
        }
      }
      return
    }
    if (/^UNIQUE\s*\(/i.test(rest) || /^PRIMARY\s+KEY\s*\(/i.test(rest)) {
      const group = balancedParens(rest, 0)
      if (group) recordUnique(table, parseColumnList(group.body), name)
      return
    }
    if (/^FOREIGN\s+KEY\s*\(/i.test(rest)) {
      const group = balancedParens(rest, 0)
      const target = /REFERENCES\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(rest)
      if (group && target) {
        for (const col of parseColumnList(group.body)) {
          table.fkTargets.set(col, target[1])
        }
      }
      return
    }
    return
  }

  const column = ident(lead[1])
  table.columns.add(column)
  const rest = item.trim().slice(lead[0].length).trim()

  const typeName = /^(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(rest)?.[1]
  if (typeName) {
    const enumValues = enums.get(typeName.toLowerCase())
    if (enumValues) {
      table.checks.set(`${table.name}_${column}_enumtype`, {
        column,
        values: new Set(enumValues),
      })
    }
  }

  const ref = /REFERENCES\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(rest)
  if (ref) table.fkTargets.set(column, ref[1])

  const checkAt = rest.search(/\bCHECK\s*\(/i)
  if (checkAt !== -1) {
    const group = balancedParens(rest, checkAt)
    if (group) {
      // A column-level CHECK may omit the column name: `status text CHECK (... IN ...)`
      // always constrains this column, so parseClosedCheck's name wins only when
      // it matches; otherwise we assume the owning column.
      const parsed = parseClosedCheck(group.body)
      if (parsed && parsed.column === column) {
        table.checks.set(`${table.name}_${column}_check`, parsed)
      }
    }
  }

  // Column-level UNIQUE / PRIMARY KEY, but not the word inside a CHECK body.
  const withoutChecks = checkAt === -1 ? rest : rest.slice(0, checkAt)
  if (/\bUNIQUE\b/i.test(withoutChecks) || /\bPRIMARY\s+KEY\b/i.test(withoutChecks)) {
    recordUnique(table, [column])
  }
}

/** Replay every migration in version order into a column/constraint model. */
export function buildSchemaFromMigrations(migrationsDir: string): SchemaModel {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const model: SchemaModel = {
    tables: new Map(),
    views: new Set(),
    uniqueIndexes: new Map(),
  }
  const enums = new Map<string, Set<string>>()

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    for (const stmt of splitStatements(sql)) {
      applyStatement(model, enums, stmt)
    }
  }
  return model
}

function applyStatement(
  model: SchemaModel,
  enums: Map<string, Set<string>>,
  stmt: string
): void {
  const flat = stmt.replace(/\s+/g, ' ').trim()

  const createType = /^CREATE\s+TYPE\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+AS\s+ENUM\s*\(/i.exec(
    flat
  )
  if (createType) {
    const group = balancedParens(flat, createType[0].length - 1)
    if (group) {
      const values = new Set<string>()
      for (const item of splitTopLevel(group.body)) {
        const lit = /^'((?:[^']|'')*)'$/.exec(item.trim())
        if (lit) values.add(lit[1].replace(/''/g, "'"))
      }
      if (values.size) enums.set(createType[1].toLowerCase(), values)
    }
    return
  }

  const createView = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(
    flat
  )
  if (createView) {
    model.views.add(createView[1])
    return
  }

  const dropView = /^DROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?(.+)$/i.exec(flat)
  if (dropView) {
    for (const raw of splitTopLevel(dropView[1].replace(/\s+(CASCADE|RESTRICT)\s*$/i, ''))) {
      model.views.delete(ident(raw.trim().replace(/^public\./i, '')))
    }
    return
  }

  // PostgREST computed column: a function whose only argument is a table's row
  // type is exposed as a virtual column on that table (selectable and
  // orderable), so it joins the table's column set. Multi-argument functions,
  // SETOF/TABLE/trigger returns and non-table argument types all fall through
  // untouched. An argument-less `DROP FUNCTION name` cannot be resolved to a
  // table and is skipped: a missed retraction loses strictness, it never
  // invents an accusation (same trade as unnamed UNIQUE constraints).
  const createFn = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s*\(\s*(?:"?[A-Za-z_][A-Za-z0-9_$]*"?\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s*\)\s*RETURNS\s+(?!SETOF\b|TABLE\s*\(|trigger\b)/i.exec(
    flat
  )
  if (createFn) {
    model.tables.get(createFn[2])?.columns.add(createFn[1])
    return
  }

  const dropFn = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s*\(\s*(?:"?[A-Za-z_][A-Za-z0-9_$]*"?\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s*\)$/i.exec(
    flat
  )
  if (dropFn) {
    model.tables.get(dropFn[2])?.columns.delete(dropFn[1])
    return
  }

  const createTable = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(
    flat
  )
  if (createTable) {
    const name = createTable[1]
    // `CREATE TABLE x AS SELECT ...` has no column list we can read: treat the
    // table as opaque (a view, for our purposes) rather than guessing.
    const group = balancedParens(flat, createTable[0].length)
    if (!group || /\bAS\s+SELECT\b/i.test(flat.slice(createTable[0].length, group.end))) {
      model.views.add(name)
      return
    }
    const table = model.tables.get(name) ?? emptyTable(name)
    model.tables.set(name, table)
    for (const item of splitTopLevel(group.body)) applyTableItem(table, item, enums)
    return
  }

  const dropTable = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(.+)$/i.exec(flat)
  if (dropTable) {
    for (const raw of splitTopLevel(dropTable[1].replace(/\s+(CASCADE|RESTRICT)\s*$/i, ''))) {
      const name = ident(raw.trim().replace(/^public\./i, ''))
      model.tables.delete(name)
      model.views.delete(name)
    }
    return
  }

  const uniqueIndex = /^CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+ON\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(
    flat
  )
  if (uniqueIndex) {
    const table = model.tables.get(uniqueIndex[2])
    const group = balancedParens(flat, uniqueIndex[0].length)
    if (table && group) {
      const cols = parseColumnList(group.body)
      // An expression index (lower(x), coalesce(...)) yields no plain column
      // list; skip rather than invent one.
      if (cols.length === splitTopLevel(group.body).length) {
        const key = [...cols].sort().join(',')
        table.uniqueSets.add(key)
        model.uniqueIndexes.set(uniqueIndex[1], { table: table.name, key })
      }
    }
    return
  }

  const dropIndex = /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(.+)$/i.exec(flat)
  if (dropIndex) {
    for (const raw of splitTopLevel(dropIndex[1].replace(/\s+(CASCADE|RESTRICT)\s*$/i, ''))) {
      const name = ident(raw.trim().replace(/^public\./i, ''))
      const entry = model.uniqueIndexes.get(name)
      if (entry) {
        model.tables.get(entry.table)?.uniqueSets.delete(entry.key)
        model.uniqueIndexes.delete(name)
      }
    }
    return
  }

  const alterTable = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+(.+)$/i.exec(
    flat
  )
  if (alterTable) {
    const table = model.tables.get(alterTable[1])
    if (!table) return
    for (const action of splitTopLevel(alterTable[2])) {
      applyAlterAction(model, table, action, enums)
    }
    return
  }

  if (/^DO\b/i.test(stmt)) {
    applyDoBlockDdl(model, enums, stmt)
    applyDynamicDdl(model, enums, flat)
  }
}

/** Index of the first `ALTER TABLE` outside any quoted region, or -1. */
function findUnquotedAlterTable(text: string): number {
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === ch && text[j + 1] === ch) {
          j += 2
          continue
        }
        if (text[j] === ch) {
          j++
          break
        }
        j++
      }
      i = j
      continue
    }
    if ((ch === 'A' || ch === 'a') && /^ALTER\s+TABLE\b/i.test(text.slice(i))) return i
    i++
  }
  return -1
}

/**
 * Plain (non-dynamic) `ALTER TABLE` inside a `DO $$ ... $$` block. Every such
 * block in this repo is an idempotency guard whose intent is "make it so"
 * (`IF NOT EXISTS (...) THEN ALTER TABLE ... ADD COLUMN ...`), so applying the
 * DDL unconditionally reproduces the end state. Without this, the model denies
 * `supplier_invoice_payments.user_id` and the whole `webhooks` table (renamed
 * from `automation_webhooks` inside such a block).
 */
function applyDoBlockDdl(
  model: SchemaModel,
  enums: Map<string, Set<string>>,
  stmt: string
): void {
  const bodyStart = /\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(stmt)
  if (!bodyStart) return
  const tag = bodyStart[0]
  const start = (bodyStart.index ?? 0) + tag.length
  const end = stmt.indexOf(tag, start)
  const body = stmt.slice(start, end === -1 ? stmt.length : end)

  for (const sub of splitStatements(body)) {
    const at = findUnquotedAlterTable(sub)
    if (at === -1) continue
    const flat = sub.slice(at).replace(/\s+/g, ' ').trim()
    const alter = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+(.+)$/i.exec(
      flat
    )
    if (!alter) continue
    const table = model.tables.get(alter[1])
    if (!table) continue
    for (const action of splitTopLevel(alter[2])) {
      applyAlterAction(model, table, action, enums)
    }
  }
}

/**
 * `DO $$ ... EXECUTE format('ALTER TABLE public.%I ADD COLUMN ...', tbl) ... $$`
 * over an `ARRAY[...]` of table names. The multi-tenant refactor added
 * `company_id` to forty tables this way; without this the model would deny that
 * `chart_of_accounts.company_id` exists and the guard would accuse hundreds of
 * correct call sites.
 *
 * Deliberately only handles ADD COLUMN, i.e. it can only ever ADD columns to the
 * model. A misread here loses coverage, it never invents an accusation.
 */
function applyDynamicDdl(
  model: SchemaModel,
  enums: Map<string, Set<string>>,
  stmt: string
): void {
  const candidates: string[] = []
  const arrayRe = /ARRAY\s*\[/gi
  for (let m = arrayRe.exec(stmt); m; m = arrayRe.exec(stmt)) {
    const open = stmt.indexOf('[', m.index)
    let depth = 0
    let i = open
    for (; i < stmt.length; i++) {
      if (stmt[i] === '[') depth++
      else if (stmt[i] === ']') {
        depth--
        if (depth === 0) break
      }
    }
    for (const item of splitTopLevel(stmt.slice(open + 1, i))) {
      const lit = /^'((?:[^']|'')*)'$/.exec(item.trim())
      if (lit) candidates.push(lit[1].replace(/''/g, "'"))
    }
  }
  if (candidates.length === 0) return

  const templateRe = /'((?:[^']|'')*)'/g
  for (let m = templateRe.exec(stmt); m; m = templateRe.exec(stmt)) {
    const template = m[1].replace(/''/g, "'").replace(/\s+/g, ' ').trim()
    const alter = /^ALTER\s+TABLE\s+(?:public\.)?%[Is]\s+(ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?.+)$/i.exec(
      template
    )
    if (!alter) continue
    for (const name of candidates) {
      const table = model.tables.get(name)
      if (table) applyAlterAction(model, table, alter[1], enums)
    }
  }
}

function applyAlterAction(
  model: SchemaModel,
  table: TableModel,
  action: string,
  enums: Map<string, Set<string>>
): void {
  const a = action.trim()

  const renameTable = /^RENAME\s+TO\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?$/i.exec(a)
  if (renameTable) {
    model.tables.delete(table.name)
    table.name = renameTable[1]
    model.tables.set(table.name, table)
    return
  }

  const renameColumn = /^RENAME\s+(?:COLUMN\s+)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+TO\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?$/i.exec(
    a
  )
  if (renameColumn) {
    table.columns.delete(renameColumn[1])
    table.columns.add(renameColumn[2])
    return
  }

  const dropColumn = /^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(a)
  if (dropColumn) {
    table.columns.delete(dropColumn[1])
    return
  }

  const dropConstraint = /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(
    a
  )
  if (dropConstraint) {
    const name = dropConstraint[1]
    table.checks.delete(name)
    // Retract the unique set a NAMED UNIQUE/PK constraint carried, so an
    // `onConflict` naming the dropped constraint's columns fails here instead
    // of 42P10-ing at runtime. The set survives when another constraint or a
    // unique index still provides the same column key. A column-level bare
    // `UNIQUE` (parsed by applyTableItem) has no name and is untouched.
    const key = table.uniqueConstraintKeys.get(name)
    if (key !== undefined) {
      table.uniqueConstraintKeys.delete(name)
      const stillProvided =
        [...table.uniqueConstraintKeys.values()].includes(key) ||
        [...model.uniqueIndexes.values()].some((e) => e.table === table.name && e.key === key)
      if (!stillProvided) table.uniqueSets.delete(key)
    }
    return
  }

  const addConstraint = /^ADD\s+CONSTRAINT\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+(.+)$/i.exec(a)
  if (addConstraint) {
    const name = addConstraint[1]
    const body = addConstraint[2]
    if (/^CHECK\s*\(/i.test(body)) {
      const group = balancedParens(body, 0)
      const parsed = group ? parseClosedCheck(group.body) : null
      if (parsed) table.checks.set(name, parsed)
      return
    }
    if (/^UNIQUE\s*\(/i.test(body) || /^PRIMARY\s+KEY\s*\(/i.test(body)) {
      const group = balancedParens(body, 0)
      if (group) recordUnique(table, parseColumnList(group.body), name)
      return
    }
    if (/^FOREIGN\s+KEY\s*\(/i.test(body)) {
      const group = balancedParens(body, 0)
      const target = /REFERENCES\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?/i.exec(body)
      if (group && target) {
        for (const col of parseColumnList(group.body)) table.fkTargets.set(col, target[1])
      }
      return
    }
    return
  }

  // `ADD COLUMN x type`, and bare `ADD x type` (COLUMN is optional in Postgres).
  const addColumn = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+(.*)$/i.exec(
    a
  )
  if (addColumn && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|GENERATED)$/i.test(addColumn[1])) {
    applyTableItem(table, `${addColumn[1]} ${addColumn[2]}`, enums)
    return
  }

  const alterColumnType = /^ALTER\s+(?:COLUMN\s+)?"?([A-Za-z_][A-Za-z0-9_$]*)"?\s+(?:SET\s+DATA\s+)?TYPE\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(
    a
  )
  if (alterColumnType) {
    const enumValues = enums.get(alterColumnType[2].toLowerCase())
    if (enumValues) {
      table.checks.set(`${table.name}_${alterColumnType[1]}_enumtype`, {
        column: alterColumnType[1],
        values: new Set(enumValues),
      })
    }
    return
  }
}

/** Columns of a table whose value set is closed and unambiguous. */
export function closedValueSets(table: TableModel): Map<string, Set<string>> {
  const byColumn = new Map<string, Set<string>[]>()
  for (const check of table.checks.values()) {
    const list = byColumn.get(check.column) ?? []
    list.push(check.values)
    byColumn.set(check.column, list)
  }
  const out = new Map<string, Set<string>>()
  for (const [column, sets] of byColumn) {
    // Two live constraints on one column: we cannot tell which is authoritative,
    // so the column is not treated as closed.
    if (sets.length === 1 && table.columns.has(column)) out.set(column, sets[0])
  }
  return out
}

// ---------------------------------------------------------------------------
// Query builder reference extraction
// ---------------------------------------------------------------------------

export interface ColumnRef {
  table: string
  column: string
  kind: 'select' | 'filter' | 'order' | 'write' | 'onConflict' | 'logical' | 'match'
  file: string
  line: number
  raw: string
}

export interface ValueRef {
  table: string
  column: string
  value: string
  file: string
  line: number
  raw: string
}

export interface ConflictRef {
  table: string
  columns: string[]
  file: string
  line: number
}

export interface TableRef {
  table: string
  file: string
  line: number
}

export interface Unresolved {
  reason: string
  detail: string
  file: string
  line: number
}

export interface ScanResult {
  columnRefs: ColumnRef[]
  valueRefs: ValueRef[]
  conflictRefs: ConflictRef[]
  tableRefs: TableRef[]
  unresolved: Unresolved[]
}

/** `.from()` receivers that are definitely not a PostgREST client. */
const NON_CLIENT_RECEIVERS = new Set([
  'Array',
  'Buffer',
  'Object',
  'String',
  'Number',
  'Date',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Blob',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
])

/** Methods whose first string argument is a single column name. */
const FILTER_METHODS = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'likeAllOf',
  'likeAnyOf',
  'ilike',
  'ilikeAllOf',
  'ilikeAnyOf',
  'is',
  'in',
  'contains',
  'containedBy',
  'rangeGt',
  'rangeGte',
  'rangeLt',
  'rangeLte',
  'rangeAdjacent',
  'overlaps',
  'textSearch',
])

/** Any of these appearing in the chain proves it is a PostgREST builder. */
const POSTGREST_METHODS = new Set([
  ...FILTER_METHODS,
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'order',
  'limit',
  'range',
  'single',
  'maybeSingle',
  'match',
  'not',
  'filter',
  'or',
  'csv',
  'throwOnError',
  'returns',
  'overrideTypes',
])

/** PostgREST filter operators, longest first so `gte` wins over `gt`. */
const PG_OPS = [
  'plfts',
  'phfts',
  'wfts',
  'imatch',
  'match',
  'isdistinct',
  'not',
  'neq',
  'gte',
  'lte',
  'eq',
  'gt',
  'lt',
  'like',
  'ilike',
  'is',
  'in',
  'cs',
  'cd',
  'sl',
  'sr',
  'nxl',
  'nxr',
  'adj',
  'ov',
  'fts',
]

interface ChainCall {
  method: string
  args: ts.NodeArray<ts.Expression>
  node: ts.CallExpression
}

function literalText(node: ts.Expression | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

function receiverText(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) {
    return `${receiverText(expr.expression)}.${expr.name.text}`
  }
  if (ts.isCallExpression(expr)) return `${receiverText(expr.expression)}()`
  return ''
}

/** Walk up a fluent chain from `start`, collecting `.method(args)` calls. */
function collectChain(start: ts.Expression): { calls: ChainCall[]; top: ts.Expression } {
  const calls: ChainCall[] = []
  let node: ts.Expression = start
  for (;;) {
    const parent = node.parent
    if (
      parent &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.parent &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    ) {
      calls.push({ method: parent.name.text, args: parent.parent.arguments, node: parent.parent })
      node = parent.parent
      continue
    }
    // `await q.select()` / `(q.select())` sit above the chain, not inside it.
    if (parent && ts.isNonNullExpression(parent) && parent.expression === node) {
      node = parent
      continue
    }
    return { calls, top: node }
  }
}

/** Identifier that `top` is being bound to, if any. */
function bindingTarget(top: ts.Expression): string | null {
  const parent = top.parent
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === top) {
    return ts.isIdentifier(parent.name) ? parent.name.text : null
  }
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === top &&
    ts.isIdentifier(parent.left)
  ) {
    return parent.left.text
  }
  return null
}

/** Nearest enclosing function-like node position, used to scope builder vars. */
function scopeId(node: ts.Node): number {
  let current: ts.Node | undefined = node
  while (current) {
    if (ts.isFunctionLike(current)) return current.pos
    current = current.parent
  }
  return -1
}

interface ParsedSelect {
  columns: string[]
  embeds: { name: string; alias: string | null; inner: string; hint: string | null }[]
  unparsed: string[]
}

/**
 * Parse a PostgREST select spec into plain columns and embedded resources.
 *
 * Embedded resources are the single biggest false-positive source: `items:invoice_items(*)`
 * names a TABLE, not a column, and `customer:customers!fk(id)` adds a relationship
 * hint. Anything ending in `(...)` is therefore classified as an embed and never
 * asserted as a column of the outer table.
 */
export function parseSelectSpec(spec: string): ParsedSelect {
  const out: ParsedSelect = { columns: [], embeds: [], unparsed: [] }
  for (const rawItem of splitTopLevel(spec.replace(/\s+/g, ' '))) {
    let item = rawItem.trim()
    if (!item || item === '*') continue
    if (item.startsWith('...')) item = item.slice(3).trim() // spread embed

    // Alias: `alias:target`, where `::` is a cast and never an alias separator.
    let alias: string | null = null
    const aliasMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:)/.exec(item)
    if (aliasMatch) {
      alias = aliasMatch[1]
      item = item.slice(aliasMatch[0].length).trim()
    }

    if (item.endsWith(')') && item.includes('(')) {
      const open = item.indexOf('(')
      let name = item.slice(0, open).trim()
      const inner = item.slice(open + 1, -1)
      let hint: string | null = null
      const bang = name.indexOf('!')
      if (bang !== -1) {
        hint = name.slice(bang + 1)
        name = name.slice(0, bang)
      }
      // `col.sum()` and friends are PostgREST aggregates on a real column.
      const aggregate = /^([A-Za-z_][A-Za-z0-9_]*)\.(sum|avg|count|max|min)$/i.exec(name)
      if (aggregate && inner.trim() === '') {
        out.columns.push(aggregate[1])
        continue
      }
      if (name === 'count' && inner.trim() === '') continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        out.unparsed.push(rawItem)
        continue
      }
      out.embeds.push({ name, alias, inner, hint })
      continue
    }

    if (item === 'count') continue
    // Strip casts and JSON paths: `metadata->>'key'`, `amount::text`.
    let column = item.split('::')[0].split('->')[0].trim()
    column = ident(column)
    if (!column) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      out.unparsed.push(rawItem)
      continue
    }
    out.columns.push(column)
  }
  return out
}

/** Split a PostgREST `or()`/`and()` string into `{ columnPath }` terms. */
export function parseLogicalSpec(spec: string): { paths: string[]; unparsed: string[] } {
  const paths: string[] = []
  const unparsed: string[] = []
  const visit = (text: string): void => {
    for (const rawTerm of splitTopLevel(text)) {
      let term = rawTerm.trim()
      if (!term) continue
      const nested = /^(?:not\.)?(and|or)\(([\s\S]*)\)$/i.exec(term)
      if (nested) {
        visit(nested[2])
        continue
      }
      if (term.startsWith('not.')) term = term.slice(4)
      let matched = false
      for (const op of PG_OPS) {
        const at = term.indexOf(`.${op}.`)
        if (at > 0) {
          paths.push(term.slice(0, at))
          matched = true
          break
        }
      }
      if (!matched) unparsed.push(rawTerm)
    }
  }
  visit(spec.replace(/\s+/g, ' '))
  return { paths, unparsed }
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', '__tests__'])

export function listSourceFiles(roots: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
      } else if (
        SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test.tsx') &&
        !entry.name.endsWith('.d.ts')
      ) {
        out.push(full)
      }
    }
  }
  for (const root of roots) walk(root)
  return out.sort()
}

/**
 * Extract every column reference from the Supabase builder chains in `files`.
 * `schema` is consulted only to resolve embedded-resource and alias targets, so
 * a reference whose table cannot be resolved is reported as unresolved rather
 * than attributed to the wrong table.
 */
export function scanColumnRefs(files: string[], schema: SchemaModel, root: string): ScanResult {
  const result: ScanResult = {
    columnRefs: [],
    valueRefs: [],
    conflictRefs: [],
    tableRefs: [],
    unresolved: [],
  }

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    if (!text.includes('.from(')) continue
    const rel = path.relative(root, file).split(path.sep).join('/')
    scanSourceText(text, rel, schema, result)
  }
  return result
}

/** Scan one source text. Exposed so the guard's own behaviour is testable. */
export function scanSourceText(
  text: string,
  rel: string,
  schema: SchemaModel,
  result: ScanResult = {
    columnRefs: [],
    valueRefs: [],
    conflictRefs: [],
    tableRefs: [],
    unresolved: [],
  }
): ScanResult {
  const source = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  scanFile(source, rel, schema, result)
  return result
}

function scanFile(
  source: ts.SourceFile,
  rel: string,
  schema: SchemaModel,
  result: ScanResult
): void {
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  // Pass 1: chains anchored on `<client>.from('table')`.
  const anchors: { table: string; anchor: ts.CallExpression }[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'from' &&
      node.arguments.length === 1
    ) {
      const table = literalText(node.arguments[0])
      const receiver = receiverText(node.expression.expression)
      if (
        table &&
        /^[a-z_][a-z0-9_]*$/.test(table) &&
        !NON_CLIENT_RECEIVERS.has(receiver.split('.')[0]) &&
        !receiver.endsWith('storage')
      ) {
        anchors.push({ table, anchor: node })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  // Builder variables: `let q = supabase.from('t')...` then `q = q.eq(...)`.
  // Keyed by enclosing function so the same name in two functions of one file
  // does not cross-contaminate. A name bound to two tables in one scope is
  // marked ambiguous and every reference through it becomes unresolved.
  const bindings = new Map<string, string | null>()
  const bind = (key: string, table: string): void => {
    if (!bindings.has(key)) bindings.set(key, table)
    else if (bindings.get(key) !== table) bindings.set(key, null)
  }

  const chains: { table: string | null; key: string | null; calls: ChainCall[] }[] = []
  for (const { table, anchor } of anchors) {
    const { calls, top } = collectChain(anchor)
    if (!calls.some((c) => POSTGREST_METHODS.has(c.method))) continue
    const name = bindingTarget(top)
    const key = name ? `${scopeId(top)}:${name}` : null
    if (key) bind(key, table)
    chains.push({ table, key, calls })
  }
  if (chains.length === 0) return

  // Pass 2: chains anchored on a bound builder variable. Iterate to a fixpoint
  // so `const q2 = q.eq(...)` propagates the table to `q2`.
  const identifierAnchors: { id: ts.Identifier; key: string }[] = []
  const collectIdentifiers = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.parent &&
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.expression === node &&
      node.parent.parent &&
      ts.isCallExpression(node.parent.parent)
    ) {
      identifierAnchors.push({ id: node, key: `${scopeId(node)}:${node.text}` })
    }
    ts.forEachChild(node, collectIdentifiers)
  }
  collectIdentifiers(source)

  const seen = new Set<ts.CallExpression>()
  const extraChains: { table: string | null; calls: ChainCall[]; node: ts.Node }[] = []
  for (let round = 0; round < 4; round++) {
    let changed = false
    for (const { id, key } of identifierAnchors) {
      if (!bindings.has(key)) continue
      const { calls, top } = collectChain(id)
      if (calls.length === 0) continue
      if (!calls.some((c) => POSTGREST_METHODS.has(c.method))) continue
      const head = calls[0].node
      if (!seen.has(head)) {
        seen.add(head)
        extraChains.push({ table: bindings.get(key) ?? null, calls, node: id })
      }
      const name = bindingTarget(top)
      if (name) {
        const targetKey = `${scopeId(top)}:${name}`
        const table = bindings.get(key)
        const before = bindings.has(targetKey) ? bindings.get(targetKey) : undefined
        if (table) bind(targetKey, table)
        else bindings.set(targetKey, null)
        if (before !== bindings.get(targetKey)) changed = true
      }
    }
    if (!changed) break
  }

  const all: { table: string | null; calls: ChainCall[]; node: ts.Node }[] = [
    ...chains.map((c) => ({
      table: c.key ? (bindings.get(c.key) ?? c.table) : c.table,
      calls: c.calls,
      node: c.calls[0].node,
    })),
    ...extraChains,
  ]

  for (const chain of all) {
    processChain(chain.table, chain.calls, rel, lineOf, schema, result)
  }
}

/** Resolve an embed name to a table: direct table, FK column, or unknown. */
function resolveEmbedTarget(
  outer: string | null,
  name: string,
  schema: SchemaModel
): string | null {
  if (schema.tables.has(name)) return name
  if (schema.views.has(name)) return null
  if (outer) {
    const fk = schema.tables.get(outer)?.fkTargets.get(name)
    if (fk) return fk
  }
  return null
}

function processChain(
  table: string | null,
  calls: ChainCall[],
  rel: string,
  lineOf: (node: ts.Node) => number,
  schema: SchemaModel,
  result: ScanResult
): void {
  const first = calls[0].node
  if (table) result.tableRefs.push({ table, file: rel, line: lineOf(first) })

  // Alias -> table map, built from every select in the chain, so a dotted
  // embedded filter like `.eq('salary_run.status', ...)` resolves.
  const aliases = new Map<string, string>()
  const registerAliases = (outer: string | null, spec: string): void => {
    const parsed = parseSelectSpec(spec)
    for (const embed of parsed.embeds) {
      const target = resolveEmbedTarget(outer, embed.name, schema)
      if (target) {
        aliases.set(embed.alias ?? embed.name, target)
        registerAliases(target, embed.inner)
      }
    }
  }
  for (const call of calls) {
    if (call.method !== 'select') continue
    const spec = literalText(call.args[0])
    if (spec) registerAliases(table, spec)
  }

  const resolvePath = (
    rawPath: string,
    node: ts.Node,
    kind: ColumnRef['kind'],
    override?: string | null
  ): { table: string; column: string } | null => {
    const clean = rawPath.split('::')[0].split('->')[0].trim()
    const parts = clean.split('.')
    let owner = override ?? table
    let column = clean
    if (parts.length > 1) {
      const prefix = parts[0].split('!')[0]
      column = parts[parts.length - 1]
      owner = aliases.get(prefix) ?? (schema.tables.has(prefix) ? prefix : null)
      if (!owner) {
        result.unresolved.push({
          reason: 'embedded-filter-target',
          detail: rawPath,
          file: rel,
          line: lineOf(node),
        })
        return null
      }
    }
    if (!owner) {
      result.unresolved.push({
        reason: 'unknown-builder-table',
        detail: `${kind} ${rawPath}`,
        file: rel,
        line: lineOf(node),
      })
      return null
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
      result.unresolved.push({
        reason: 'unparsed-column-path',
        detail: rawPath,
        file: rel,
        line: lineOf(node),
      })
      return null
    }
    return { table: owner, column }
  }

  const push = (
    owner: string,
    column: string,
    kind: ColumnRef['kind'],
    node: ts.Node,
    raw: string
  ): void => {
    result.columnRefs.push({ table: owner, column, kind, file: rel, line: lineOf(node), raw })
  }

  for (const call of calls) {
    const { method, args, node } = call
    const line = lineOf(node)

    if (method === 'select') {
      if (args.length === 0) continue
      const spec = literalText(args[0])
      if (spec === null) {
        result.unresolved.push({
          reason: 'dynamic-select',
          detail: args[0].getText().slice(0, 60).replace(/\s+/g, ' '),
          file: rel,
          line,
        })
        continue
      }
      const walkSelect = (owner: string | null, text: string): void => {
        const parsed = parseSelectSpec(text)
        for (const item of parsed.unparsed) {
          result.unresolved.push({ reason: 'unparsed-select-item', detail: item, file: rel, line })
        }
        if (owner === null) {
          if (parsed.columns.length) {
            result.unresolved.push({
              reason: 'unknown-builder-table',
              detail: `select ${parsed.columns.join(',')}`,
              file: rel,
              line,
            })
          }
        } else {
          for (const column of parsed.columns) push(owner, column, 'select', node, column)
        }
        for (const embed of parsed.embeds) {
          const target = resolveEmbedTarget(owner, embed.name, schema)
          if (!target) {
            result.unresolved.push({
              reason: 'embedded-resource-target',
              detail: `${owner ?? '?'} -> ${embed.name}`,
              file: rel,
              line,
            })
            continue
          }
          walkSelect(target, embed.inner)
        }
      }
      walkSelect(table, spec)
      continue
    }

    if (FILTER_METHODS.has(method) || method === 'not' || method === 'filter') {
      const raw = literalText(args[0])
      if (raw === null) {
        if (args.length > 0) {
          result.unresolved.push({
            reason: 'dynamic-column',
            detail: `${method}(${args[0].getText().slice(0, 40).replace(/\s+/g, ' ')})`,
            file: rel,
            line,
          })
        }
        continue
      }
      // PostgREST's null filter on an embedded resource (`?invoice_items=is.null`,
      // the anti-join on a to-many embed: the parents whose embed is empty)
      // names the embed declared in this chain's select, not a column. The
      // embed itself was resolved when the aliases were registered, so there
      // is no column left to check. Only `is` reaches an embed this way:
      // `.eq('invoice_items', x)` is a real phantom and stays one. Grammar
      // proven on a real PostgREST by complete-invoice-lines-count.tool.test.ts.
      const operator = method === 'is' ? 'is' : literalText(args[1])
      const embedNullFilter =
        !raw.includes('.') &&
        aliases.has(raw) &&
        operator === 'is' &&
        (method === 'is' || method === 'not' || method === 'filter')
      if (embedNullFilter) continue
      const resolved = resolvePath(raw, node, 'filter')
      if (!resolved) continue
      push(resolved.table, resolved.column, 'filter', node, raw)
      if (method === 'eq' || method === 'neq') {
        const value = literalText(args[1])
        if (value !== null) {
          result.valueRefs.push({ ...resolved, value, file: rel, line, raw: `${method}('${raw}')` })
        }
      }
      if (method === 'in' && args[1] && ts.isArrayLiteralExpression(args[1])) {
        for (const element of args[1].elements) {
          const value = literalText(element)
          if (value !== null) {
            result.valueRefs.push({ ...resolved, value, file: rel, line, raw: `in('${raw}')` })
          }
        }
      }
      continue
    }

    if (method === 'order') {
      const raw = literalText(args[0])
      if (raw === null) {
        if (args.length > 0) {
          result.unresolved.push({
            reason: 'dynamic-column',
            detail: `order(${args[0].getText().slice(0, 40).replace(/\s+/g, ' ')})`,
            file: rel,
            line,
          })
        }
        continue
      }
      let override: string | null | undefined
      if (args[1] && ts.isObjectLiteralExpression(args[1])) {
        for (const prop of args[1].properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
          if (prop.name.text !== 'referencedTable' && prop.name.text !== 'foreignTable') continue
          const target = literalText(prop.initializer)
          override = target && schema.tables.has(target) ? target : null
        }
      }
      const resolved = resolvePath(raw, node, 'order', override)
      if (resolved) push(resolved.table, resolved.column, 'order', node, raw)
      continue
    }

    if (method === 'or' || method === 'and') {
      const spec = literalText(args[0])
      if (spec === null) {
        if (args.length > 0) {
          result.unresolved.push({ reason: 'dynamic-logical', detail: method, file: rel, line })
        }
        continue
      }
      let override: string | null | undefined
      if (args[1] && ts.isObjectLiteralExpression(args[1])) {
        for (const prop of args[1].properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
          if (prop.name.text !== 'referencedTable' && prop.name.text !== 'foreignTable') continue
          const target = literalText(prop.initializer)
          override = target && schema.tables.has(target) ? target : null
        }
      }
      const parsed = parseLogicalSpec(spec)
      for (const item of parsed.unparsed) {
        result.unresolved.push({ reason: 'unparsed-logical-term', detail: item, file: rel, line })
      }
      for (const p of parsed.paths) {
        const resolved = resolvePath(p, node, 'logical', override)
        if (resolved) push(resolved.table, resolved.column, 'logical', node, p)
      }
      continue
    }

    if (method === 'match' || method === 'insert' || method === 'update' || method === 'upsert') {
      const kind: ColumnRef['kind'] = method === 'match' ? 'match' : 'write'
      const payloads: ts.Expression[] = []
      if (args[0]) {
        if (ts.isArrayLiteralExpression(args[0])) payloads.push(...args[0].elements)
        else payloads.push(args[0])
      }
      for (const payload of payloads) {
        if (!ts.isObjectLiteralExpression(payload)) {
          result.unresolved.push({
            reason: 'dynamic-payload',
            detail: `${method}(${payload.getText().slice(0, 40).replace(/\s+/g, ' ')})`,
            file: rel,
            line,
          })
          continue
        }
        for (const prop of payload.properties) {
          if (ts.isSpreadAssignment(prop)) {
            result.unresolved.push({
              reason: 'spread-payload',
              detail: `${method} ${prop.getText().slice(0, 40)}`,
              file: rel,
              line,
            })
            continue
          }
          let name: string | null = null
          if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
            if (ts.isIdentifier(prop.name)) name = prop.name.text
            else if (ts.isStringLiteral(prop.name)) name = prop.name.text
          }
          if (name === null) {
            result.unresolved.push({
              reason: 'computed-payload-key',
              detail: `${method} ${prop.getText().slice(0, 40)}`,
              file: rel,
              line,
            })
            continue
          }
          if (!table) {
            result.unresolved.push({
              reason: 'unknown-builder-table',
              detail: `${method} ${name}`,
              file: rel,
              line,
            })
            continue
          }
          push(table, name, kind, node, name)
          if (ts.isPropertyAssignment(prop)) {
            const value = literalText(prop.initializer)
            if (value !== null) {
              result.valueRefs.push({
                table,
                column: name,
                value,
                file: rel,
                line,
                raw: `${method} ${name}`,
              })
            }
          }
        }
      }
      if (method === 'upsert' && args[1] && ts.isObjectLiteralExpression(args[1])) {
        for (const prop of args[1].properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
          if (prop.name.text !== 'onConflict') continue
          const spec = literalText(prop.initializer)
          if (spec === null) {
            result.unresolved.push({ reason: 'dynamic-on-conflict', detail: '', file: rel, line })
            continue
          }
          const columns = spec.split(',').map((c) => c.trim()).filter(Boolean)
          if (!table) {
            result.unresolved.push({
              reason: 'unknown-builder-table',
              detail: `onConflict ${spec}`,
              file: rel,
              line,
            })
            continue
          }
          if (!columns.every((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c))) {
            result.unresolved.push({
              reason: 'unparsed-on-conflict',
              detail: spec,
              file: rel,
              line,
            })
            continue
          }
          for (const column of columns) push(table, column, 'onConflict', node, spec)
          result.conflictRefs.push({ table, columns, file: rel, line })
        }
      }
      continue
    }
  }
}
