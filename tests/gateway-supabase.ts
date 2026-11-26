/**
 * supabase-js in front of a fake gateway and an in-memory PostgREST, for the
 * reads whose id list travels in the query string.
 *
 * supabase-js builds every request itself, so the URL a test measures is the
 * one production sends: `.in()` puts its list in the GET query string, about
 * 39 characters per uuid. The gateway refuses a URL past GATEWAY_URL_LIMIT
 * with 414 before PostgREST sees it, as a self-hosted Kong with the stock
 * 8 KB header buffer does (hosted Supabase stops at about 16 KB, so 8 KB is
 * the stricter of the two). Behind it, PostgREST answers from the seeded
 * tables: it applies the filters, orders, pages with offset and limit, and
 * returns at most POSTGREST_MAX_ROWS rows, as max-rows does.
 *
 * Grammar: eq, neq, gt, gte, lt, lte, in, is, like and ilike, each also under
 * not., or=(...) and and=(...) groups, a filter on an embedded resource's
 * column (`embed.column`, read off the row's nested object, and the row kept
 * only when it holds, as for an !inner embed), order (asc or desc, nulls
 * first or last), offset, limit, a single object and an exact count. A
 * comparison with a null is unknown, as in SQL, so `not.` never keeps it.
 * select is not projected: a row comes back whole, as seeded. Writes are
 * recorded and change nothing; an RPC answers what the test gives it.
 * Anything outside the grammar is answered with a 400 and listed in
 * `unmodelled`, so a read is never answered as if its filter held.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { compareLikePostgres, POSTGREST_MAX_ROWS } from './helpers'

/** A self-hosted Kong's stock header buffer: the stricter gateway limit. */
export const GATEWAY_URL_LIMIT = 8 * 1024

type Row = Record<string, unknown>

export interface GatewayRequest {
  method: string
  /** The table, or `rpc:<name>`. */
  table: string
  /** The whole URL, as the gateway measures it. */
  url: string
  /** Values across the request's in.(...) lists. */
  inValues: number
  /** The JSON body of a write or an RPC call. */
  body: unknown
}

export interface GatewayOptions {
  /** The answer of each RPC, from its arguments. An RPC without one answers 404. */
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>
  /**
   * Answer this request with a statement timeout (57014), a read that fails
   * for another reason than its length. `index` is its place in `requests`.
   */
  refuse?: (request: GatewayRequest, index: number) => boolean
}

class Unmodelled extends Error {}

/** SQL truth: null is unknown, a comparison with a null. */
type Truth = boolean | null
type Test = (row: Row) => Truth

const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'like', 'ilike'])

/** Split on the commas outside parentheses and double quotes. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quoted && c === '\\') i++
    else if (c === '"') quoted = !quoted
    else if (!quoted && c === '(') depth++
    else if (!quoted && c === ')') depth--
    else if (!quoted && depth === 0 && c === ',') {
      parts.push(input.slice(start, i))
      start = i + 1
    }
  }
  parts.push(input.slice(start))
  return parts
}

const unquote = (value: string) =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value

/** The values of an in.(...) operand. */
function listOf(operand: string): string[] {
  if (!operand.startsWith('(') || !operand.endsWith(')')) throw new Unmodelled(`in operand ${operand}`)
  const inner = operand.slice(1, -1)
  return inner === '' ? [] : splitTopLevel(inner).map(unquote)
}

/** The values of the request's `column=in.(...)` filter; empty when it has none. */
export function inListOf(request: GatewayRequest, column: string): string[] {
  const value = new URL(request.url).searchParams.get(column)
  return value?.startsWith('in.') ? listOf(value.slice('in.'.length)) : []
}

