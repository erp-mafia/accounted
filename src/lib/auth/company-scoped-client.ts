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
 *   - inserts must carry that company_id on every row, and an update may not
 *     move a row to another company; an upsert must name that column in its
 *     conflict target, so the row it would merge into is this company's;
 *   - a child table without company_id (invoice_items, journal_entry_lines)
 *     must name its parents by key: a filter on the parent key, or the key on
 *     every row written. Before the request is sent, those parents are read
 *     back with the company filter, and it is sent only when all of them are
 *     this company's;
 *   - every resource embedded in `select` is filtered the way the table
 *     itself would be; a child table may only be embedded under its parent;
 *   - user tables are filtered to the signed-in user, public reference data
 *     may only be read;
 *   - an RPC must name the company in a company_id argument, and every
 *     argument that names a company must name this one;
 *   - a storage object must sit in the company's folder of the documents
 *     bucket, documents/<company>/, where the bucket's own policy looks;
 *   - anything else (auth, edge functions, other buckets, realtime) is
 *     refused.
 *
 * What it does not decide: the ids a written row refers to (a customer_id, an
 * article_id) are the handler's to check, as the routes do before they write,
 * and a function checks its own arguments against the company it is given.
 * Reads through such an id still stay in the company, by the filters above.
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
  | { kind: 'parent'; column: string; parent: string }
  | { kind: 'user'; column: string }
  | { kind: 'reference' }

/** Tables without a company_id column that the invoicing flow touches. Every other table is filtered on company_id. */
const TABLE_RULES: Readonly<Record<string, TableRule>> = {
  companies: { kind: 'column', column: 'id' },
  invoice_items: { kind: 'parent', column: 'invoice_id', parent: 'invoices' },
  journal_entry_lines: { kind: 'parent', column: 'journal_entry_id', parent: 'journal_entries' },
  user_preferences: { kind: 'user', column: 'user_id' },
  notification_settings: { kind: 'user', column: 'user_id' },
  currencies: { kind: 'reference' },
  exchange_rates: { kind: 'reference' },
}

function ruleFor(table: string): TableRule {
  return Object.hasOwn(TABLE_RULES, table) ? TABLE_RULES[table] : { kind: 'column', column: 'company_id' }
}

/**
 * The folder that holds one company's objects, for each bucket this client may
 * reach. The documents bucket's policy reads the company from the second
 * folder (migration 20260726092000_documents_bucket_company_scope), which is
 * how lib/core/documents/document-service.ts builds every key.
 */
const COMPANY_FOLDERS: Readonly<Record<string, (companyId: string) => string[]>> = {
  documents: (companyId) => ['documents', companyId],
}

const READ_METHODS = new Set(['GET', 'HEAD'])
const COMPANY_ARGUMENT = /^(p_|_)?company_id$/
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AGGREGATE = /^[A-Za-z_][A-Za-z0-9_]*\.(count|sum|avg|min|max)$/
/** The API a request is for: its path, under the client's Supabase URL, starts with it. */
const API_PATH = /^\/(rest|storage)\/v1\//

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

/** A PostgREST body as PostgREST will read it: JSON, and sent as JSON, or it is not the body checked. */
function jsonBody(body: unknown, headers: Headers): unknown {
  const payload = parseJson(body)
  if (payload !== undefined && !/^application\/json\s*(;|$)/i.test(headers.get('content-type') ?? '')) {
    refuse('a request body not sent as JSON cannot be checked')
  }
  return payload
}

function rowsOf(payload: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(payload) ? payload : [payload]
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) refuse('a row is not an object')
    return row as Record<string, unknown>
  })
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    // Not dropped: a malformed path becomes the refusal, which is logged.
    return refuse('a malformed request path')
  }
}

/** What scopeSupabaseRequest lets through. */
export interface ScopedRequest {
  /** The request to send, with the company filters added. */
  url: URL
  /**
   * The parents a child-table request names. It is sent only when `read`
   * (those ids, filtered to the company) returns every one of them.
   */
  parents: { read: URL; ids: string[] } | null
}

/** Top-level items of a select list: a comma inside an embed's parentheses belongs to the embed. */
function selectItems(select: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < select.length; i++) {
    if (select[i] === '(') depth++
    else if (select[i] === ')' && --depth < 0) refuse('unbalanced select')
    else if (select[i] === ',' && depth === 0) {
      items.push(select.slice(start, i))
      start = i + 1
    }
  }
  if (depth !== 0) refuse('unbalanced select')
  items.push(select.slice(start))
  return items
}

