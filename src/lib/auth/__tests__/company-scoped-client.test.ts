/**
 * The company-scoped client runs the real supabase-js builders over a fake
 * fetch, so these tests see the requests exactly as they would leave the
 * process: the company filter on the wire, and the refusals that never do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import {
  CompanyScopeViolation,
  companyScopedFetch,
  createCompanyScopedClient,
  scopeSupabaseRequest,
  type CompanyScope,
} from '../company-scoped-client'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const OWN_INVOICE = '44444444-4444-4444-8444-444444444444'
const OTHER_INVOICE = '55555555-5555-4555-8555-555555555555'
const OWN_ENTRY = '66666666-6666-4666-8666-666666666666'
const OTHER_ENTRY = '77777777-7777-4777-8777-777777777777'
const OTHER_CUSTOMER = '88888888-8888-4888-8888-888888888888'
const SCOPE: CompanyScope = { companyId: COMPANY, userId: USER }
const BASE = 'http://supabase.invalid'

/** createClient resolves a WebSocket for realtime eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('realtime is not used by this test')
  }
}

/** The parent rows that are this company's, as the guard's read-back finds them. */
const OWN_PARENTS: Record<string, string[]> = { invoices: [OWN_INVOICE], journal_entries: [OWN_ENTRY] }

function scopedClient() {
  const sent: { method: string; url: URL; body: unknown }[] = []
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    sent.push({ method: init?.method ?? 'GET', url, body: init?.body })
    const table = url.pathname.replace('/rest/v1/', '')
    const ids = /^in\.\((.*)\)$/.exec(url.searchParams.get('id') ?? '')?.[1].split(',') ?? []
    if (table in OWN_PARENTS && url.searchParams.get('select') === 'id' && url.searchParams.get('company_id') === `eq.${COMPANY}`) {
      const rows = ids.filter((id) => OWN_PARENTS[table].includes(id)).map((id) => ({ id }))
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const client = createClient(BASE, 'service-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: UnusedRealtimeTransport as never },
    global: { fetch: companyScopedFetch(SCOPE, fakeFetch) },
  })
  return { client, sent }
}

const url = (path: string) => new URL(`${BASE}${path}`)
const paths = (sent: { method: string; url: URL }[]) => sent.map((r) => `${r.method} ${r.url.pathname}`)

