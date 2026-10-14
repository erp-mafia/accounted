import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeTransaction,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// GET goes through withRouteContext, which resolves the session via requireAuth.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

// POST is a write route: the role gate has its own suite.
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET, POST } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse } from 'next/server'

describe('GET /api/transactions', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const originalFrom = mockSupabase.from

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.from = originalFrom
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/transactions')
    const response = await GET(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns transactions for the active company with has_more=false when below the cap', async () => {
    const txs = [
      makeTransaction({ id: 'tx-1', amount: -100 }),
      makeTransaction({ id: 'tx-2', amount: 250 }),
    ]
    enqueue({ data: txs, error: null })

    const request = createMockRequest('/api/transactions')
    const response = await GET(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{
      data: typeof txs
      has_more: boolean
      limit: number
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].id).toBe('tx-1')
    expect(body.has_more).toBe(false)
    expect(body.limit).toBe(500)
  })

  it('signals has_more=true and truncates to the cap when more rows exist', async () => {
    // Server requests MAX_ROWS+1 = 501 rows; if the DB returns 501 we know there's more.
    const txs = Array.from({ length: 501 }, (_, i) =>
      makeTransaction({ id: `tx-${i}`, amount: i }),
    )
    enqueue({ data: txs, error: null })

    const request = createMockRequest('/api/transactions')
    const response = await GET(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{
      data: typeof txs
      has_more: boolean
      limit: number
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(500)
    expect(body.has_more).toBe(true)
    expect(body.limit).toBe(500)
  })

  it('filters by unmatched=true', async () => {
    const fromSpy = vi.fn(() => {
      const chain: Record<string, unknown> = {}
      const methods = ['select', 'eq', 'is', 'not', 'gte', 'lte', 'order', 'limit']
      const calls: { method: string; args: unknown[] }[] = []
      for (const m of methods) {
        chain[m] = vi.fn((...args: unknown[]) => {
          calls.push({ method: m, args })
          return chain
        })
      }
      ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null })
      ;(chain as { __calls: typeof calls }).__calls = calls
      return chain
    })
    mockSupabase.from = fromSpy as unknown as typeof mockSupabase.from

    const request = createMockRequest('/api/transactions?unmatched=true')
    await GET(request, createMockRouteParams({}))

    expect(fromSpy).toHaveBeenCalledWith('transactions')
    const chain = fromSpy.mock.results[0].value as { __calls: { method: string; args: unknown[] }[] }
    const isCall = chain.__calls.find((c) => c.method === 'is')
    expect(isCall).toEqual({ method: 'is', args: ['journal_entry_id', null] })
  })

  it('hides rows anchored only through transaction_voucher_links from unmatched=true (bulk-book, 1:N split, #1553)', async () => {
    const txs = [
      makeTransaction({ id: 'tx-open', journal_entry_id: null }),
      makeTransaction({ id: 'tx-split', journal_entry_id: null }),
    ]
    enqueue({ data: txs, error: null }) // transactions list
    enqueue({ data: [{ transaction_id: 'tx-split' }], error: null }) // transaction_voucher_links

    const request = createMockRequest('/api/transactions?unmatched=true')
    const response = await GET(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string }>; has_more: boolean }>(response)

    expect(status).toBe(200)
    expect(body.data.map((t) => t.id)).toEqual(['tx-open'])
    expect(body.has_more).toBe(false)
  })

  it('embeds transaction_voucher_links in every mode so a split row (journal_entry_id NULL, #1553) can be told from an unbooked one (crm#48)', async () => {
    const split = makeTransaction({ id: 'tx-split', journal_entry_id: null }) as unknown as Record<string, unknown>
    split.transaction_voucher_links = [
      { journal_entry_id: 'je-200', role: 'bank_line' },
      { journal_entry_id: 'je-201', role: 'bank_line' },
    ]
    enqueue({ data: [split], error: null })

    const request = createMockRequest('/api/transactions')
    const response = await GET(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string; transaction_voucher_links: Array<{ journal_entry_id: string }> }> }>(response)

    expect(status).toBe(200)
    expect(body.data[0].transaction_voucher_links.map((l) => l.journal_entry_id)).toEqual(['je-200', 'je-201'])
    const selectArgs = findCall('transactions', 'select')
    expect(String(selectArgs?.[0])).toContain('transaction_voucher_links(journal_entry_id, role)')
  })

  it('searches description and merchant across every row when q is given', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions?unmatched=true&q=Acme')
    await GET(request, createMockRouteParams({}))

    expect(findCall('transactions', 'or')).toEqual(['description.ilike.%Acme%,merchant_name.ilike.%Acme%'])
    expect(String(findCall('transactions', 'select')?.[0])).toContain('merchant_name')
  })

  it('ignores a q shorter than two characters', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions?unmatched=true&q=A')
    await GET(request, createMockRouteParams({}))

    expect(findCall('transactions', 'or')).toBeUndefined()
  })

  it('strips the filter-DSL characters from q, so a term cannot add a clause', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest(`/api/transactions?unmatched=true&q=${encodeURIComponent('Acme,company_id.neq.x(%)')}`)
    await GET(request, createMockRouteParams({}))

    expect(findCall('transactions', 'or')).toEqual([
      'description.ilike.%Acme company_id.neq.x%,merchant_name.ilike.%Acme company_id.neq.x%',
    ])
  })

  it('filters by reconciled=true', async () => {
    const fromSpy = vi.fn(() => {
      const chain: Record<string, unknown> = {}
      const methods = ['select', 'eq', 'is', 'not', 'gte', 'lte', 'order', 'limit']
      const calls: { method: string; args: unknown[] }[] = []
      for (const m of methods) {
        chain[m] = vi.fn((...args: unknown[]) => {
          calls.push({ method: m, args })
          return chain
        })
      }
      ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null })
      ;(chain as { __calls: typeof calls }).__calls = calls
      return chain
    })
    mockSupabase.from = fromSpy as unknown as typeof mockSupabase.from

    const request = createMockRequest('/api/transactions?reconciled=true')
    await GET(request, createMockRouteParams({}))

    const chain = fromSpy.mock.results[0].value as { __calls: { method: string; args: unknown[] }[] }
    const notCall = chain.__calls.find((c) => c.method === 'not')
    expect(notCall).toEqual({ method: 'not', args: ['journal_entry_id', 'is', null] })
    // unmatched and reconciled are mutually exclusive: when reconciled is set, no .is() filter
    const isCall = chain.__calls.find((c) => c.method === 'is')
    expect(isCall).toBeUndefined()
  })

  it('applies currency, date_from, and date_to filters', async () => {
    const fromSpy = vi.fn(() => {
      const chain: Record<string, unknown> = {}
      const methods = ['select', 'eq', 'is', 'not', 'gte', 'lte', 'order', 'limit']
      const calls: { method: string; args: unknown[] }[] = []
      for (const m of methods) {
        chain[m] = vi.fn((...args: unknown[]) => {
          calls.push({ method: m, args })
          return chain
        })
      }
      ;(chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve({ data: [], error: null })
      ;(chain as { __calls: typeof calls }).__calls = calls
      return chain
    })
    mockSupabase.from = fromSpy as unknown as typeof mockSupabase.from

    const request = createMockRequest(
      '/api/transactions?currency=SEK&date_from=2024-01-01&date_to=2024-12-31'
    )
    await GET(request, createMockRouteParams({}))

    const chain = fromSpy.mock.results[0].value as { __calls: { method: string; args: unknown[] }[] }
    const eqCalls = chain.__calls.filter((c) => c.method === 'eq')
    // company_id and currency
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['company_id', 'company-1'] },
        { method: 'eq', args: ['currency', 'SEK'] },
      ])
    )
    expect(chain.__calls).toEqual(
      expect.arrayContaining([
        { method: 'gte', args: ['date', '2024-01-01'] },
        { method: 'lte', args: ['date', '2024-12-31'] },
      ])
    )
  })

  it('returns 500 when the query errors', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    const request = createMockRequest('/api/transactions')
    const response = await GET(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(body.error).toBe('Något gick fel. Försök igen.')
  })
})

