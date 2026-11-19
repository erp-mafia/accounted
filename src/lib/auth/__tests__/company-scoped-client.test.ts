/**
 * The company-scoped client runs the real supabase-js builders over a fake
 * fetch, so these tests see the requests exactly as they would leave the
 * process: the company filter on the wire, and the refusals that never do.
 */
import { describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { CompanyScopeViolation, companyScopedFetch, scopeSupabaseRequest, type CompanyScope } from '../company-scoped-client'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const SCOPE: CompanyScope = { companyId: COMPANY, userId: USER }
const BASE = 'http://supabase.invalid'

/** createClient resolves a WebSocket for realtime eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('realtime is not used by this test')
  }
}

function scopedClient() {
  const sent: { method: string; url: URL; body: unknown }[] = []
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    sent.push({ method: init?.method ?? 'GET', url, body: init?.body })
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

  it('scopes the companies table by its id', async () => {
    const { client, sent } = scopedClient()
    await client.from('companies').select('team_id').eq('id', COMPANY)
    expect(sent[0].url.searchParams.getAll('id')).toEqual([`eq.${COMPANY}`, `eq.${COMPANY}`])
    expect(sent[0].url.searchParams.has('company_id')).toBe(false)
  })

  it('requires a parent key on child tables without company_id', async () => {
    const { client, sent } = scopedClient()
    await client.from('journal_entry_lines').select('*').eq('journal_entry_id', 'je-1')
    await client.from('invoice_items').insert([{ invoice_id: 'inv-1', description: 'x' }])
    const unfiltered = await client.from('journal_entry_lines').select('*')
    const orphan = await client.from('invoice_items').insert({ description: 'x' })
    expect(sent).toHaveLength(2)
    expect(unfiltered.error?.code).toBe('42501')
    expect(orphan.error?.code).toBe('42501')
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

  it('lets storage reach only object keys under the company', async () => {
    const { client, sent } = scopedClient()
    await client.storage.from('documents').download(`documents/${COMPANY}/faktura.pdf`)
    await client.storage.from('documents').list(`documents/${COMPANY}`)
    const foreign = await client.storage.from('documents').download(`documents/${OTHER}/lonespec.pdf`)
    const removeForeign = await client.storage.from('documents').remove([`documents/${COMPANY}/a.pdf`, `documents/${OTHER}/b.pdf`])
    expect(sent).toHaveLength(2)
    expect(foreign.error).not.toBeNull()
    expect(removeForeign.error).not.toBeNull()
  })

  it('refuses auth, edge functions and anything else', () => {
    for (const path of ['/auth/v1/admin/users', '/functions/v1/ocr', '/storage/v1/bucket', '/rest/v1/']) {
      expect(() => scopeSupabaseRequest(SCOPE, 'GET', url(path)), path).toThrow(CompanyScopeViolation)
    }
  })
})