/** How many values the request's in.(...) lists carry, its column filters and its or/and groups alike. */
function inValuesOf(search: URLSearchParams): number {
  let count = 0
  for (const value of search.values()) {
    for (const match of value.matchAll(/(?:^|[.,(])in\.(\((?:[^()"]|"(?:[^"\\]|\\.)*")*\))/g)) count += listOf(match[1]).length
  }
  return count
}

function compareTo(value: unknown, operand: string): number {
  if (typeof value === 'number') return value - Number(operand)
  const text = String(value)
  return text < operand ? -1 : text > operand ? 1 : 0
}

function likeTest(pattern: string, flags: string): (value: unknown) => Truth {
  const source = [...pattern]
    .map((c) => (c === '*' || c === '%' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  const re = new RegExp(`^${source}$`, flags)
  return (value) => (value == null ? null : re.test(String(value)))
}

function operation(op: string, operand: string): (value: unknown) => Truth {
  switch (op) {
    case 'is':
      if (operand === 'null' || operand === 'unknown') return (v) => v == null
      if (operand === 'true' || operand === 'false') return (v) => v === (operand === 'true')
      break
    case 'in': {
      const list = listOf(operand)
      return (v) => (v == null ? null : list.includes(String(v)))
    }
    case 'eq':
      return (v) => (v == null ? null : String(v) === unquote(operand))
    case 'neq':
      return (v) => (v == null ? null : String(v) !== unquote(operand))
    case 'gt':
      return (v) => (v == null ? null : compareTo(v, operand) > 0)
    case 'gte':
      return (v) => (v == null ? null : compareTo(v, operand) >= 0)
    case 'lt':
      return (v) => (v == null ? null : compareTo(v, operand) < 0)
    case 'lte':
      return (v) => (v == null ? null : compareTo(v, operand) <= 0)
    case 'like':
      return likeTest(operand, '')
    case 'ilike':
      return likeTest(operand, 'i')
  }
  throw new Unmodelled(`operator ${op}.${operand}`)
}

/** `[not.]op.operand` on one column, or on one column of an embedded resource. */
function columnTest(column: string, expression: string): Test {
  const negate = expression.startsWith('not.')
  const rest = negate ? expression.slice(4) : expression
  const dot = rest.indexOf('.')
  const holds = operation(dot < 0 ? rest : rest.slice(0, dot), dot < 0 ? '' : rest.slice(dot + 1))
  const test = (value: unknown): Truth => {
    const truth = holds(value)
    return negate && truth !== null ? !truth : truth
  }
  const embedAt = column.indexOf('.')
  if (embedAt < 0) return (row) => test(row[column])
  const embed = column.slice(0, embedAt)
  const field = column.slice(embedAt + 1)
  return (row) => {
    const nested = row[embed]
    const items = (Array.isArray(nested) ? nested : nested == null ? [] : [nested]) as Row[]
    return items.some((item) => test(item[field]) === true)
  }
}

/** One item of an or/and group: a nested group, or `column.[not.]op.operand`. */
function logicItem(item: string): Test {
  const group = /^(not\.)?(and|or)(\([\s\S]*\))$/.exec(item)
  if (group) return logicGroup(group[2] as 'and' | 'or', group[3], group[1] !== undefined)
  const parts = item.split('.')
  const at = parts.findIndex((part, i) => i > 0 && (part === 'not' || OPERATORS.has(part)))
  if (at < 0) throw new Unmodelled(`logic item ${item}`)
  return columnTest(parts.slice(0, at).join('.'), parts.slice(at).join('.'))
}

function logicGroup(kind: 'and' | 'or', value: string, negate: boolean): Test {
  if (!value.startsWith('(') || !value.endsWith(')')) throw new Unmodelled(`${kind} group ${value}`)
  const tests = splitTopLevel(value.slice(1, -1)).map(logicItem)
  return (row) => {
    const truths = tests.map((test) => test(row))
    const truth =
      kind === 'or'
        ? truths.includes(true) ? true : truths.includes(null) ? null : false
        : truths.includes(false) ? false : truths.includes(null) ? null : true
    return negate && truth !== null ? !truth : truth
  }
}

interface Order {
  column: string
  ascending: boolean
  nullsFirst: boolean
}

function ordersOf(value: string): Order[] {
  return splitTopLevel(value).map((term) => {
    const [column, ...modifiers] = term.split('.')
    const ascending = !modifiers.includes('desc')
    const nullsFirst = modifiers.includes('nullsfirst') ? true : modifiers.includes('nullslast') ? false : !ascending
    return { column, ascending, nullsFirst }
  })
}

/** The seeded rows a read selects, in its order and window, with the count before the window. */
function answer(rows: readonly Row[], search: URLSearchParams): { rows: Row[]; total: number; offset: number } {
  const tests: Test[] = []
  let orders: Order[] = []
  let offset = 0
  let limit = Infinity
  for (const [key, value] of search) {
    if (key === 'select' || key === 'columns' || key === 'on_conflict') continue
    if (key === 'order') orders = ordersOf(value)
    else if (key === 'offset') offset = Number(value)
    else if (key === 'limit') limit = Number(value)
    else if (/\.(order|limit|offset)$/.test(key)) continue // an embed's own modifiers: embeds come back as seeded
    else if (/^(not\.)?(or|and)$/.test(key)) {
      tests.push(logicGroup(key.replace(/^not\./, '') as 'and' | 'or', value, key.startsWith('not.')))
    } else tests.push(columnTest(key, value))
  }
  const matched = rows.filter((row) => tests.every((test) => test(row) === true))
  const ordered = orders.length
    ? [...matched].sort((a, b) => {
        for (const order of orders) {
          const c = compareLikePostgres(a[order.column], b[order.column], order)
          if (c !== 0) return c
        }
        return 0
      })
    : matched
  const end = Math.min(offset + limit, offset + POSTGREST_MAX_ROWS)
  return { rows: structuredClone(ordered.slice(offset, end)), total: matched.length, offset }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const SINGULAR = (n: number) =>
  json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${n} rows`, hint: null })

class NoRealtime {
  constructor() {
    throw new Error('gateway fake: realtime is not modelled')
  }
}

/** A project ref of a real one's length, so the URLs are as long as production's. */
const PROJECT_URL = 'https://abcdefghijklmnopqrst.supabase.co'

export function createGatewaySupabase(tables: Record<string, readonly Row[]> = {}, options: GatewayOptions = {}) {
  const requests: GatewayRequest[] = []
  const unmodelled: string[] = []

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const parsed = new URL(url)
    const path = parsed.pathname.replace(/^\/rest\/v1\//, '')
    const rpcName = path.startsWith('rpc/') ? path.slice('rpc/'.length) : null
    const body = typeof init?.body === 'string' && init.body !== '' ? JSON.parse(init.body) : undefined
    let inValues = 0
    try {
      inValues = inValuesOf(parsed.searchParams)
    } catch {
      // Counted as none; the answer below reports the list it cannot read.
    }
    const request: GatewayRequest = { method, table: rpcName ? `rpc:${rpcName}` : path, url, inValues, body }
    const index = requests.push(request) - 1

    // The gateway: a URL past its limit never reaches PostgREST.
    if (url.length > GATEWAY_URL_LIMIT) return new Response('Request-URI Too Large', { status: 414 })
    if (options.refuse?.(request, index)) {
      return json(500, { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null })
    }

    const headers = new Headers(init?.headers)
    const wantsObject = (headers.get('Accept') ?? '').startsWith('application/vnd.pgrst.object+json')
    const prefer = headers.get('Prefer') ?? ''
    try {
      if (path === parsed.pathname) throw new Unmodelled(`${method} ${parsed.pathname}`)
      if (rpcName) {
        const run = options.rpc?.[rpcName]
        if (!run) return json(404, { code: 'PGRST202', message: `Could not find the function public.${rpcName}`, details: null, hint: null })
        return json(200, run((body ?? {}) as Record<string, unknown>) ?? null)
      }
      if (method !== 'GET' && method !== 'HEAD') {
        // A write is recorded in `requests` and changes nothing.
        const status = method === 'POST' ? 201 : 200
        if (!prefer.includes('return=representation')) return new Response(null, { status })
        const echoed = method === 'POST' ? ((Array.isArray(body) ? body : [body]) as Row[]) : []
        if (wantsObject) return echoed.length === 1 ? json(status, echoed[0]) : SINGULAR(echoed.length)
        return json(status, echoed)
      }
      const read = answer(tables[path] ?? [], parsed.searchParams)
      const range =
        read.rows.length > 0 ? `${read.offset}-${read.offset + read.rows.length - 1}/${read.total}` : `*/${read.total}`
      const countHeaders: Record<string, string> = prefer.includes('count=') ? { 'content-range': range } : {}
      if (method === 'HEAD') return new Response(null, { status: 200, headers: countHeaders })
      if (wantsObject) return read.rows.length === 1 ? json(200, read.rows[0], countHeaders) : SINGULAR(read.rows.length)
      return json(200, read.rows, countHeaders)
    } catch (err) {
      if (!(err instanceof Unmodelled)) throw err
      unmodelled.push(`${request.table}: ${err.message}`)
      return json(400, { code: 'PGRST100', message: `gateway fake: not modelled: ${err.message}`, details: null, hint: null })
    }
  }

  const supabase = createClient(PROJECT_URL, 'gateway-fake-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
    realtime: { transport: NoRealtime as never },
  }) as SupabaseClient

  /** The requests against one table (or `rpc:<name>`). */
  const requestsTo = (table: string) => requests.filter((request) => request.table === table)

  return { supabase, requests, requestsTo, unmodelled }
}
