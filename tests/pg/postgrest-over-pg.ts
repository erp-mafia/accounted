/**
 * PostgREST over the pg-real pool: a `fetch` for supabase-js that answers
 * each PostgREST (and GoTrue admin user) request by running it as SQL, in
 * one committed transaction under the role PostgREST would present.
 *
 * Why: pg-real has Postgres and nothing else, while routes and services talk
 * to the database through supabase-js. Handing the production client
 * constructor (createServiceRoleClient) this fetch keeps every layer real,
 * the supabase-js query builder included, and replaces only the HTTP hop:
 * the request supabase-js would send to PostgREST becomes the statement
 * PostgREST would run (jsonb_populate_recordset for writes, to_jsonb for the
 * answer, so numerics, dates and timestamps come back in PostgREST's JSON
 * shapes, UTC like hosted).
 *
 * It covers the grammar the paths under test use: plain, aliased and cast
 * columns, one-level and nested resource embeds through foreign keys (with
 * !hint and !inner), the comparison, in, is, like, contains and not filters,
 * or=(...) and and=(...) groups, order/limit/offset, exact counts, single
 * objects, insert/upsert/update/delete with return=representation, RPC calls
 * with set-returning, composite, scalar and void results, and
 * GET /auth/v1/admin/users/{id}. Anything else is answered with a PostgREST
 * style 400 AND recorded in `unsupported`, so a test can assert that the path
 * it drove never left the grammar this shim implements: a new query shape
 * fails loudly instead of being answered with something PostgREST would not
 * say.
 */
import type { PoolClient } from 'pg'
import { getClient } from './setup'

export type PgRestRole = 'service_role' | 'authenticated'

class Unsupported extends Error {}

const IDENT = /^[a-z_][a-z0-9_]*$/

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Unsupported(`identifier ${JSON.stringify(name)}`)
  return `"${name}"`
}

// ---------------------------------------------------------------------------
// Catalog: foreign keys, primary keys, unique column sets, function signatures
// ---------------------------------------------------------------------------

interface ForeignKey {
  name: string
  fromTable: string
  fromCols: string[]
  toTable: string
  toCols: string[]
}

interface FunctionSignature {
  inNames: string[]
  inTypes: string[]
  required: number
  returnsSet: boolean
  /** composite: rows as objects; scalar: values; void: no body. */
  returnKind: 'composite' | 'scalar' | 'void'
}

interface Catalog {
  foreignKeys: ForeignKey[]
  primaryKeys: Map<string, string[]>
  uniqueSets: Map<string, string[][]>
  columnTypes: Map<string, Map<string, string>>
  functions: Map<string, FunctionSignature[]>
}

let catalogPromise: Promise<Catalog> | null = null

