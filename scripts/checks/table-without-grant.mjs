#!/usr/bin/env node
/**
 * Guard: a migration that creates a public table, view or sequence without
 * granting it to the Data API roles.
 *
 * Until 2026-09-29 no migration had to: Supabase's platform bootstrap ran
 * `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON
 * TABLES TO anon, authenticated, service_role` (and the same on sequences),
 * so every new table was reachable and RLS did the limiting. Supabase withdrew
 * that default for new projects on 2026-05-30 and withdraws it for existing
 * ones on 2026-10-30; migration 20260929220000_own_default_privileges switches
 * it off here now. A new table without an explicit GRANT answers 42501 to
 * every supabase-js client, the service-role one included, and nothing short
 * of a real PostgREST call notices: unit tests mock the client, and a pg-real
 * test only notices when it happens to touch the table as that role.
 *
 * The rule, for every relation a non-grandfathered migration creates in
 * public (CREATE TABLE, CREATE [MATERIALIZED] VIEW, CREATE SEQUENCE):
 *
 *   * service_role and authenticated each get a GRANT on it in the same file,
 *     or an explicit, reasoned waiver in a comment:
 *       -- no-grant: authenticated on public.my_table (service-role only: cron writes it)
 *     or a `REVOKE ALL ... ON public.my_table FROM authenticated` in the same
 *     file, which states the role's access as plainly as a waiver and, unlike a
 *     comment, takes effect. A partial REVOKE (SELECT, DELETE, ...) does not
 *     count: it assumes the rest of the old default grant is still there.
 *     anon is never required; grant it only to a table that is meant to be
 *     public.
 *   * a serial column (serial, smallserial, bigserial, serial2/4/8), in a
 *     CREATE TABLE or added later with ALTER TABLE ... ADD COLUMN, needs its
 *     sequence (`<table>_<column>_seq`) granted to the same two roles, unless
 *     the table or the sequence carries a waiver for that role. An identity
 *     or uuid key needs no sequence grant.
 *   * `IF NOT EXISTS` / `OR REPLACE` on a relation an earlier migration already
 *     created is a no-op for its ACL and is not checked, unless a DROP since
 *     then removed it: the re-created relation starts from the empty default.
 *
 * And in any non-grandfathered migration, a bulk grant to the API roles fails
 * outright: `GRANT ... ON ALL TABLES|SEQUENCES IN SCHEMA public` re-opens the
 * tables earlier migrations deliberately locked down (REVOKEs on provider
 * tokens, peppol_*, sie_*, ai_usage_events, ...), and `ALTER DEFAULT
 * PRIVILEGES ... GRANT` undoes 20260929220000 for every table after it.
 *
 * Grandfathering is a file set in antipatterns-baseline.json
 * (tableWithoutGrant), not a version cutoff: a branch whose migration was
 * timestamped before 20260929220000 but merges after it would otherwise slip
 * through, and its table would reach production with no grants at all.
 *
 * Comments, string literals and function bodies are blanked before parsing:
 * the seed_agent_atom_bodies migrations carry skill markdown full of example
 * SQL, which must not count as DDL. The body of a DO block is parsed, since
 * the DDL in it runs with the migration. DDL built at run time (EXECUTE of a
 * string) cannot be read and is not checked.
 */

import fs from 'node:fs'
import path from 'node:path'

/** Roles every new relation must be granted to, or explicitly waived for. */
export const REQUIRED_ROLES = ['service_role', 'authenticated']
const API_ROLES = new Set(['anon', 'authenticated', 'service_role'])

const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)`
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`
const SERIAL_TYPE = String.raw`(?:(?:small|big)serial|serial[248]?)`

/**
 * True when the code before a dollar quote ends with `DO` (optionally
 * `DO LANGUAGE x`). `window` is the code up to and including its last
 * non-whitespace character, at least 41 characters of it.
 */
