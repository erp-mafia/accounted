/**
 * A service-role Supabase client that can only reach one company.
 *
 * The invoicer role (lib/auth/invoicer-role.ts) writes nothing through its own
 * session: the database leaves it out of every write check. The routes it may
 * write through (INVOICER_ROUTES, `scoped`) run with this client instead, so
 * creating and sending an invoice, and the voucher the engine books when it
 * is sent, work as they do for a member. RLS does not apply to it, so the
 * company boundary is enforced here, on every request the client makes,
 * before it leaves the process:
 *
 *   - table reads, updates and deletes get `company_id=eq.<company>` added
 *     (the companies table: `id=eq.<company>`), whatever the caller filtered;
 *   - inserts and upserts must carry that company_id on every row, and an
 *     update may not move a row to another company;
 *   - a child table without company_id (invoice_items, journal_entry_lines)
 *     must be filtered, or inserted, by its parent key;
 *   - user tables are filtered to the signed-in user, public reference data
 *     may only be read;
 *   - an RPC must name the company in a company_id argument, and only it;
 *   - a storage object key must contain the company id as a path segment;
 *   - anything else (auth, edge functions, buckets) is refused.
 *
 * A refused request never reaches Supabase: it answers 403 with code 42501,
 * which callers already handle as a permission error, and logs a warning.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { createLogger, type Logger } from '@/lib/logger'

export interface CompanyScope {
  companyId: string
  /** The signed-in user the requests are made for: user tables are filtered to them. */
  userId: string
}

type TableRule =
  | { kind: 'column'; column: string }
  | { kind: 'parent'; column: string }
  | { kind: 'user'; column: string }
  | { kind: 'reference' }

/** Tables without a company_id column that the invoicing flow touches. Every other table is filtered on company_id. */
const TABLE_RULES: Readonly<Record<string, TableRule>> = {
  companies: { kind: 'column', column: 'id' },
  invoice_items: { kind: 'parent', column: 'invoice_id' },
  journal_entry_lines: { kind: 'parent', column: 'journal_entry_id' },
  user_preferences: { kind: 'user', column: 'user_id' },
  notification_settings: { kind: 'user', column: 'user_id' },
  currencies: { kind: 'reference' },
  exchange_rates: { kind: 'reference' },
}

const READ_METHODS = new Set(['GET', 'HEAD'])
const COMPANY_ARGUMENT = /^(p_|_)?company_id$/

export class CompanyScopeViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompanyScopeViolation'
  }
}

function refuse(message: string): never {
  throw new CompanyScopeViolation(message)
}

function parseJson(body: unknown): unknown {
  if (body === undefined || body === null || body === '') return undefined
  if (typeof body !== 'string') refuse('a request body that is not JSON cannot be checked')
  try {
    return JSON.parse(body)
  } catch {
    // Not dropped: an unparseable body becomes the refusal, which is logged.
    return refuse('a request body that is not JSON cannot be checked')
  }
}

function rowsOf(payload: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(payload) ? payload : [payload]
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) refuse('a row is not an object')
    return row as Record<string, unknown>
  })
}

/** A filter the caller set on `column`, as PostgREST reads it (eq or in). */
function filtersOn(url: URL, column: string): string[] {
  return url.searchParams.getAll(column).filter((value) => /^(eq|in)\./.test(value))
}

function scopeTableRequest(scope: CompanyScope, table: string, method: string, url: URL, body: unknown): URL {
  const rule: TableRule = TABLE_RULES[table] ?? { kind: 'column', column: 'company_id' }
  const scoped = new URL(url)

  if (rule.kind === 'reference') {
    if (!READ_METHODS.has(method)) refuse(`${table} may only be read`)
    return scoped
  }

  if (rule.kind === 'user') {
    if (!READ_METHODS.has(method)) refuse(`${table} may only be read`)
    scoped.searchParams.append(rule.column, `eq.${scope.userId}`)
    return scoped
  }

  if (rule.kind === 'parent') {
    if (method === 'POST') {
      for (const row of rowsOf(parseJson(body))) {
        if (typeof row[rule.column] !== 'string') refuse(`${table} rows must name their ${rule.column}`)
      }
      return scoped
    }
    if (filtersOn(url, rule.column).length === 0) refuse(`${table} must be filtered by ${rule.column}`)
    return scoped
  }

  const value = scope.companyId
  if (method === 'POST') {
    for (const row of rowsOf(parseJson(body))) {
      if (row[rule.column] !== value) refuse(`${table} rows must carry ${rule.column} ${value}`)
    }
    return scoped
  }
  if (method === 'PATCH') {
    const payload = parseJson(body)
    if (payload !== undefined) {
      for (const row of rowsOf(payload)) {
        if (rule.column in row && row[rule.column] !== value) refuse(`${table} rows may not move to another company`)
      }
    }
  } else if (!READ_METHODS.has(method) && method !== 'DELETE') {
    refuse(`${method} is not a PostgREST table method`)
  }
  scoped.searchParams.append(rule.column, `eq.${value}`)
  return scoped
}