interface Embed {
  /** The name a filter on this resource uses: its alias, or its relation, under its parent's. */
  path: string
  relation: string
  /** The relation it is embedded under; null under an RPC, whose rows have no table. */
  under: string | null
  /** Joined on a foreign key the select names (`relation!fk(...)`) rather than the one PostgREST finds itself. */
  hinted: boolean
}

function embedsOf(select: string, under: string | null, prefix: string, out: Embed[]): Embed[] {
  if (select.includes('"')) refuse('a quoted name in select cannot be checked')
  const level: { alias: string | null; relation: string; hinted: boolean; inner: string }[] = []
  for (const item of selectItems(select)) {
    const open = item.indexOf('(')
    if (open < 0) continue
    const head = item.slice(0, open)
    if (head.startsWith('...')) refuse('a spread embed cannot be scoped')
    const colon = head.indexOf(':')
    const alias = colon < 0 ? null : head.slice(0, colon)
    const name = head.slice(colon + 1)
    let depth = 0
    let close = open
    for (; close < item.length; close++) {
      if (item[close] === '(') depth++
      else if (item[close] === ')' && --depth === 0) break
    }
    const inner = item.slice(open + 1, close)
    // count() and column.sum() and the like are aggregates, not embeds: empty, at most cast.
    if (name === 'count' || AGGREGATE.test(name)) {
      if (inner !== '' || !/^(::\w+)?$/.test(item.slice(close + 1))) refuse(`unexpected select item ${item}`)
      continue
    }
    const [relation, ...modifiers] = name.split('!')
    if (close !== item.length - 1 || !IDENTIFIER.test(relation) || (alias !== null && !IDENTIFIER.test(alias))) {
      refuse(`unexpected select item ${item}`)
    }
    level.push({ alias, relation, hinted: modifiers.some((m) => m !== 'inner' && m !== 'left'), inner })
  }
  // A filter names an embed by alias or by relation, and PostgREST gives it to
  // the first one that answers: each name may answer for one embed only.
  for (const embed of level) {
    const name = embed.alias ?? embed.relation
    if (level.some((other) => other !== embed && (other.alias === name || other.relation === name))) {
      refuse(`more than one embed answers to ${name}`)
    }
  }
  for (const embed of level) {
    const path = `${prefix}${embed.alias ?? embed.relation}`
    out.push({ path, relation: embed.relation, under, hinted: embed.hinted })
    embedsOf(embed.inner, embed.relation, `${path}.`, out)
  }
  return out
}

/**
 * Give every embedded resource the filter its table gets on its own. A child
 * table without company_id has none: it is the company's only through its
 * parent, so it may be embedded under that parent alone, by the parent key.
 */
function scopeEmbeds(scope: CompanyScope, url: URL, table: string | null): void {
  const selects = url.searchParams.getAll('select')
  if (selects.length > 1) refuse('more than one select')
  if (selects.length === 0) return
  for (const embed of embedsOf(selects[0], table, '', [])) {
    const rule = ruleFor(embed.relation)
    if (rule.kind === 'reference') continue
    if (rule.kind === 'parent') {
      if (embed.under !== rule.parent || embed.hinted) refuse(`${embed.relation} may only be embedded under ${rule.parent}`)
      continue
    }
    const value = rule.kind === 'user' ? scope.userId : scope.companyId
    url.searchParams.append(`${embed.path}.${rule.column}`, `eq.${value}`)
  }
}

function columnList(value: string): string[] {
  return value.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
}

/**
 * The column a write is scoped on must be the one PostgREST writes by. With
 * `columns`, PostgREST writes only the columns named there. An upsert merges
 * into whichever row already holds its conflict key, so that key must include
 * the column too: then the row it could merge into is this company's (or its
 * parent's).
 */
function refuseUnscopedWrite(table: string, column: string, url: URL, headers: Headers): void {
  const columns = url.searchParams.getAll('columns')
  if (columns.length > 0 && (columns.length > 1 || !columnList(columns[0]).includes(column))) {
    refuse(`${table} writes must name ${column} in columns`)
  }
  const targets = url.searchParams.getAll('on_conflict')
  if (targets.length === 0 && !/\bresolution=/.test(headers.get('prefer') ?? '')) return
  if (targets.length !== 1 || !columnList(targets[0]).includes(column)) {
    refuse(`${table} may only be upserted on a conflict target that includes ${column}`)
  }
}