async function loadCatalog(client: PoolClient): Promise<Catalog> {
  const fks = await client.query<ForeignKey>(`
    SELECT c.conname AS name, fr.relname AS "fromTable", tr.relname AS "toTable",
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, o)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o) AS "fromCols",
           ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, o)
                   JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o) AS "toCols"
      FROM pg_constraint c
      JOIN pg_class fr ON fr.oid = c.conrelid
      JOIN pg_class tr ON tr.oid = c.confrelid
     WHERE c.contype = 'f'
       AND fr.relnamespace = 'public'::regnamespace
       AND tr.relnamespace = 'public'::regnamespace`)
  const keys = await client.query<{ table: string; cols: string[]; primary: boolean }>(`
    SELECT t.relname AS table, i.indisprimary AS primary,
           ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n, o)
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o) AS cols
      FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
     WHERE t.relnamespace = 'public'::regnamespace AND i.indisunique AND i.indpred IS NULL`)
  const columns = await client.query<{ table: string; column: string; type: string }>(`
    SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'p', 'm')
       AND a.attnum > 0 AND NOT a.attisdropped`)
  const fns = await client.query<{
    name: string
    arg_names: string[] | null
    arg_modes: string[] | null
    all_types: string[] | null
    in_types: string[]
    nargs: number
    ndefaults: number
    retset: boolean
    rettype: string
    typtype: string
    has_out: boolean
  }>(`
    SELECT p.proname AS name, p.proargnames AS arg_names, p.proargmodes::text[] AS arg_modes,
           ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proallargtypes) t) AS all_types,
           ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes::oid[]) t) AS in_types,
           p.pronargs AS nargs, p.pronargdefaults AS ndefaults, p.proretset AS retset,
           format_type(p.prorettype, NULL) AS rettype, rt.typtype::text AS typtype,
           coalesce('o' = ANY(p.proargmodes::text[]) OR 't' = ANY(p.proargmodes::text[]), false) AS has_out
      FROM pg_proc p JOIN pg_type rt ON rt.oid = p.prorettype
     WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'`)

  const primaryKeys = new Map<string, string[]>()
  const uniqueSets = new Map<string, string[][]>()
  for (const k of keys.rows) {
    if (k.primary) primaryKeys.set(k.table, k.cols)
    uniqueSets.set(k.table, [...(uniqueSets.get(k.table) ?? []), k.cols])
  }
  const columnTypes = new Map<string, Map<string, string>>()
  for (const c of columns.rows) {
    if (!columnTypes.has(c.table)) columnTypes.set(c.table, new Map())
    columnTypes.get(c.table)!.set(c.column, c.type)
  }
  const functions = new Map<string, FunctionSignature[]>()
  for (const f of fns.rows) {
    let inNames: string[]
    let inTypes: string[]
    if (!f.arg_modes) {
      inNames = (f.arg_names ?? []).slice(0, f.nargs)
      inTypes = f.in_types
    } else {
      inNames = []
      inTypes = []
      f.arg_modes.forEach((mode, i) => {
        if (mode === 'i' || mode === 'b' || mode === 'v') {
          inNames.push(f.arg_names?.[i] ?? '')
          inTypes.push(f.all_types?.[i] ?? '')
        }
      })
    }
    const returnKind: FunctionSignature['returnKind'] =
      f.rettype === 'void' ? 'void' : f.typtype === 'c' || f.has_out || f.rettype === 'record' ? 'composite' : 'scalar'
    functions.set(f.name, [
      ...(functions.get(f.name) ?? []),
      { inNames, inTypes, required: f.nargs - f.ndefaults, returnsSet: f.retset, returnKind },
    ])
  }
  return { foreignKeys: fks.rows, primaryKeys, uniqueSets, columnTypes, functions }
}

// ---------------------------------------------------------------------------
// Grammar: select lists, filters, logic trees
// ---------------------------------------------------------------------------

/** Split on commas at depth 0, outside double quotes. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let current = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === '\\' && quoted) {
      current += ch + (input[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '(') depth++
    else if (!quoted && ch === ')') depth--
    if (ch === ',' && depth === 0 && !quoted) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.length > 0) parts.push(current)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return value
}

type SelectItem =
  | { kind: 'star' }
  | { kind: 'column'; alias: string; expr: ColumnRef; cast: string | null }
  | { kind: 'embed'; alias: string; relation: string; hint: string | null; inner: boolean; items: SelectItem[] }

interface ColumnRef {
  column: string
  /** JSON path: ['->', 'key'] pairs. */
  path: Array<{ op: '->' | '->>'; key: string }>
}

function parseColumnRef(raw: string): ColumnRef {
  const match = /^([a-z_][a-z0-9_]*)((?:->>?[a-z_][a-z0-9_]*)*)$/.exec(raw)
  if (!match) throw new Unsupported(`column ${JSON.stringify(raw)}`)
  const path: ColumnRef['path'] = []
  const re = /(->>?)([a-z_][a-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(match[2] ?? '')) !== null) path.push({ op: m[1] as '->' | '->>', key: m[2]! })
  return { column: match[1]!, path }
}

function parseSelect(input: string): SelectItem[] {
  const items: SelectItem[] = []
  for (const raw of splitTopLevel(input.replace(/\s+/g, ' '))) {
    const part = raw.trim()
    if (part === '*') {
      items.push({ kind: 'star' })
      continue
    }
    if (part.startsWith('...')) throw new Unsupported(`spread select ${part}`)
    const open = part.indexOf('(')
    if (open >= 0) {
      if (!part.endsWith(')')) throw new Unsupported(`select item ${part}`)
      const head = part.slice(0, open)
      const inner = part.slice(open + 1, -1)
      const [aliasPart, relationPart] = head.includes(':') ? head.split(':', 2) : [null, head]
      const [relation, ...hints] = relationPart!.split('!')
      let hint: string | null = null
      let innerJoin = false
      for (const h of hints) {
        if (h === 'inner') innerJoin = true
        else if (h === 'left') continue
        else hint = h
      }
      if (relation === 'count') throw new Unsupported('count() aggregate')
      items.push({
        kind: 'embed',
        alias: aliasPart ?? relation!,
        relation: relation!,
        hint,
        inner: innerJoin,
        items: parseSelect(inner.length > 0 ? inner : '*'),
      })
      continue
    }
    let rest = part
    let alias: string | null = null
    const colon = rest.indexOf(':')
    if (colon >= 0 && rest[colon + 1] !== ':') {
      alias = rest.slice(0, colon)
      rest = rest.slice(colon + 1)
    }
    let cast: string | null = null
    const castAt = rest.indexOf('::')
    if (castAt >= 0) {
      cast = rest.slice(castAt + 2)
      rest = rest.slice(0, castAt)
      if (!IDENT.test(cast)) throw new Unsupported(`cast ${cast}`)
    }
    const expr = parseColumnRef(rest)
    items.push({
      kind: 'column',
      alias: alias ?? (expr.path.length > 0 ? expr.path[expr.path.length - 1]!.key : expr.column),
      expr,
      cast,
    })
  }
  return items
}