describe('company-scoped client: tables', () => {
  it('adds the company filter to every read, whatever the caller filtered', async () => {
    const { client, sent } = scopedClient()
    await client.from('invoices').select('*, customer:customers(name)').eq('id', 'inv-1')
    await client.from('journal_entries').select('id', { count: 'exact', head: true })
    expect(sent).toHaveLength(2)
    expect(sent[0].url.searchParams.getAll('company_id')).toEqual([`eq.${COMPANY}`])
    expect(sent[0].url.searchParams.get('id')).toBe('eq.inv-1')
    expect(sent[1].method).toBe('HEAD')
    expect(sent[1].url.searchParams.getAll('company_id')).toEqual([`eq.${COMPANY}`])
  })

  it('keeps a filter on another company: the two filters together match nothing', async () => {
    const { client, sent } = scopedClient()
    await client.from('employees').select('*').eq('company_id', OTHER)
    expect(sent[0].url.searchParams.getAll('company_id')).toEqual([`eq.${OTHER}`, `eq.${COMPANY}`])
  })

  it('filters updates and deletes, and refuses moving a row to another company', async () => {
    const { client, sent } = scopedClient()
    await client.from('customers').update({ name: 'Ny' }).eq('id', 'c-1')
    await client.from('customers').delete().eq('id', 'c-1')
    const moved = await client.from('customers').update({ company_id: OTHER }).eq('id', 'c-1')
    expect(sent).toHaveLength(2)
    for (const request of sent) expect(request.url.searchParams.getAll('company_id')).toEqual([`eq.${COMPANY}`])
    expect(moved.error?.code).toBe('42501')
  })

  it('lets an insert through only when every row carries the company', async () => {
    const { client, sent } = scopedClient()
    await client.from('invoices').insert({ company_id: COMPANY, user_id: USER })
    const missing = await client.from('invoices').insert({ user_id: USER })
    const foreign = await client.from('invoices').insert([{ company_id: COMPANY }, { company_id: OTHER }])
    const upsert = await client.from('customers').upsert({ company_id: OTHER, name: 'X' })
    expect(sent).toHaveLength(1)
    for (const result of [missing, foreign, upsert]) {
      expect(result.error?.code).toBe('42501')
      expect(result.error?.message).toMatch(/company scope/)
    }
  })

  it('lets an upsert through only when its conflict target holds the company, so it can merge into no other row', async () => {
    const { client, sent } = scopedClient()
    const byPrimaryKey = await client.from('customers').upsert({ id: OTHER_CUSTOMER, company_id: COMPANY, name: 'X' })
    const byId = await client.from('customers').upsert({ id: OTHER_CUSTOMER, company_id: COMPANY, name: 'X' }, { onConflict: 'id' })
    const ignoring = await client
      .from('customers')
      .upsert({ id: OTHER_CUSTOMER, company_id: COMPANY, name: 'X' }, { onConflict: 'id', ignoreDuplicates: true })
    const child = await client.from('invoice_items').upsert({ id: OTHER_CUSTOMER, invoice_id: OWN_INVOICE, description: 'x' })
    await client.from('autogiro_settings').upsert({ company_id: COMPANY, bankgiro: '5050-1055' }, { onConflict: 'company_id' })
    for (const result of [byPrimaryKey, byId, ignoring, child]) expect(result.error?.code).toBe('42501')
    expect(paths(sent)).toEqual(['POST /rest/v1/autogiro_settings'])
    expect(sent[0].url.searchParams.get('on_conflict')).toBe('company_id')
  })

  it('writes only what it checked: columns must name the scoped column, and the body must be sent as JSON', async () => {
    const { client, sent } = scopedClient()
    await client.from('invoices').insert([{ company_id: COMPANY, user_id: USER }])
    expect(sent[0].url.searchParams.get('columns')).toBe('"company_id","user_id"')
    const insert = url('/rest/v1/invoices?columns=user_id')
    const json = { 'content-type': 'application/json' }
    expect(() => scopeSupabaseRequest(SCOPE, 'POST', insert, JSON.stringify({ company_id: COMPANY, user_id: USER }), json)).toThrow(
      CompanyScopeViolation,
    )
    const child = url(`/rest/v1/invoice_items?columns=description`)
    expect(() => scopeSupabaseRequest(SCOPE, 'POST', child, JSON.stringify({ invoice_id: OWN_INVOICE, description: 'x' }), json)).toThrow(
      CompanyScopeViolation,
    )
    for (const type of ['text/csv', 'application/x-www-form-urlencoded', '']) {
      const body = JSON.stringify({ company_id: COMPANY })
      expect(() => scopeSupabaseRequest(SCOPE, 'POST', url('/rest/v1/invoices'), body, { 'content-type': type }), type).toThrow(
        CompanyScopeViolation,
      )
      expect(() => scopeSupabaseRequest(SCOPE, 'POST', url('/rest/v1/rpc/f'), JSON.stringify({ p_company_id: COMPANY }), { 'content-type': type })).toThrow(
        CompanyScopeViolation,
      )
    }
    expect(sent).toHaveLength(1)
  })

  it('scopes the companies table by its id', async () => {
    const { client, sent } = scopedClient()
    await client.from('companies').select('team_id').eq('id', COMPANY)
    expect(sent[0].url.searchParams.getAll('id')).toEqual([`eq.${COMPANY}`, `eq.${COMPANY}`])
    expect(sent[0].url.searchParams.has('company_id')).toBe(false)
  })

  it('reads user tables as the signed-in user and reference data as is, and writes neither', async () => {
    const { client, sent } = scopedClient()
    await client.from('user_preferences').select('active_company_id')
    await client.from('currencies').select('*')
    const write = await client.from('user_preferences').update({ locale: 'en' }).eq('user_id', USER)
    const reference = await client.from('exchange_rates').insert({ currency: 'EUR' })
    expect(sent).toHaveLength(2)
    expect(sent[0].url.searchParams.get('user_id')).toBe(`eq.${USER}`)
    expect(write.error?.code).toBe('42501')
    expect(reference.error?.code).toBe('42501')
  })
})