/** The parent ids a child-table request filters on (eq or in), or null when it filters on none. */
function filteredParentIds(url: URL, column: string): string[] | null {
  const filters = url.searchParams.getAll(column).filter((value) => /^(eq|in)\./.test(value))
  if (filters.length === 0) return null
  return filters.flatMap((filter) => {
    if (filter.startsWith('eq.')) return [filter.slice('eq.'.length)]
    const list = /^in\.\((.*)\)$/.exec(filter)
    if (!list) refuse(`unexpected filter ${column}=${filter}`)
    return list[1] === '' ? [] : list[1].split(',').map((id) => id.replace(/^"(.*)"$/, '$1'))
  })
}

function parentKey(table: string, column: string, value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) refuse(`${table} must name its ${column} by id`)
  return value.toLowerCase()
}

/** The child-table request, and the read that must find each of its parents in the company first. */
function withParents(scope: CompanyScope, url: URL, restBase: string, parent: string, ids: string[]): ScopedRequest {
  const unique = [...new Set(ids)]
  // Naming no parent at all (an empty in-list, an empty insert) matches and writes nothing.
  if (unique.length === 0) return { url, parents: null }
  const rule = ruleFor(parent)
  if (rule.kind !== 'column') return refuse(`${parent} is not filtered on a company column`)
  const read = new URL(url.origin)
  read.pathname = `${restBase}${parent}`
  read.searchParams.set('select', 'id')
  read.searchParams.set('id', `in.(${unique.join(',')})`)
  read.searchParams.set(rule.column, `eq.${scope.companyId}`)
  return { url, parents: { read, ids: unique } }
}

function scopeTableRequest(
  scope: CompanyScope,
  table: string,
  method: string,
  url: URL,
  body: unknown,
  headers: Headers,
  restBase: string,
): ScopedRequest {
  const rule = ruleFor(table)
  const scoped = new URL(url)
  scopeEmbeds(scope, scoped, table)

  if (rule.kind === 'reference' || rule.kind === 'user') {
    if (!READ_METHODS.has(method)) refuse(`${table} may only be read`)
    if (rule.kind === 'user') scoped.searchParams.append(rule.column, `eq.${scope.userId}`)
    return { url: scoped, parents: null }
  }

  const value = scope.companyId
  if (method === 'POST') {
    refuseUnscopedWrite(table, rule.column, url, headers)
    const rows = rowsOf(jsonBody(body, headers))
    if (rule.kind === 'parent') {
      return withParents(scope, scoped, restBase, rule.parent, rows.map((row) => parentKey(table, rule.column, row[rule.column])))
    }
    for (const row of rows) {
      if (row[rule.column] !== value) refuse(`${table} rows must carry ${rule.column} ${value}`)
    }
    return { url: scoped, parents: null }
  }

  if (!READ_METHODS.has(method) && method !== 'PATCH' && method !== 'DELETE') {
    refuse(`${method} is not a PostgREST table method`)
  }
  const patch = method === 'PATCH' ? jsonBody(body, headers) : undefined
  const changed = patch === undefined ? [] : rowsOf(patch).filter((row) => Object.hasOwn(row, rule.column))

  if (rule.kind === 'parent') {
    const filtered = filteredParentIds(url, rule.column)
    if (filtered === null) refuse(`${table} must be filtered by ${rule.column}`)
    // An update that sets the parent key names a parent too: the one the rows move to.
    const named = [...filtered, ...changed.map((row) => row[rule.column])]
    return withParents(scope, scoped, restBase, rule.parent, named.map((id) => parentKey(table, rule.column, id)))
  }

  for (const row of changed) {
    if (row[rule.column] !== value) refuse(`${table} rows may not move to another company`)
  }
  scoped.searchParams.append(rule.column, `eq.${value}`)
  return { url: scoped, parents: null }
}