type Condition =
  | { kind: 'leaf'; column: ColumnRef; negate: boolean; op: string; value: string }
  | { kind: 'group'; op: 'and' | 'or'; negate: boolean; children: Condition[] }

/** `op.value` or `not.op.value` (a top-level filter's value). */
function parseOperation(column: ColumnRef, raw: string): Condition {
  let rest = raw
  let negate = false
  if (rest.startsWith('not.')) {
    negate = true
    rest = rest.slice(4)
  }
  const dot = rest.indexOf('.')
  if (dot < 0) throw new Unsupported(`filter ${raw}`)
  return { kind: 'leaf', column, negate, op: rest.slice(0, dot), value: rest.slice(dot + 1) }
}

/** One item of an or=/and= list: `col.op.value`, `col.not.op.value`, `and(...)`, `not.or(...)`. */
function parseLogicItem(raw: string): Condition {
  const groupMatch = /^(not\.)?(and|or)\(([\s\S]*)\)$/.exec(raw)
  if (groupMatch) {
    return {
      kind: 'group',
      op: groupMatch[2] as 'and' | 'or',
      negate: Boolean(groupMatch[1]),
      children: splitTopLevel(groupMatch[3]!).map(parseLogicItem),
    }
  }
  const dot = raw.indexOf('.')
  if (dot < 0) throw new Unsupported(`logic item ${raw}`)
  return parseOperation(parseColumnRef(raw.slice(0, dot)), raw.slice(dot + 1))
}