describe('company-scoped client: child tables without company_id', () => {
  it('reads a child table after its parents are read back as this company\'s', async () => {
    const { client, sent } = scopedClient()
    const own = await client.from('invoice_items').select('*').eq('invoice_id', OWN_INVOICE)
    expect(own.error).toBeNull()
    expect(paths(sent)).toEqual(['GET /rest/v1/invoices', 'GET /rest/v1/invoice_items'])
    expect(sent[0].url.searchParams.get('id')).toBe(`in.(${OWN_INVOICE})`)
    expect(sent[0].url.searchParams.get('company_id')).toBe(`eq.${COMPANY}`)
  })

  it('refuses a child-table read that names another company\'s parent', async () => {
    const { client, sent } = scopedClient()
    const other = await client.from('invoice_items').select('*').eq('invoice_id', OTHER_INVOICE)
    const mixed = await client.from('journal_entry_lines').select('*').in('journal_entry_id', [OWN_ENTRY, OTHER_ENTRY])
    for (const result of [other, mixed]) expect(result.error?.code).toBe('42501')
    expect(paths(sent)).toEqual(['GET /rest/v1/invoices', 'GET /rest/v1/journal_entries'])
  })

  it('writes child rows only into this company\'s parents', async () => {
    const { client, sent } = scopedClient()
    await client.from('journal_entry_lines').insert([{ journal_entry_id: OWN_ENTRY, account_number: '1930', debit_amount: 1, credit_amount: 0 }])
    const intoOther = await client
      .from('journal_entry_lines')
      .insert({ journal_entry_id: OTHER_ENTRY, account_number: '1930', debit_amount: 1, credit_amount: 0 })
    const moved = await client.from('invoice_items').update({ invoice_id: OTHER_INVOICE }).eq('invoice_id', OWN_INVOICE)
    const deleted = await client.from('invoice_items').delete().in('invoice_id', [OWN_INVOICE, OTHER_INVOICE])
    for (const result of [intoOther, moved, deleted]) expect(result.error?.code).toBe('42501')
    expect(paths(sent).filter((p) => !p.endsWith('/journal_entries') && !p.endsWith('/invoices'))).toEqual([
      'POST /rest/v1/journal_entry_lines',
    ])
  })

  it('requires the parent key, by id, before reading anything back', async () => {
    const { client, sent } = scopedClient()
    const unfiltered = await client.from('journal_entry_lines').select('*')
    const byOtherColumn = await client.from('invoice_items').select('id', { count: 'exact', head: true }).eq('article_id', OWN_INVOICE)
    const orphan = await client.from('invoice_items').insert({ description: 'x' })
    const notAnId = await client.from('invoice_items').select('*').eq('invoice_id', 'inv-1')
    for (const result of [unfiltered, byOtherColumn, orphan, notAnId]) expect(result.error?.code).toBe('42501')
    expect(sent).toHaveLength(0)
  })

  it('embeds a child table only under its own parent', async () => {
    const { client, sent } = scopedClient()
    await client.from('invoices').select('*, items:invoice_items(*)').eq('id', OWN_INVOICE)
    await client.from('journal_entries').update({ status: 'cancelled' }).eq('id', OWN_ENTRY).select('*, lines:journal_entry_lines(*)')
    const elsewhere = await client.from('articles').select('*, invoice_items(*)')
    const hinted = await client.from('invoices').select('*, items:invoice_items!invoice_items_invoice_id_fkey(*)')
    for (const result of [elsewhere, hinted]) expect(result.error?.code).toBe('42501')
    expect(paths(sent)).toEqual(['GET /rest/v1/invoices', 'PATCH /rest/v1/journal_entries'])
  })
})