function endsWithDo(window) {
  return /(?:^|[^\w$"])do(?:\s+language(?:\s+[a-z_][a-z0-9_]*)?)?$/i.test(window)
}

/** A run of characters that cannot start a comment, literal or quoted identifier. */
const PLAIN_RUN = /[^-/'$"]+/y

/**
 * Split SQL into code (comments and literals replaced by spaces, offsets and
 * newlines preserved), the text of its comments, and the bodies of its DO
 * blocks (blanked in `code` like any dollar-quoted body, returned with their
 * offset so the caller can parse the DDL they run).
 */
export function sanitizeSql(sql) {
  // `code` is built from parts and joined once: reading back from a growing
  // concatenated string flattens it on every read, which made the scan
  // quadratic on the migrations that seed large function bodies.
  const parts = []
  const comments = []
  const doBodies = []
  let i = 0
  // The last 128 characters of the code so far, and the code up to its last
  // non-whitespace character. Blanked text is only spaces and newlines, so
  // only verbatim appends move the second one.
  let tail = ''
  let sigWindow = ''
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  const push = (s) => {
    parts.push(s)
    tail = s.length >= 128 ? s.slice(-128) : (tail + s).slice(-128)
  }
  const keep = (s) => {
    push(s)
    if (/\S/.test(s)) sigWindow = tail.trimEnd().slice(-41)
  }
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      comments.push(sql.slice(i + 2, stop))
      push(blank(sql.slice(i, stop)))
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
      comments.push(sql.slice(i + 2, j - 2))
      push(blank(sql.slice(i, j)))
      i = j
    } else if (ch === "'") {
      // '' is an escaped quote; E'' strings may also escape with a backslash.
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '')
      let j = i + 1
      while (j < sql.length) {
        if (escapes && sql[j] === '\\') j += 2
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2
        else if (sql[j] === "'") break
        else if (escapes) j++
        else {
          // Without backslash escapes only a quote matters: jump to the next one.
          const q = sql.indexOf("'", j)
          j = q === -1 ? sql.length : q
        }
      }
      push(blank(sql.slice(i, j + 1)))
      i = j + 1
    } else if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (tag && !/\w/.test(sql[i - 1] ?? '')) {
        const bodyStart = i + tag[0].length
        const close = sql.indexOf(tag[0], bodyStart)
        const bodyEnd = close === -1 ? sql.length : close
        if (endsWithDo(sigWindow)) doBodies.push({ offset: bodyStart, body: sql.slice(bodyStart, bodyEnd) })
        const stop = close === -1 ? sql.length : close + tag[0].length
        push(blank(sql.slice(i, stop)))
        i = stop
      } else {
        keep(ch)
        i++
      }
    } else if (ch === '"') {
      const end = sql.indexOf('"', i + 1)
      const stop = end === -1 ? sql.length : end + 1
      keep(sql.slice(i, stop))
      i = stop
    } else {
      // Copy the whole run up to the next character that can open a comment,
      // literal or quoted identifier, not one character at a time.
      PLAIN_RUN.lastIndex = i + 1
      const run = PLAIN_RUN.exec(sql)
      const stop = run ? i + 1 + run[0].length : i + 1
      keep(sql.slice(i, stop))
      i = stop
    }
  }
  return { code: parts.join(''), comments, doBodies }
}

/** `public.Foo` / `"foo"` / `foo` -> `foo`; null for a relation outside public. */
export function publicName(qualified) {
  const parts = qualified
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean)
  const unquote = (p) => (p.startsWith('"') ? p.slice(1, -1) : p.toLowerCase())
  if (parts.length === 2) {
    return unquote(parts[0]) === 'public' ? unquote(parts[1]) : null
  }
  if (parts.length === 1) return unquote(parts[0])
  return null
}