function parseList(value: string): string[] {
  if (!value.startsWith('(') || !value.endsWith(')')) throw new Unsupported(`list ${value}`)
  return splitTopLevel(value.slice(1, -1)).map(unquote)
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

class Params {
  values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

function columnSql(alias: string, ref: ColumnRef): string {
  let sql = `${alias}.${ident(ref.column)}`
  for (const step of ref.path) sql = `(${sql}${step.op}'${step.key}')`
  return sql
}

function conditionSql(alias: string, cond: Condition, params: Params): string {
  if (cond.kind === 'group') {
    const inner = cond.children.map((c) => conditionSql(alias, c, params)).join(cond.op === 'and' ? ' AND ' : ' OR ')
    return `${cond.negate ? 'NOT ' : ''}(${inner || 'true'})`
  }
  const col = columnSql(alias, cond.column)
  let sql: string
  switch (cond.op) {
    case 'eq':
      sql = `${col} = ${params.add(cond.value)}`
      break
    case 'neq':
      sql = `${col} <> ${params.add(cond.value)}`
      break
    case 'gt':
      sql = `${col} > ${params.add(cond.value)}`
      break
    case 'gte':
      sql = `${col} >= ${params.add(cond.value)}`
      break
    case 'lt':
      sql = `${col} < ${params.add(cond.value)}`
      break
    case 'lte':
      sql = `${col} <= ${params.add(cond.value)}`
      break
    case 'like':
      sql = `${col}::text LIKE ${params.add(cond.value.replace(/\*/g, '%'))}`
      break
    case 'ilike':
      sql = `${col}::text ILIKE ${params.add(cond.value.replace(/\*/g, '%'))}`
      break
    case 'in':
      sql = `${col} = ANY(${params.add(parseList(cond.value))})`
      break
    case 'is': {
      const v = cond.value.toLowerCase()
      if (v === 'null') sql = `${col} IS NULL`
      else if (v === 'true') sql = `${col} IS TRUE`
      else if (v === 'false') sql = `${col} IS FALSE`
      else if (v === 'unknown') sql = `${col} IS UNKNOWN`
      else throw new Unsupported(`is.${cond.value}`)
      break
    }
    case 'isdistinct':
      sql = `${col} IS DISTINCT FROM ${params.add(cond.value)}`
      break
    case 'cs':
      sql = `${col} @> ${params.add(cond.value)}`
      break
    case 'cd':
      sql = `${col} <@ ${params.add(cond.value)}`
      break
    case 'ov':
      sql = `${col} && ${params.add(cond.value)}`
      break
    default:
      throw new Unsupported(`operator ${cond.op}`)
  }
  return cond.negate ? `NOT (${sql})` : sql
}

interface QueryShape {
  /** Filters keyed by embed path ('' = the root resource). */
  filters: Map<string, Condition[]>
  order: Array<{ column: ColumnRef; desc: boolean; nulls: 'first' | 'last' | null }>
  limit: number | null
  offset: number | null
}

const RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

function parseQuery(search: URLSearchParams): QueryShape {
  const shape: QueryShape = { filters: new Map(), order: [], limit: null, offset: null }
  const push = (path: string, cond: Condition) => shape.filters.set(path, [...(shape.filters.get(path) ?? []), cond])
  for (const [key, value] of search.entries()) {
    if (RESERVED_PARAMS.has(key)) continue
    const segments = key.split('.')
    const last = segments[segments.length - 1]!
    const path = segments.slice(0, -1).join('.')
    if (segments.length >= 2 && segments[segments.length - 2] === 'not' && (last === 'or' || last === 'and')) {
      push(segments.slice(0, -2).join('.'), parseLogicItem(`not.${last}${value}`))
    } else if (last === 'or' || last === 'and') {
      push(path, parseLogicItem(`${last}${value}`))
    } else if (last === 'limit' || last === 'offset' || last === 'order') {
      throw new Unsupported(`embedded ${key}`)
    } else {
      push(path, parseOperation(parseColumnRef(last), value))
    }
  }
  const order = search.get('order')
  if (order) {
    for (const term of splitTopLevel(order)) {
      const [column, ...mods] = term.split('.')
      shape.order.push({
        column: parseColumnRef(column!),
        desc: mods.includes('desc'),
        nulls: mods.includes('nullsfirst') ? 'first' : mods.includes('nullslast') ? 'last' : null,
      })
    }
  }
  const limit = search.get('limit')
  if (limit !== null) shape.limit = Number.parseInt(limit, 10)
  const offset = search.get('offset')
  if (offset !== null) shape.offset = Number.parseInt(offset, 10)
  return shape
}

class SqlBuilder {
  private aliasCounter = 0
  constructor(
    private readonly catalog: Catalog,
    readonly params: Params,
    private readonly shape: QueryShape,
  ) {}

  nextAlias(): string {
    return `_t${this.aliasCounter++}`
  }

  private readonly consumed = new Set<string>()

  whereSql(alias: string, path: string): string[] {
    this.consumed.add(path)
    return (this.shape.filters.get(path) ?? []).map((c) => conditionSql(alias, c, this.params))
  }

  /** A filter on an embed path the select list never built would be silently dropped: refuse it. */
  assertFiltersConsumed(): void {
    for (const path of this.shape.filters.keys()) {
      if (!this.consumed.has(path)) throw new Unsupported(`filter on ${path || 'the resource'} that no select item reads`)
    }
  }

  /** The relationship from `table` to an embedded `relation`. */
  private relationship(table: string, relation: string, hint: string | null) {
    const candidates: Array<{ fk: ForeignKey; direction: 'to_one' | 'to_many' }> = []
    for (const fk of this.catalog.foreignKeys) {
      if (fk.fromTable === table && fk.toTable === relation) candidates.push({ fk, direction: 'to_one' })
      if (fk.fromTable === relation && fk.toTable === table && fk.fromTable !== fk.toTable) {
        candidates.push({ fk, direction: 'to_many' })
      }
    }
    const matching = hint
      ? candidates.filter((c) => c.fk.name === hint || (c.fk.fromCols.length === 1 && c.fk.fromCols[0] === hint))
      : candidates
    if (matching.length !== 1) {
      throw new Unsupported(`embed ${table} -> ${relation}${hint ? `!${hint}` : ''}: ${matching.length} relationships`)
    }
    const { fk, direction } = matching[0]!
    // A to-many through a unique foreign key is one-to-one: PostgREST answers an object.
    const unique =
      direction === 'to_many' &&
      (this.catalog.uniqueSets.get(relation) ?? []).some(
        (cols) => cols.length === fk.fromCols.length && cols.every((c) => fk.fromCols.includes(c)),
      )
    return { fk, direction: unique ? ('one_to_one' as const) : direction }
  }

  private joinSql(parentAlias: string, childAlias: string, rel: ReturnType<SqlBuilder['relationship']>): string {
    const { fk, direction } = rel
    return fk.fromCols
      .map((fromCol, i) => {
        const toCol = fk.toCols[i]!
        return direction === 'to_one'
          ? `${childAlias}.${ident(toCol)} = ${parentAlias}.${ident(fromCol)}`
          : `${childAlias}.${ident(fromCol)} = ${parentAlias}.${ident(toCol)}`
      })
      .join(' AND ')
  }

  /** The select list over `alias` (a row of `table`, or null for an RPC result). */
  selectList(alias: string, table: string | null, items: SelectItem[], path: string): { list: string; inner: string[] } {
    const out: string[] = []
    const inner: string[] = []
    for (const item of items) {
      if (item.kind === 'star') {
        out.push(`${alias}.*`)
      } else if (item.kind === 'column') {
        let sql = columnSql(alias, item.expr)
        if (item.cast) sql = `(${sql})::${item.cast}`
        out.push(`${sql} AS ${ident(item.alias)}`)
      } else {
        if (!table) throw new Unsupported('embed on an RPC result')
        const rel = this.relationship(table, item.relation, item.hint)
        const childAlias = this.nextAlias()
        const childPath = path ? `${path}.${item.alias}` : item.alias
        const childWhere = [this.joinSql(alias, childAlias, rel), ...this.whereSql(childAlias, childPath)]
        const childList = this.selectList(childAlias, item.relation, item.items, childPath)
        childWhere.push(...childList.inner)
        const sub = `SELECT ${childList.list} FROM public.${ident(item.relation)} AS ${childAlias} WHERE ${childWhere.join(' AND ')}`
        const rowAlias = `${childAlias}_r`
        if (rel.direction === 'to_many') {
          out.push(
            `(SELECT coalesce(jsonb_agg(to_jsonb(${rowAlias})), '[]'::jsonb) FROM (${sub}) AS ${rowAlias}) AS ${ident(item.alias)}`,
          )
          if (item.inner) inner.push(`EXISTS (${sub})`)
        } else {
          out.push(`(SELECT to_jsonb(${rowAlias}) FROM (${sub} LIMIT 1) AS ${rowAlias}) AS ${ident(item.alias)}`)
          if (item.inner) inner.push(`EXISTS (${sub})`)
        }
      }
    }
    return { list: out.length > 0 ? out.join(', ') : `${alias}.*`, inner }
  }

  orderSql(alias: string): string {
    if (this.shape.order.length === 0) return ''
    return ` ORDER BY ${this.shape.order
      .map((o) => `${columnSql(alias, o.column)} ${o.desc ? 'DESC' : 'ASC'}${o.nulls ? ` NULLS ${o.nulls.toUpperCase()}` : ''}`)
      .join(', ')}`
  }

  limitSql(): string {
    return `${this.shape.limit !== null ? ` LIMIT ${this.shape.limit}` : ''}${this.shape.offset !== null ? ` OFFSET ${this.shape.offset}` : ''}`
  }
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

interface Prefer {
  return: 'representation' | 'minimal' | 'headers-only' | null
  count: boolean
  resolution: 'merge-duplicates' | 'ignore-duplicates' | null
  missingDefault: boolean
}

function parsePrefer(header: string | null): Prefer {
  const tokens = (header ?? '').split(',').map((t) => t.trim())
  const ret = tokens.find((t) => t.startsWith('return='))?.slice(7) ?? null
  const resolution = tokens.find((t) => t.startsWith('resolution='))?.slice(11) ?? null
  return {
    return: ret as Prefer['return'],
    count: tokens.includes('count=exact'),
    resolution: resolution as Prefer['resolution'],
    missingDefault: tokens.includes('missing=default'),
  }
}

interface Answer {
  status: number
  body?: unknown
  contentRange?: string
}

function pgErrorAnswer(err: { code?: string; message?: string; detail?: string; hint?: string }): Answer {
  const code = err.code ?? ''
  let status = 400
  if (code === '23505' || code === '23503') status = 409
  else if (code === '42501') status = 403
  else if (code === '42P01' || code === '42883') status = 404
  else if (/^PT\d{3}$/.test(code)) status = Number(code.slice(2))
  else if (/^(XX|53|57|58)/.test(code)) status = 500
  return { status, body: { code, message: err.message ?? String(err), details: err.detail ?? null, hint: err.hint ?? null } }
}

const SINGULAR_ERROR = (n: number): Answer => ({
  status: 406,
  body: {
    code: 'PGRST116',
    details: `The result contains ${n} rows`,
    hint: null,
    message: 'JSON object requested, multiple (or no) rows returned',
  },
})

function serialiseArg(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (type === 'json' || type === 'jsonb') return JSON.stringify(value)
  if (type.endsWith('[]')) {
    if (!Array.isArray(value)) throw new Unsupported(`array argument of type ${type} given ${typeof value}`)
    return value.map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v))
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export interface PgRest {
  /** The fetch to hand supabase-js (global.fetch). */
  fetch: typeof fetch
  /** Every request this shim could not answer faithfully, as `METHOD path?query: reason`. */
  unsupported: string[]
}

export function createPgRest(
  options: {
    role?: PgRestRole
    userId?: string | null
    /** Further JWT claims of the session, e.g. is_anonymous for a sandbox visitor. */
    claims?: Record<string, unknown>
  } = {},
): PgRest {
  const role: PgRestRole = options.role ?? 'service_role'
  const unsupported: string[] = []

  async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getClient()
    try {
      if (!catalogPromise) catalogPromise = loadCatalog(client)
      await catalogPromise
      await client.query('BEGIN')
      const claims = role === 'service_role' ? { role } : { ...options.claims, role, sub: options.userId }
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
      await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role])
      if (options.userId) await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [options.userId])
      await client.query(`SET LOCAL TIME ZONE 'UTC'`)
      await client.query(`SET LOCAL ROLE ${role}`)
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async function rows(client: PoolClient, sql: string, params: Params): Promise<unknown[]> {
    const result = await client.query<{ r: unknown }>(sql, params.values)
    return result.rows.map((row) => row.r)
  }

  /** Rolls the request back (PostgREST does for a singular answer of the wrong size) by throwing past COMMIT. */
  class Rollback extends Error {
    constructor(readonly answer: Answer) {
      super('rollback')
    }
  }

  function finish(data: unknown[], singular: boolean, mutation: boolean): Answer {
    if (singular) {
      if (data.length !== 1) {
        if (mutation) throw new Rollback(SINGULAR_ERROR(data.length))
        return SINGULAR_ERROR(data.length)
      }
      return { status: 200, body: data[0] }
    }
    return { status: 200, body: data }
  }

  async function handleTable(method: string, table: string, url: URL, headers: Headers, body: unknown): Promise<Answer> {
    const catalog = await (catalogPromise ?? Promise.resolve(null))
    const shape = parseQuery(url.searchParams)
    const prefer = parsePrefer(headers.get('Prefer'))
    const singular = (headers.get('Accept') ?? '').includes('application/vnd.pgrst.object+json')
    const select = parseSelect(url.searchParams.get('select') ?? '*')
    ident(table)

    return inTransaction(async (client) => {
      const cat = catalog ?? (await catalogPromise!)
      const params = new Params()
      const b = new SqlBuilder(cat, params, shape)

      if (method === 'GET' || method === 'HEAD') {
        const alias = b.nextAlias()
        const { list, inner } = b.selectList(alias, table, select, '')
        const where = [...b.whereSql(alias, ''), ...inner]
        b.assertFiltersConsumed()
        const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
        let contentRange: string | undefined
        if (prefer.count) {
          const countParams = new Params()
          const cb = new SqlBuilder(cat, countParams, shape)
          const ca = cb.nextAlias()
          const countInner = cb.selectList(ca, table, select, '').inner
          const cw = [...cb.whereSql(ca, ''), ...countInner]
          const counted = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM public.${ident(table)} AS ${ca}${cw.length > 0 ? ` WHERE ${cw.join(' AND ')}` : ''}`,
            countParams.values,
          )
          contentRange = `*/${counted.rows[0]!.n}`
        }
        if (method === 'HEAD') return { status: 200, contentRange }
        const data = await rows(
          client,
          `SELECT to_jsonb(_s) AS r FROM (SELECT ${list} FROM public.${ident(table)} AS ${alias}${whereSql}${b.orderSql(alias)}${b.limitSql()}) AS _s`,
          params,
        )
        const answer = finish(data, singular, false)
        return contentRange ? { ...answer, contentRange: `0-${Math.max(data.length - 1, 0)}/${contentRange.slice(2)}` } : answer
      }

      // Writes: the modified rows in a CTE, then the select list over them.
      let modify: string
      const writeAlias = '_w'
      if (method === 'POST') {
        const records = Array.isArray(body) ? body : [body]
        if (records.length === 0) return { status: 201, body: [] }
        const columnsParam = url.searchParams.get('columns')
        const columns = columnsParam
          ? splitTopLevel(columnsParam).map(unquote)
          : Object.keys((records[0] ?? {}) as Record<string, unknown>)
        if (prefer.missingDefault && records.some((r) => Object.keys(r as object).length !== columns.length)) {
          throw new Unsupported('missing=default with rows of different columns')
        }
        const colList = columns.map(ident).join(', ')
        let conflict = ''
        if (prefer.resolution) {
          const onConflict = url.searchParams.get('on_conflict')
          const target = onConflict ? splitTopLevel(onConflict).map(unquote) : cat.primaryKeys.get(table) ?? []
          if (target.length === 0) throw new Unsupported(`upsert on ${table} without a conflict target`)
          const updates = columns.filter((c) => !target.includes(c))
          conflict =
            prefer.resolution === 'ignore-duplicates' || updates.length === 0
              ? ` ON CONFLICT (${target.map(ident).join(', ')}) DO NOTHING`
              : ` ON CONFLICT (${target.map(ident).join(', ')}) DO UPDATE SET ${updates.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`
        }
        modify = `INSERT INTO public.${ident(table)} AS ${writeAlias} (${colList})
                  SELECT ${colList} FROM jsonb_populate_recordset(NULL::public.${ident(table)}, ${params.add(JSON.stringify(records))}::jsonb)${conflict}
                  RETURNING ${writeAlias}.*`
      } else if (method === 'PATCH') {
        const values = (body ?? {}) as Record<string, unknown>
        const columns = Object.keys(values)
        if (columns.length === 0) throw new Unsupported('PATCH with an empty body')
        const where = b.whereSql(writeAlias, '')
        modify = `UPDATE public.${ident(table)} AS ${writeAlias}
                     SET ${columns.map((c) => `${ident(c)} = _src.${ident(c)}`).join(', ')}
                    FROM jsonb_populate_record(NULL::public.${ident(table)}, ${params.add(JSON.stringify(values))}::jsonb) AS _src
                   ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                   RETURNING ${writeAlias}.*`
      } else if (method === 'DELETE') {
        const where = b.whereSql(writeAlias, '')
        modify = `DELETE FROM public.${ident(table)} AS ${writeAlias}
                   ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                   RETURNING ${writeAlias}.*`
      } else {
        throw new Unsupported(`method ${method}`)
      }
      if (shape.order.length > 0 || shape.limit !== null) throw new Unsupported('order/limit on a write')

      const alias = b.nextAlias()
      const { list } = b.selectList(alias, table, select, '')
      b.assertFiltersConsumed()
      const data = await rows(client, `WITH _m AS (${modify}) SELECT to_jsonb(_s) AS r FROM (SELECT ${list} FROM _m AS ${alias}) AS _s`, params)
      const created = method === 'POST' ? 201 : 200
      if (prefer.return !== 'representation') {
        if (singular && data.length !== 1) throw new Rollback(SINGULAR_ERROR(data.length))
        return { status: method === 'POST' ? 201 : 204 }
      }
      const answer = finish(data, singular, true)
      return { ...answer, status: answer.status === 200 ? created : answer.status }
    })
  }

  async function handleRpc(method: string, fn: string, url: URL, headers: Headers, body: unknown): Promise<Answer> {
    if (method !== 'POST') throw new Unsupported(`RPC over ${method}`)
    ident(fn)
    const args = (body ?? {}) as Record<string, unknown>
    const shape = parseQuery(url.searchParams)
    const singular = (headers.get('Accept') ?? '').includes('application/vnd.pgrst.object+json')
    const selectParam = url.searchParams.get('select')

    return inTransaction(async (client) => {
      const cat = await catalogPromise!
      const keys = Object.keys(args)
      const candidates = (cat.functions.get(fn) ?? []).filter(
        (sig) => keys.every((k) => sig.inNames.includes(k)) && sig.inNames.slice(0, sig.required).every((n) => keys.includes(n)),
      )
      if (candidates.length !== 1) throw new Unsupported(`rpc ${fn}(${keys.join(', ')}): ${candidates.length} matching functions`)
      const sig = candidates[0]!
      const params = new Params()
      const argSql = keys
        .map((k) => {
          const type = sig.inTypes[sig.inNames.indexOf(k)]!
          return `${ident(k)} => ${params.add(serialiseArg(type, args[k]))}::${type}`
        })
        .join(', ')
      const call = `public.${ident(fn)}(${argSql})`

      if (sig.returnKind === 'void') {
        await client.query(`SELECT ${call}`, params.values)
        return { status: 200, body: null }
      }
      const filtered = shape.filters.size > 0 || shape.order.length > 0 || shape.limit !== null || selectParam
      if (sig.returnKind === 'scalar') {
        if (filtered) throw new Unsupported(`filters on scalar rpc ${fn}`)
        if (!sig.returnsSet) {
          const data = await rows(client, `SELECT to_jsonb(${call}) AS r`, params)
          return { status: 200, body: data[0] ?? null }
        }
        const data = await rows(client, `SELECT to_jsonb(_f._v) AS r FROM ${call} AS _f(_v)`, params)
        return finish(data, singular, false)
      }
      const b = new SqlBuilder(cat, params, shape)
      const alias = b.nextAlias()
      const { list } = b.selectList(alias, null, parseSelect(selectParam ?? '*'), '')
      const where = b.whereSql(alias, '')
      b.assertFiltersConsumed()
      const data = await rows(
        client,
        `SELECT to_jsonb(_s) AS r FROM (SELECT ${list} FROM ${call} AS ${alias}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}${b.orderSql(alias)}${b.limitSql()}) AS _s`,
        params,
      )
      if (!sig.returnsSet && !singular) return { status: 200, body: data[0] ?? null }
      return finish(data, singular, false)
    })
  }

  async function handleAuth(method: string, path: string): Promise<Answer> {
    const match = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(path)
    if (method !== 'GET' || !match) throw new Unsupported(`auth ${method} ${path}`)
    const client = await getClient()
    try {
      const { rows: users } = await client.query<{ u: Record<string, unknown> }>(
        `SELECT jsonb_build_object('id', id, 'email', email, 'aud', aud, 'role', role, 'created_at', created_at,
                'app_metadata', coalesce(raw_app_meta_data, '{}'::jsonb), 'user_metadata', coalesce(raw_user_meta_data, '{}'::jsonb)) AS u
           FROM auth.users WHERE id = $1`,
        [match[1]],
      )
      if (users.length === 0) return { status: 404, body: { code: 404, error_code: 'user_not_found', msg: 'User not found' } }
      return { status: 200, body: users[0]!.u }
    } finally {
      client.release()
    }
  }

  const pgFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const rawBody = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : ''
    let answer: Answer
    try {
      const body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        answer = await handleRpc(method, url.pathname.slice('/rest/v1/rpc/'.length), url, headers, body)
      } else if (url.pathname.startsWith('/rest/v1/')) {
        answer = await handleTable(method, url.pathname.slice('/rest/v1/'.length), url, headers, body)
      } else if (url.pathname.startsWith('/auth/v1/')) {
        answer = await handleAuth(method, url.pathname)
      } else {
        throw new Unsupported(`path ${url.pathname}`)
      }
    } catch (err) {
      if (err instanceof Rollback) {
        answer = err.answer
      } else if (err instanceof Unsupported) {
        unsupported.push(`${method} ${url.pathname}${url.search}: ${err.message}`)
        answer = { status: 400, body: { code: 'PGRST100', message: `pg-real PostgREST shim: unsupported ${err.message}`, details: null, hint: null } }
      } else {
        answer = pgErrorAnswer(err as { code?: string; message?: string })
      }
    }
    const responseHeaders = new Headers({ 'Content-Type': 'application/json; charset=utf-8' })
    if (answer.contentRange) responseHeaders.set('Content-Range', answer.contentRange)
    const status = answer.status
    const text = answer.body === undefined || status === 204 ? null : JSON.stringify(answer.body)
    return new Response(method === 'HEAD' ? null : text, { status, headers: responseHeaders })
  }

  return { fetch: pgFetch as typeof fetch, unsupported }
}