describe('company-scoped client: embedded resources', () => {
  it('filters every embedded resource to the company, nested ones too', async () => {
    const { client, sent } = scopedClient()
    await client
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*, article:articles(name)), spawned_by:recurring_invoice_schedules!last_invoice_id(id)')
      .eq('id', OWN_INVOICE)
    await client.from('sales_orders').select('*, items:sales_order_items!sales_order_items_sales_order_id_fkey(*)')
    const [invoice, order] = sent.map((r) => r.url.searchParams)
    expect(invoice.get('customer.company_id')).toBe(`eq.${COMPANY}`)
    expect(invoice.get('items.article.company_id')).toBe(`eq.${COMPANY}`)
    expect(invoice.get('spawned_by.company_id')).toBe(`eq.${COMPANY}`)
    expect(invoice.has('items.company_id')).toBe(false)
    expect(order.get('items.company_id')).toBe(`eq.${COMPANY}`)
  })

  it('filters embeds in what a write returns, under user and reference tables as well', async () => {
    const { client, sent } = scopedClient()
    await client.from('invoices').insert({ company_id: COMPANY, customer_id: OTHER_CUSTOMER }).select('*, customer:customers(*)')
    await client.from('user_preferences').select('*, active_company:companies(name)')
    await client.from('currencies').select('*, invoices(id)')
    const [inserted, preferences, currencies] = sent.map((r) => r.url.searchParams)
    expect(inserted.get('customer.company_id')).toBe(`eq.${COMPANY}`)
    expect(preferences.get('active_company.id')).toBe(`eq.${COMPANY}`)
    expect(currencies.get('invoices.company_id')).toBe(`eq.${COMPANY}`)
  })

  it('reads aggregates as columns and refuses what it cannot scope', async () => {
    const { client, sent } = scopedClient()
    await client.from('invoices').select('count(), total.sum(), net:subtotal.sum()::int')
    const spread = await client.from('invoices').select('id, ...customers(name)')
    const quoted = await client.from('invoices').select('id, "odd(name)":customers(name)')
    const trailing = await client.from('invoices').select('id, count()customers(name)')
    for (const result of [spread, quoted, trailing]) expect(result.error?.code).toBe('42501')
    expect(sent).toHaveLength(1)
    expect([...sent[0].url.searchParams.keys()].filter((k) => k.includes('.'))).toEqual([])
  })

  it('lets each name in a select answer for one embed only, so every filter lands on its own', async () => {
    const { client, sent } = scopedClient()
    await client.from('invoices').select('id, buyer:customers(name), payer:customers(name)')
    const aliasAndBare = await client.from('invoices').select('id, x:customers(name), customers(name)')
    const bareFirst = await client.from('invoices').select('id, customers(name), x:customers(name)')
    const aliasOfOther = await client.from('invoices').select('id, customers:articles(name), x:customers(name)')
    const sameAlias = await client.from('invoices').select('id, x:customers(name), x:articles(name)')
    for (const result of [aliasAndBare, bareFirst, aliasOfOther, sameAlias]) expect(result.error?.code).toBe('42501')
    expect(sent).toHaveLength(1)
    expect(sent[0].url.searchParams.get('buyer.company_id')).toBe(`eq.${COMPANY}`)
    expect(sent[0].url.searchParams.get('payer.company_id')).toBe(`eq.${COMPANY}`)
  })
})