const splitList = (s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

const countNewlines = (text) => {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

const CREATE_TABLE_RE = new RegExp(
  String.raw`^create\s+(?:(?:global|local)\s+)?(temp|temporary|unlogged)?\s*table\s+(if\s+not\s+exists\s+)?(${QUALIFIED})`,
  'i',
)
const CREATE_VIEW_RE = new RegExp(
  String.raw`^create\s+(or\s+replace\s+)?(temp|temporary)?\s*(?:recursive\s+)?(materialized\s+)?view\s+(if\s+not\s+exists\s+)?(${QUALIFIED})`,
  'i',
)
const CREATE_SEQUENCE_RE = new RegExp(
  String.raw`^create\s+(temp|temporary|unlogged)?\s*sequence\s+(if\s+not\s+exists\s+)?(${QUALIFIED})`,
  'i',
)
const DROP_RE = /^drop\s+(?:table|view|materialized\s+view|sequence)\s+(?:if\s+exists\s+)?(.+?)(?:\s+(?:cascade|restrict))?$/i
const ALTER_TABLE_RE = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QUALIFIED})\s+([\s\S]*)$`,
  'i',
)
const ALTER_VIEW_RE = new RegExp(String.raw`^alter\s+view\s+(?:if\s+exists\s+)?(${QUALIFIED})\s+(set\b[\s\S]*)$`, 'i')
const SERIAL_COLUMN_RE = new RegExp(String.raw`(?:\(|,)\s*(${IDENT})\s+${SERIAL_TYPE}\b`, 'gi')
const ADD_SERIAL_RE = new RegExp(
  String.raw`\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})\s+${SERIAL_TYPE}\b`,
  'gi',
)
const SECURITY_INVOKER_RE = /\bsecurity_invoker\s*(?:=\s*(?:true|on|yes|1)\b|(?=[,)]))/i
const GRANT_RE = /^grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?\s*$/i
const REVOKE_RE =
  /^revoke\s+(grant\s+option\s+for\s+)?([\s\S]+?)\s+on\s+([\s\S]+?)\s+from\s+([\s\S]+?)(?:\s+(?:cascade|restrict))?\s*$/i
const WAIVER_RE = new RegExp(
  String.raw`no-grant:\s*((?:anon|authenticated|service_role)(?:\s*,\s*(?:anon|authenticated|service_role))*)\s+on\s+(${QUALIFIED})\s*\(([^)]*)\)`,
  'gi',
)
// Object kinds a GRANT can name that are not relations or sequences.
const NON_RELATION_GRANT_RE =
  /^(?:function|procedure|routine|schema|database|domain|foreign|language|large\s+object|parameter|tablespace|type|all\s+(?:functions|procedures|routines)\s+in\s+schema)\b/i
// Inside a DO block a statement follows plpgsql control words (BEGIN, IF ...
// THEN, ELSE); the DDL this guard reads starts at one of these.
const DO_STATEMENT_START_RE = /\b(?:create|grant|drop|alter)\s/i

/** One statement, whitespace collapsed. Mutates the per-file state `ctx`. */
function handleStatement(stmt, line, ctx) {
  const { existing } = ctx

  let m = CREATE_TABLE_RE.exec(stmt)
  if (m) {
    const name = publicName(m[3])
    if (!name || /^temp/i.test(m[1] ?? '')) return
    if (!(m[2] && existing.has(name))) {
      ctx.created.push({ name, kind: 'table', line })
      for (const s of stmt.matchAll(SERIAL_COLUMN_RE)) {
        ctx.serials.push({ table: name, sequence: `${name}_${publicName(s[1])}_seq`, line })
      }
    }
    existing.add(name)
    return
  }

  m = CREATE_VIEW_RE.exec(stmt)
  if (m) {
    const name = publicName(m[5])
    if (!name || m[2]) return
    const materialized = Boolean(m[3])
    if (!((m[1] || m[4]) && existing.has(name))) {
      ctx.created.push({ name, kind: materialized ? 'materialized view' : 'view', line })
      if (!materialized && SECURITY_INVOKER_RE.test(stmt)) ctx.rowSecurity.add(name)
    }
    existing.add(name)
    return
  }

  m = CREATE_SEQUENCE_RE.exec(stmt)
  if (m) {
    const name = publicName(m[3])
    if (!name || /^temp/i.test(m[1] ?? '')) return
    if (!(m[2] && existing.has(name))) ctx.created.push({ name, kind: 'sequence', line })
    existing.add(name)
    return
  }

  m = DROP_RE.exec(stmt)
  if (m) {
    // A later CREATE ... IF NOT EXISTS / OR REPLACE of a dropped relation
    // builds it anew from the default ACL, and its old grants are gone.
    for (const target of splitList(m[1])) {
      const name = publicName(target)
      if (!name) continue
      existing.delete(name)
      ctx.created = ctx.created.filter((r) => r.name !== name)
      ctx.serials = ctx.serials.filter((s) => s.table !== name && s.sequence !== name)
      for (const role of API_ROLES) {
        ctx.grants.delete(`${name}|${role}`)
        ctx.revoked.delete(`${name}|${role}`)
      }
      ctx.rowSecurity.delete(name)
    }
    return
  }

  m = ALTER_TABLE_RE.exec(stmt)
  if (m) {
    const name = publicName(m[1])
    if (!name) return
    if (/\benable\s+row\s+level\s+security\b/i.test(m[2])) ctx.rowSecurity.add(name)
    for (const s of m[2].matchAll(ADD_SERIAL_RE)) {
      ctx.serials.push({ table: name, sequence: `${name}_${publicName(s[1])}_seq`, line })
    }
    return
  }

  m = ALTER_VIEW_RE.exec(stmt)
  if (m) {
    const name = publicName(m[1])
    if (name && SECURITY_INVOKER_RE.test(m[2])) ctx.rowSecurity.add(name)
    return
  }

  if (/^alter default privileges\b/i.test(stmt) && /\bgrant\b/i.test(stmt)) {
    const roles = /\bto\s+(.+)$/i.exec(stmt)
    if (roles && splitList(roles[1].toLowerCase()).some((r) => API_ROLES.has(r))) {
      ctx.findings.push({ file: ctx.file, line, kind: 'bulk-grant', detail: 'ALTER DEFAULT PRIVILEGES ... GRANT' })
    }
    return
  }

  m = REVOKE_RE.exec(stmt)
  if (m) {
    // Only REVOKE ALL [PRIVILEGES] is a decision about the role; a partial or
    // GRANT OPTION FOR revoke leaves it expecting the grant it no longer gets.
    if (m[1] || !/^all(?:\s+privileges)?$/i.test(m[2].trim())) return
    const revokedFrom = m[3].trim()
    if (NON_RELATION_GRANT_RE.test(revokedFrom) || /^all\s/i.test(revokedFrom)) return
    const revokedRoles = splitList(m[4].toLowerCase())
      .map((r) => r.replace(/^group\s+/, ''))
      .filter((r) => API_ROLES.has(r))
    const revokedSequence = /^sequence\s+(.+)$/i.exec(revokedFrom)
    for (const target of splitList(revokedSequence ? revokedSequence[1] : revokedFrom.replace(/^table\s+/i, ''))) {
      const name = publicName(target)
      if (!name) continue
      for (const role of revokedRoles) ctx.revoked.add(`${name}|${role}`)
    }
    return
  }

  m = GRANT_RE.exec(stmt)
  if (!m) return
  const objects = m[2].trim()
  const roles = splitList(m[3].toLowerCase()).map((r) => r.replace(/^group\s+/, ''))
  const apiRoles = roles.filter((r) => API_ROLES.has(r))
  if (!apiRoles.length || NON_RELATION_GRANT_RE.test(objects)) return

  const bulk = /^all\s+(tables|sequences)\s+in\s+schema\s+(.+)$/i.exec(objects)
  if (bulk) {
    if (splitList(bulk[2]).some((s) => publicName(s) === 'public')) {
      ctx.findings.push({
        file: ctx.file,
        line,
        kind: 'bulk-grant',
        detail: `GRANT ... ON ALL ${bulk[1].toUpperCase()} IN SCHEMA public`,
      })
    }
    return
  }

  // GRANT ... ON SEQUENCE s and GRANT ... ON [TABLE] s both reach a sequence.
  const sequence = /^sequence\s+(.+)$/i.exec(objects)
  for (const target of splitList(sequence ? sequence[1] : objects.replace(/^table\s+/i, ''))) {
    const name = publicName(target)
    if (!name) continue
    for (const role of apiRoles) ctx.grants.add(`${name}|${role}`)
  }
}

/** Parse one SQL text (a migration, or the body of a DO block in it) into `ctx`. */
function walk(sql, firstLine, inDoBlock, ctx) {
  const { code, comments, doBodies } = sanitizeSql(sql)

  for (const comment of comments) {
    for (const m of comment.matchAll(WAIVER_RE)) {
      const name = publicName(m[2])
      if (!name || !m[3].trim()) continue
      for (const role of splitList(m[1].toLowerCase())) ctx.waivers.add(`${name}|${role}`)
    }
  }

  let offset = 0
  let lineAtChunk = firstLine
  let nextBody = 0
  for (const raw of code.split(';')) {
    const end = offset + raw.length
    const start = (inDoBlock ? DO_STATEMENT_START_RE : /\S/).exec(raw)
    if (start) {
      const stmt = raw.slice(start.index).trim().replace(/\s+/g, ' ')
      handleStatement(stmt, lineAtChunk + countNewlines(raw.slice(0, start.index)), ctx)
    }
    // DO blocks run where they stand: parse each one before the statements after it.
    while (nextBody < doBodies.length && doBodies[nextBody].offset < end) {
      const body = doBodies[nextBody++]
      walk(body.body, firstLine + countNewlines(sql.slice(0, body.offset)), true, ctx)
    }
    lineAtChunk += countNewlines(raw)
    offset = end + 1
  }
}

/**
 * Analyse one migration. `existing` is the set of public relations created by
 * earlier migrations; relations this file creates are added to it, and the
 * ones it drops are removed.
 */
export function analyzeMigration(sql, file, existing = new Set()) {
  const ctx = {
    file,
    existing,
    created: [], // { name, kind, line }
    serials: [], // { table, sequence, line }
    grants: new Set(), // `${name}|${role}`
    waivers: new Set(), // `${name}|${role}`
    revoked: new Set(), // `${name}|${role}`: REVOKE ALL on it from the role, after its last DROP
    rowSecurity: new Set(), // tables with RLS enabled, views with security_invoker, in this file
    findings: [],
  }
  walk(sql, 1, false, ctx)

  const reaches = (name, role) =>
    ctx.grants.has(`${name}|${role}`) || ctx.waivers.has(`${name}|${role}`) || ctx.revoked.has(`${name}|${role}`)
  const findings = [...ctx.findings]
  for (const rel of ctx.created) {
    const missing = REQUIRED_ROLES.filter((role) => !reaches(rel.name, role))
    if (!missing.length) continue
    const finding = { file, line: rel.line, kind: 'missing-grant', relation: rel.name, relationKind: rel.kind, roles: missing }
    if (rel.kind === 'table' || rel.kind === 'view') finding.rowSecurity = ctx.rowSecurity.has(rel.name)
    findings.push(finding)
  }
  for (const s of ctx.serials) {
    const missing = REQUIRED_ROLES.filter(
      (role) =>
        !reaches(s.sequence, role) && !ctx.waivers.has(`${s.table}|${role}`) && !ctx.revoked.has(`${s.table}|${role}`),
    )
    if (missing.length) {
      findings.push({ file, line: s.line, kind: 'serial-without-grant', relation: s.table, sequence: s.sequence, roles: missing })
    }
  }
  return findings.sort((a, b) => a.line - b.line)
}

/**
 * Every finding across supabase/migrations, in filename (= apply) order. The
 * caller decides which files are grandfathered.
 */
export function findTablesWithoutGrant(root) {
  const dir = path.join(root, 'supabase', 'migrations')
  let files
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  } catch {
    return []
  }
  const existing = new Set()
  const findings = []
  for (const file of files) {
    const rel = `supabase/migrations/${file}`
    findings.push(...analyzeMigration(fs.readFileSync(path.join(dir, file), 'utf8'), rel, existing))
  }
  return findings
}

/**
 * The grandfathered file set `--update` writes. The set is frozen: a file
 * that has findings today but is not in it is a new migration and must fail,
 * whatever its timestamp, so the result is the scan narrowed to the frozen
 * set. Only the very first write (no frozen set yet) takes the scan as is.
 */
export function grandfatheredFiles(frozenFiles, scannedFiles) {
  if (!frozenFiles) return [...scannedFiles]
  const frozen = new Set(frozenFiles)
  return scannedFiles.filter((f) => frozen.has(f))
}

/** The exact lines that fix one finding, for the guard's error output. */
export function grantHint(finding) {
  if (finding.kind === 'bulk-grant') {
    return [
      finding.detail.startsWith('ALTER DEFAULT')
        ? 'Re-granting the default undoes 20260929220000 for every table created after it.'
        : 'A bulk grant to an API role re-opens the tables earlier migrations locked down on purpose.',
      'Grant each new relation by name, in the migration that creates it.',
    ]
  }
  const waiver = (name) =>
    `or, if a role must not reach it: -- no-grant: ${finding.roles.join(', ')} on public.${name} (<reason>)`
  if (finding.kind === 'serial-without-grant') {
    return [
      `GRANT USAGE, SELECT ON SEQUENCE public.${finding.sequence} TO ${finding.roles.join(', ')};`,
      '(or declare the column GENERATED ALWAYS AS IDENTITY / uuid, which needs no sequence grant)',
      waiver(finding.sequence),
    ]
  }
  const rel = finding.relation
  if (finding.relationKind === 'sequence') {
    return [`GRANT USAGE, SELECT ON SEQUENCE public.${rel} TO ${finding.roles.join(', ')};`, waiver(rel)]
  }
  const lines = []
  const table = finding.relationKind === 'table'
  const needsAuthenticated = finding.roles.includes('authenticated')
  if (needsAuthenticated && table && !finding.rowSecurity) {
    lines.push(
      `ALTER TABLE public.${rel} ENABLE ROW LEVEL SECURITY;  -- first, with policies: without RLS the authenticated grant hands every signed-in user every row`,
    )
  } else if (needsAuthenticated && finding.relationKind === 'view' && !finding.rowSecurity) {
    lines.push(
      `ALTER VIEW public.${rel} SET (security_invoker = true);  -- first: otherwise the view reads its tables as its owner and skips their RLS`,
    )
  }
  if (finding.roles.includes('service_role')) {
    lines.push(
      table
        ? `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${rel} TO service_role;`
        : `GRANT SELECT ON public.${rel} TO service_role;`,
    )
  }
  if (needsAuthenticated) {
    if (table) {
      lines.push(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${rel} TO authenticated;  -- keep only what its RLS policies allow`,
      )
    } else if (finding.relationKind === 'view') {
      lines.push(`GRANT SELECT ON public.${rel} TO authenticated;`)
    } else {
      lines.push(
        `GRANT SELECT ON public.${rel} TO authenticated;  -- only if every signed-in user may read every row: RLS does not apply to a materialized view`,
      )
    }
  }
  lines.push(waiver(rel))
  return lines
}