function scopeRpcRequest(scope: CompanyScope, fn: string, method: string, url: URL, body: unknown): URL {
  const args: Record<string, unknown> = {}
  if (method === 'POST') {
    const payload = parseJson(body)
    if (payload !== undefined) Object.assign(args, rowsOf(payload)[0])
  } else if (READ_METHODS.has(method)) {
    url.searchParams.forEach((value, key) => {
      args[key] = value
    })
  } else {
    refuse(`${method} is not an RPC method`)
  }
  const companyArgs = Object.keys(args).filter((key) => COMPANY_ARGUMENT.test(key))
  if (companyArgs.length === 0) refuse(`rpc ${fn} names no company`)
  for (const key of companyArgs) {
    if (args[key] !== scope.companyId) refuse(`rpc ${fn} names another company`)
  }
  return new URL(url)
}

const STORAGE_ACTIONS = ['upload/sign', 'list', 'move', 'copy', 'sign', 'public', 'authenticated', 'info']

function scopeStorageRequest(scope: CompanyScope, rest: string, body: unknown, url: URL): URL {
  let path = rest
  const action = STORAGE_ACTIONS.find((a) => path === a || path.startsWith(`${a}/`))
  if (action) path = path.slice(action.length).replace(/^\//, '')

  const keys: string[] = []
  const [, ...keyParts] = path.split('/')
  if (keyParts.length > 0 && keyParts.join('/') !== '') keys.push(keyParts.join('/'))

  // Uploads carry the file itself; only the JSON bodies of list, move, copy,
  // remove and batch-sign name objects.
  let payload: unknown
  if (typeof body === 'string') {
    try {
      payload = JSON.parse(body)
    } catch {
      // A text upload: its object key is in the path, checked below.
      payload = undefined
    }
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>
    for (const field of ['prefix', 'sourceKey', 'destinationKey']) {
      if (typeof record[field] === 'string') keys.push(record[field] as string)
    }
    for (const field of ['prefixes', 'paths']) {
      if (Array.isArray(record[field])) keys.push(...(record[field] as unknown[]).map(String))
    }
  }

  if (keys.length === 0) refuse('a storage request must name its objects')
  for (const key of keys) {
    if (!key.split('/').includes(scope.companyId)) refuse(`storage object ${key} is outside the company`)
  }
  return new URL(url)
}

/**
 * Check one outgoing Supabase request against the company scope. Returns the
 * URL to send (with the company filter added for table reads, updates and
 * deletes), or throws CompanyScopeViolation.
 */
export function scopeSupabaseRequest(scope: CompanyScope, method: string, url: URL, body?: unknown): URL {
  const upper = method.toUpperCase()
  const rest = url.pathname.indexOf('/rest/v1/')
  if (rest >= 0) {
    const [first, second] = url.pathname.slice(rest + '/rest/v1/'.length).split('/')
    if (first === 'rpc') {
      if (!second) refuse('rpc without a function name')
      return scopeRpcRequest(scope, decodeURIComponent(second), upper, url, body)
    }
    if (!first || second) refuse(`unexpected PostgREST path ${url.pathname}`)
    return scopeTableRequest(scope, decodeURIComponent(first), upper, url, body)
  }
  const storage = url.pathname.indexOf('/storage/v1/object/')
  if (storage >= 0) {
    return scopeStorageRequest(scope, url.pathname.slice(storage + '/storage/v1/object/'.length), body, url)
  }
  return refuse(`${url.pathname} is outside the company scope`)
}

function refusalResponse(message: string): Response {
  return new Response(
    JSON.stringify({ code: '42501', message: `company scope: ${message}`, details: null, hint: null, statusCode: '403', error: 'Forbidden' }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
}

/** A fetch that sends only what scopeSupabaseRequest lets through. */
export function companyScopedFetch(scope: CompanyScope, baseFetch: typeof fetch = fetch, log?: Logger): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request ? request.url : String(input))
    const method = init?.method ?? request?.method ?? 'GET'
    let scopedUrl: URL
    try {
      scopedUrl = scopeSupabaseRequest(scope, method, url, init?.body)
    } catch (err) {
      if (!(err instanceof CompanyScopeViolation)) throw err
      log?.warn('company-scoped client refused a request', {
        companyId: scope.companyId,
        method,
        path: url.pathname,
        reason: err.message,
      })
      return refusalResponse(err.message)
    }
    return baseFetch(request ? new Request(scopedUrl, request) : scopedUrl.toString(), init)
  }
}

/** The service-role client for one company and one signed-in user. See the file header. */
export function createCompanyScopedClient(scope: CompanyScope, log?: Logger): SupabaseClient {
  return createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    global: { fetch: companyScopedFetch(scope, fetch, log ?? createLogger('company-scoped-client')) },
  })
}
