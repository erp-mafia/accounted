import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const supabaseState = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
  calls: [] as Array<{ method: string; args: unknown[] }>,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const chain: Record<string, unknown> = {}
    const proxy: unknown = new Proxy(chain, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(supabaseState.result)
        }
        return (...args: unknown[]) => {
          supabaseState.calls.push({ method: String(prop), args })
          return proxy
        }
      },
    })
    return { from: (table: string) => (supabaseState.calls.push({ method: 'from', args: [table] }), proxy) }
  },
}))

import {
  ReferenceFetchError,
  fetchAccounts,
  fetchArticles,
  fetchBookingTemplates,
  fetchCashAccounts,
  fetchCustomers,
  fetchDimensions,
  fetchFiscalPeriods,
  fetchSuppliers,
} from '../fetchers'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('browser Supabase fetchers', () => {
  beforeEach(() => {
    supabaseState.calls = []
    supabaseState.result = { data: [{ id: 'row-1' }], error: null }
  })

  it('fetchFiscalPeriods mirrors period.list: company filter, newest period first', async () => {
    const rows = await fetchFiscalPeriods('c1')
    expect(rows).toEqual([{ id: 'row-1' }])
    expect(supabaseState.calls).toEqual([
      { method: 'from', args: ['fiscal_periods'] },
      { method: 'select', args: ['*'] },
      { method: 'eq', args: ['company_id', 'c1'] },
      { method: 'order', args: ['period_start', { ascending: false }] },
    ])
  })

  it('fetchCashAccounts mirrors listForCompany: primary first, then ledger account', async () => {
    await fetchCashAccounts('c1')
    expect(supabaseState.calls).toEqual([
      { method: 'from', args: ['cash_accounts'] },
      { method: 'select', args: ['*'] },
      { method: 'eq', args: ['company_id', 'c1'] },
      { method: 'order', args: ['is_primary', { ascending: false }] },
      { method: 'order', args: ['ledger_account', { ascending: true }] },
    ])
  })

  it('throws the Supabase error so SWR surfaces it instead of caching an empty list', async () => {
    supabaseState.result = { data: null, error: { message: 'boom' } }
    await expect(fetchFiscalPeriods('c1')).rejects.toEqual({ message: 'boom' })
  })

  it('resolves to an empty list when the query returns no rows', async () => {
    supabaseState.result = { data: null, error: null }
    expect(await fetchCashAccounts('c1')).toEqual([])
  })
})

describe('API fetchers', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unwraps { data } and hits the documented URLs', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ data: [{ id: 'x' }] }))

    expect(await fetchAccounts()).toEqual([{ id: 'x' }])
    expect(await fetchAccounts(false)).toEqual([{ id: 'x' }])
    expect(await fetchBookingTemplates()).toEqual([{ id: 'x' }])
    expect(await fetchCustomers()).toEqual([{ id: 'x' }])
    expect(await fetchSuppliers()).toEqual([{ id: 'x' }])
    expect(await fetchArticles()).toEqual([{ id: 'x' }])
    expect(await fetchArticles(true)).toEqual([{ id: 'x' }])

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/bookkeeping/accounts',
      '/api/bookkeeping/accounts?active=false',
      '/api/settings/booking-templates',
      '/api/customers',
      '/api/suppliers',
      '/api/articles',
      '/api/articles?include_inactive=1',
    ])
  })

  it('reads the dimensions route from its `dimensions` field', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ dimensions: [{ id: 'd' }] }))
    expect(await fetchDimensions()).toEqual([{ id: 'd' }])
    expect(fetchMock).toHaveBeenCalledWith('/api/dimensions')
  })

  it('returns an empty list when the payload field is missing', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}))
    expect(await fetchCustomers()).toEqual([])
  })

  it('throws a ReferenceFetchError carrying status and body on a non-2xx response', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'nope' }, 403))
    const err = await fetchSuppliers().catch((e) => e)
    expect(err).toBeInstanceOf(ReferenceFetchError)
    expect(err.status).toBe(403)
    expect(err.body).toEqual({ error: 'nope' })
  })

  it('still throws with a null body when the error response is not JSON', async () => {
    fetchMock.mockImplementation(async () => new Response('gateway', { status: 502 }))
    const err = await fetchArticles().catch((e) => e)
    expect(err).toBeInstanceOf(ReferenceFetchError)
    expect(err.status).toBe(502)
    expect(err.body).toBeNull()
  })
})