function scopeRpcRequest(scope: CompanyScope, fn: string, method: string, url: URL, body: unknown, headers: Headers): ScopedRequest {
  const args: [string, unknown][] = []
  if (method === 'POST') {
    const payload = jsonBody(body, headers)
    if (payload !== undefined) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) refuse(`rpc ${fn} arguments must be one object`)
      args.push(...Object.entries(payload))
    }
  } else if (READ_METHODS.has(method)) {
    url.searchParams.forEach((value, key) => {
      args.push([key, value])
    })
  } else {
    refuse(`${method} is not an RPC method`)
  }
  if (!args.some(([key]) => COMPANY_ARGUMENT.test(key))) refuse(`rpc ${fn} names no company`)
  for (const [key, value] of args) {
    if (/company/i.test(key) && value !== scope.companyId) refuse(`rpc ${fn} names another company`)
  }
  const scoped = new URL(url)
  scopeEmbeds(scope, scoped, null)
  return { url: scoped, parents: null }
}

/**
 * Is this key inside the company's folder of the bucket? An object key names
 * something beneath the folder. A list prefix (`folder`) may be the folder
 * itself, with or without a closing slash. `encoded`: it came from the URL path.
 */
function inCompanyFolder(
  scope: CompanyScope,
  bucket: unknown,
  key: unknown,
  { encoded, folder: listing }: { encoded: boolean; folder: boolean },
): boolean {
  if (typeof bucket !== 'string' || typeof key !== 'string' || !Object.hasOwn(COMPANY_FOLDERS, bucket)) return false
  const folder = COMPANY_FOLDERS[bucket](scope.companyId)
  const segments = key.split('/')
  if (listing && segments.length > folder.length && segments.at(-1) === '') segments.pop()
  if (listing ? segments.length < folder.length : segments.length <= folder.length) return false
  return segments.every((raw, i) => {
    const segment = encoded ? decodeSegment(raw) : raw
    if (segment === '' || segment === '.' || segment === '..' || /[/\\]/.test(segment)) return false
    return i >= folder.length || segment === folder[i]
  })
}

const STORAGE_ACTIONS = ['upload/sign', 'list', 'move', 'copy', 'sign', 'public', 'authenticated', 'info']

function scopeStorageRequest(scope: CompanyScope, rest: string, body: unknown, url: URL): ScopedRequest {
  let path = rest
  const action = STORAGE_ACTIONS.find((a) => path === a || path.startsWith(`${a}/`))
  if (action) path = path.slice(action.length).replace(/^\//, '')

  // Uploads carry the file itself; only the JSON bodies of list, move, copy,
  // remove and batch-sign name objects.
  let record: Record<string, unknown> = {}
  if (typeof body === 'string') {
    try {
      const payload: unknown = JSON.parse(body)
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) record = payload as Record<string, unknown>
    } catch {
      // A text upload: its object key is in the path, checked below.
    }
  }

  // move and copy name their bucket in the body, and may name a second one.
  const moving = action === 'move' || action === 'copy'
  const [pathBucket, ...keyParts] = path.split('/')
  const bucket = moving ? record.bucketId : decodeSegment(pathBucket)
  if (moving && Object.hasOwn(record, 'destinationBucket') && record.destinationBucket !== bucket) {
    refuse('storage objects may not move to another bucket')
  }

  // Every key names an object, except the folder a list reads (`prefix`).
  const objects: { key: unknown; encoded: boolean; folder: boolean }[] = []
  if (!moving && keyParts.join('/') !== '') objects.push({ key: keyParts.join('/'), encoded: true, folder: false })
  for (const field of ['prefix', 'sourceKey', 'destinationKey']) {
    if (Object.hasOwn(record, field)) objects.push({ key: record[field], encoded: false, folder: field === 'prefix' })
  }
  for (const field of ['prefixes', 'paths']) {
    if (!Object.hasOwn(record, field)) continue
    const keys = record[field]
    if (!Array.isArray(keys)) refuse(`storage ${field} is not a list`)
    for (const key of keys) objects.push({ key, encoded: false, folder: false })
  }

  if (objects.length === 0) refuse('a storage request must name its objects')
  for (const { key, ...how } of objects) {
    if (!inCompanyFolder(scope, bucket, key, how)) refuse(`storage object ${String(bucket)}/${String(key)} is outside the company`)
  }
  return { url: new URL(url), parents: null }
}

/**
 * Check one outgoing Supabase request against the company scope. Returns the
 * request to send (with the company filters added) and, for a child table,
 * the parents to confirm first; or throws CompanyScopeViolation. `basePath`
 * is the path of the client's Supabase URL, when it has one.
 */