describe('company-scoped client: RPC, storage and the rest', () => {
  it('lets an RPC through only when it names this company', async () => {
    const { client, sent } = scopedClient()
    await client.rpc('generate_invoice_number', { p_company_id: COMPANY, p_invoice_id: 'inv-1' })
    const none = await client.rpc('resolve_active_company')
    const other = await client.rpc('commit_journal_entry', { p_company_id: OTHER, p_entry_id: 'je-1' })
    expect(sent).toHaveLength(1)
    expect(none.error?.code).toBe('42501')
    expect(other.error?.code).toBe('42501')
  })

  it('refuses an RPC whose other company argument names another company', async () => {
    const { client, sent } = scopedClient()
    const second = await client.rpc('copy_settings', { p_company_id: COMPANY, p_target_company_id: OTHER })
    const list = await client.rpc('copy_settings', { p_company_id: COMPANY, p_company_ids: [COMPANY, OTHER] })
    const read = await client.rpc('read_settings', { p_company_id: COMPANY }, { get: true })
    expect(read.error).toBeNull()
    for (const result of [second, list]) expect(result.error?.code).toBe('42501')
    const repeated = url(`/rest/v1/rpc/read_settings?p_company_id=${OTHER}&p_company_id=${COMPANY}`)
    expect(() => scopeSupabaseRequest(SCOPE, 'GET', repeated)).toThrow(CompanyScopeViolation)
    const batch = JSON.stringify([{ p_company_id: COMPANY }, { p_company_id: OTHER }])
    expect(() => scopeSupabaseRequest(SCOPE, 'POST', url('/rest/v1/rpc/f'), batch)).toThrow(CompanyScopeViolation)
    expect(paths(sent)).toEqual(['GET /rest/v1/rpc/read_settings'])
  })

  it('lets storage reach only objects in the company\'s folder of the documents bucket', async () => {
    const { client, sent } = scopedClient()
    await client.storage.from('documents').download(`documents/${COMPANY}/faktura.pdf`)
    await client.storage.from('documents').list(`documents/${COMPANY}`)
    const foreign = await client.storage.from('documents').download(`documents/${OTHER}/lonespec.pdf`)
    const removeForeign = await client.storage.from('documents').remove([`documents/${COMPANY}/a.pdf`, `documents/${OTHER}/b.pdf`])
    expect(sent).toHaveLength(2)
    expect(foreign.error).not.toBeNull()
    expect(removeForeign.error).not.toBeNull()
  })

  it('takes the company only from the documents/<company>/ folder, and refuses other buckets and odd keys', async () => {
    const { client, sent } = scopedClient()
    const later = await client.storage.from('documents').download(`documents/${OTHER}/${COMPANY}/lonespec.pdf`)
    const restInKey = await client.storage.from('documents').download(`documents/${OTHER}/rest/v1/invoices`)
    const bareCompany = await client.storage.from('documents').download(`${COMPANY}/faktura.pdf`)
    const otherBucket = await client.storage.from('logos').download(`${COMPANY}/logo.png`)
    const climbs = await client.storage.from('documents').remove([`documents/${COMPANY}/../${OTHER}/b.pdf`])
    const encoded = await client.storage.from('documents').download(`documents/${COMPANY}/..%2F..%2F${OTHER}%2Fb.pdf`)
    const moved = await client.storage
      .from('documents')
      .move(`documents/${COMPANY}/a.pdf`, `documents/${COMPANY}/b.pdf`, { destinationBucket: 'logos' })
    const folderAsObject = await client.storage.from('documents').download(`documents/${COMPANY}`)
    const closingSlash = await client.storage.from('documents').download(`documents/${COMPANY}/a/`)
    const results = [later, restInKey, bareCompany, otherBucket, climbs, encoded, moved, folderAsObject, closingSlash]
    for (const result of results) expect(result.error).not.toBeNull()
    await client.storage.from('documents').move(`documents/${COMPANY}/a.pdf`, `documents/${COMPANY}/b.pdf`)
    await client.storage.from('documents').list(`documents/${COMPANY}/`)
    expect(paths(sent)).toEqual(['POST /storage/v1/object/move', 'POST /storage/v1/object/list/documents'])
  })

  it('refuses auth, edge functions and anything else', () => {
    const paths = [
      '/auth/v1/admin/users',
      '/functions/v1/ocr',
      '/functions/v1/ocr/rest/v1/invoices',
      '/graphql/v1/rest/v1/invoices',
      '/storage/v1/bucket',
      '/rest/v1/',
      '/rest/v1/invoices/extra',
      '/rest/v1/rpc/generate_invoice_number/extra',
    ]
    for (const path of paths) {
      expect(() => scopeSupabaseRequest(SCOPE, 'GET', url(path)), path).toThrow(CompanyScopeViolation)
    }
  })

  it('reads a path under the client\'s own Supabase URL and refuses any other origin', async () => {
    const sent: string[] = []
    const scopedFetch = companyScopedFetch(
      SCOPE,
      (async (input: RequestInfo | URL) => {
        sent.push(String(input))
        return new Response('[]')
      }) as typeof fetch,
      undefined,
      `${BASE}/supabase/`,
    )
    await scopedFetch(`${BASE}/supabase/rest/v1/invoices?select=id`)
    const outsideBase = await scopedFetch(`${BASE}/rest/v1/invoices?select=id`)
    const otherOrigin = await scopedFetch('http://elsewhere.invalid/supabase/rest/v1/invoices?select=id')
    expect(outsideBase.status).toBe(403)
    expect(otherOrigin.status).toBe(403)
    expect(sent).toEqual([`${BASE}/supabase/rest/v1/invoices?select=id&company_id=eq.${COMPANY}`])
  })

  it('follows no redirect, for the request or for the parent read', async () => {
    const redirects: (RequestRedirect | undefined)[] = []
    const scopedFetch = companyScopedFetch(SCOPE, (async (input: RequestInfo | URL, init?: RequestInit) => {
      redirects.push(init?.redirect)
      const parentRead = String(input).includes('/rest/v1/invoices?')
      return new Response(parentRead ? JSON.stringify([{ id: OWN_INVOICE }]) : '[]', { status: 200 })
    }) as typeof fetch)
    await scopedFetch(`${BASE}/rest/v1/customers?select=id`)
    await scopedFetch(`${BASE}/rest/v1/invoice_items?select=id&invoice_id=eq.${OWN_INVOICE}`)
    expect(redirects).toEqual(['manual', 'manual', 'manual'])
  })

  it('refuses a request whose body it cannot read', async () => {
    const sent: string[] = []
    const scopedFetch = companyScopedFetch(SCOPE, (async (input: RequestInfo | URL) => {
      sent.push(String(input))
      return new Response('[]')
    }) as typeof fetch)
    const request = new Request(`${BASE}/rest/v1/customers?id=eq.c-1`, { method: 'PATCH', body: JSON.stringify({ company_id: OTHER }) })
    const response = await scopedFetch(request)
    expect(response.status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('refuses a realtime subscription, which does not go through fetch', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', BASE)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
    const client = createCompanyScopedClient(SCOPE)
    expect(() => client.channel('invoices').subscribe()).toThrow(/outside the company scope/)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})