describe('POST /api/transactions', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const body = { date: '2026-10-01', description: 'Kontantköp', amount: -120, currency: 'SEK' }
  const post = (payload: unknown) =>
    POST(createMockRequest('/api/transactions', { method: 'POST', body: payload }), createMockRouteParams({}))

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await post(body))
    expect(status).toBe(401)
    expect(findCall('transactions', 'insert')).toBeUndefined()
  })

  it('returns 400 on an invalid payload and writes nothing', async () => {
    const { status } = await parseJsonResponse(await post({ ...body, amount: 0 }))
    expect(status).toBe(400)
    expect(findCall('cash_accounts', 'select')).toBeUndefined()
    expect(findCall('transactions', 'insert')).toBeUndefined()
  })

  // crm#1171: the manual form stored every row with cash_account_id NULL, so
  // it fell outside per-account reconciliation. It now takes the default
  // account in its currency, the rule the MCP and ingest doors use.
  it('binds the row to the only enabled account in its currency', async () => {
    enqueue({ data: [{ id: 'ca-1920', is_primary: false, bank_connection_id: null }] }) // default account
    enqueue({ data: makeTransaction({ id: 'tx-1', cash_account_id: 'ca-1920' }) }) // insert

    const { status } = await parseJsonResponse(await post(body))

    expect(status).toBe(201)
    expect(findCalls('cash_accounts', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['enabled', true],
      ['currency', 'SEK'],
    ])
    expect(findCall('transactions', 'insert')?.[0]).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-1',
      cash_account_id: 'ca-1920',
      amount: -120,
    })
  })

  it('binds the primary when several accounts share the currency', async () => {
    enqueue({
      data: [
        { id: 'ca-1940', is_primary: false, bank_connection_id: null },
        { id: 'ca-1930', is_primary: true, bank_connection_id: 'bc-1' },
      ],
    })
    enqueue({ data: makeTransaction({ id: 'tx-2' }) })

    const { status } = await parseJsonResponse(await post(body))

    expect(status).toBe(201)
    expect(findCall('transactions', 'insert')?.[0]).toMatchObject({ cash_account_id: 'ca-1930' })
  })

  it('stores the row unbound when no single account answers, as before', async () => {
    enqueue({
      data: [
        { id: 'ca-eur-1', is_primary: false, bank_connection_id: null },
        { id: 'ca-eur-2', is_primary: false, bank_connection_id: null },
      ],
    })
    enqueue({ data: makeTransaction({ id: 'tx-3', currency: 'EUR' }) })

    const { status } = await parseJsonResponse(await post({ ...body, currency: 'EUR' }))

    expect(status).toBe(201)
    expect(findCall('transactions', 'insert')?.[0]).toMatchObject({ cash_account_id: null, currency: 'EUR' })
  })
})