export function scopeSupabaseRequest(
  scope: CompanyScope,
  method: string,
  url: URL,
  body?: unknown,
  headers?: HeadersInit,
  basePath = '',
): ScopedRequest {
  const upper = method.toUpperCase()
  const head = new Headers(headers)
  const relative = url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : ''
  const api = API_PATH.exec(relative)
  const after = api ? relative.slice(api[0].length) : ''
  if (api?.[1] === 'rest') {
    const [first, second, ...more] = after.split('/')
    if (first === 'rpc') {
      if (!second || more.length > 0) refuse(`unexpected PostgREST path ${url.pathname}`)
      return scopeRpcRequest(scope, decodeSegment(second), upper, url, body, head)
    }
    if (!first || second !== undefined) refuse(`unexpected PostgREST path ${url.pathname}`)
    return scopeTableRequest(scope, decodeSegment(first), upper, url, body, head, `${basePath}/rest/v1/`)
  }
  if (api?.[1] === 'storage' && after.startsWith('object/')) {
    return scopeStorageRequest(scope, after.slice('object/'.length), body, url)
  }
  return refuse(`${url.pathname} is outside the company scope`)
}

/**
 * Read a child-table request's parents back through the company filter: the
 * request goes out only when every parent it names came back.
 */
async function confirmParents(
  parents: { read: URL; ids: string[] },
  headers: Headers,
  baseFetch: typeof fetch,
): Promise<void> {
  const readHeaders = new Headers({ accept: 'application/json' })
  for (const name of ['apikey', 'authorization']) {
    const value = headers.get(name)
    if (value) readHeaders.set(name, value)
  }
  const profile = headers.get('accept-profile') ?? headers.get('content-profile')
  if (profile) readHeaders.set('accept-profile', profile)
  let rows: unknown = null
  try {
    const response = await baseFetch(parents.read.toString(), { method: 'GET', headers: readHeaders, redirect: 'manual' })
    if (response.ok) rows = await response.json()
  } catch {
    // Not dropped: an unanswered read becomes the refusal below, which is logged.
  }
  if (!Array.isArray(rows)) refuse('the parent rows could not be read')
  const found = new Set(rows.map((row) => String((row as { id?: unknown } | null)?.id ?? '').toLowerCase()))
  if (parents.ids.some((id) => !found.has(id))) refuse('a parent row is outside the company')
}

function refusalResponse(message: string): Response {
  return new Response(
    JSON.stringify({ code: '42501', message: `company scope: ${message}`, details: null, hint: null, statusCode: '403', error: 'Forbidden' }),
    { status: 403, headers: { 'content-type': 'application/json' } },
  )
}

/**
 * A fetch that sends only what scopeSupabaseRequest lets through, and follows
 * no redirect. Given the client's Supabase URL, it also refuses any other
 * origin and reads each path under that URL's own path.
 */
export function companyScopedFetch(
  scope: CompanyScope,
  baseFetch: typeof fetch = fetch,
  log?: Logger,
  supabaseUrl?: string,
): typeof fetch {
  const home = supabaseUrl ? new URL(supabaseUrl) : null
  const basePath = home ? home.pathname.replace(/\/+$/, '') : ''
  return async (input, init) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request ? request.url : String(input))
    const method = init?.method ?? request?.method ?? 'GET'
    const headers = new Headers(init?.headers ?? request?.headers)
    let scoped: ScopedRequest
    try {
      if (home && url.origin !== home.origin) refuse(`${url.origin} is not the client's Supabase`)
      // The body checked must be the body sent; one only a Request carries is not read here.
      if (request?.body && init?.body === undefined) refuse('a request body that cannot be checked')
      scoped = scopeSupabaseRequest(scope, method, url, init?.body, headers, basePath)
      if (scoped.parents) await confirmParents(scoped.parents, headers, baseFetch)
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
    // A redirect is answered, never followed: where it points was not checked.
    return baseFetch(request ? new Request(scoped.url, request) : scoped.url.toString(), { ...init, redirect: 'manual' })
  }
}

/** Realtime does not go through fetch, so nothing it would send could be checked: a subscription is refused. */
class RefusedRealtimeTransport {
  constructor() {
    throw new CompanyScopeViolation('realtime is outside the company scope')
  }
}

/** The service-role client for one company and one signed-in user. See the file header. */
export function createCompanyScopedClient(scope: CompanyScope, log?: Logger): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  return createServiceRoleClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    global: { fetch: companyScopedFetch(scope, fetch, log ?? createLogger('company-scoped-client'), supabaseUrl) },
    realtime: { transport: RefusedRealtimeTransport as never },
  })
}
