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
      next: unknown
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].id).toBe('tx-1')
    expect(body.has_more).toBe(false)
    expect(body.limit).toBe(500)
    expect(body.next).toBeNull()
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
      next: unknown
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(500)
    expect(body.has_more).toBe(true)
    expect(body.limit).toBe(500)
    // The next page starts after the last row answered, not after the extra one read.
    expect(body.next).toEqual({ after_date: txs[499].date, after_id: 'tx-499' })
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

    expect(fromSpy).toHaveBeenCalledTimes(1)
    expect(fromSpy).toHaveBeenCalledWith('open_bank_rows')
    const chain = fromSpy.mock.results[0].value as { __calls: { method: string; args: unknown[] }[] }
    expect(chain.__calls.filter((c) => c.method === 'is')).toEqual([])
    expect(chain.__calls).toContainEqual({ method: 'eq', args: ['company_id', 'company-1'] })
  })

  it('answers unmatched=true with what open_bank_rows answers, with no embed and no anchor read (bulk-book, 1:N split, #1553)', async () => {
    const txs = [makeTransaction({ id: 'tx-open', journal_entry_id: null })]
    enqueue({ data: txs, error: null })

    const request = createMockRequest('/api/transactions?unmatched=true')
    const response = await GET(request, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string }>; has_more: boolean }>(response)

    expect(status).toBe(200)
    expect(body.data.map((t) => t.id)).toEqual(['tx-open'])
    expect(body.has_more).toBe(false)
    expect(String(findCall('open_bank_rows', 'select')?.[0])).not.toContain('transaction_voucher_links')
    expect(findCall('transaction_voucher_links', 'select')).toBeUndefined()
  })

  it('answers what the matcher pointed an open row at, and only for the open rows', async () => {
    enqueue({ data: [], error: null })
    await GET(createMockRequest('/api/transactions?unmatched=true'), createMockRouteParams({}))

    const openSelect = String(findCall('open_bank_rows', 'select')?.[0])
    for (const column of [
      'is_business',
      'potential_invoice_id',
      'potential_supplier_invoice_id',
      'potential_rot_rut_payout_request_id',
      'potential_journal_entry_id',
    ]) {
      expect(openSelect).toContain(column)
    }

    enqueue({ data: [], error: null })
    await GET(createMockRequest('/api/transactions'), createMockRouteParams({}))
    expect(String(findCall('transactions', 'select')?.[0])).not.toContain('potential_invoice_id')
  })

  it('reads ignored rows off the table with the embed: unmatched=true&only_ignored=true is no open list', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions?unmatched=true&only_ignored=true')
    await GET(request, createMockRouteParams({}))

    expect(String(findCall('transactions', 'select')?.[0])).toContain('transaction_voucher_links(journal_entry_id, role)')
    expect(findCalls('transactions', 'eq')).toContainEqual(['is_ignored', true])
    expect(findCall('open_bank_rows', 'select')).toBeUndefined()
  })

  it('embeds transaction_voucher_links in every mode but the open list, so a split row (journal_entry_id NULL, #1553) can be told from an unbooked one (crm#48)', async () => {
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

    expect(findCall('open_bank_rows', 'or')).toEqual(['description.ilike.%Acme%,merchant_name.ilike.%Acme%'])
    expect(String(findCall('open_bank_rows', 'select')?.[0])).toContain('merchant_name')
  })

  it('ignores a q shorter than two characters', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions?unmatched=true&q=A')
    await GET(request, createMockRouteParams({}))

    expect(findCall('open_bank_rows', 'or')).toBeUndefined()
  })

  it('strips the filter-DSL characters from q, so a term cannot add a clause', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest(`/api/transactions?unmatched=true&q=${encodeURIComponent('Acme,company_id.neq.x(%)')}`)
    await GET(request, createMockRouteParams({}))

    expect(findCall('open_bank_rows', 'or')).toEqual([
      'description.ilike.%Acme company_id.neq.x%,merchant_name.ilike.%Acme company_id.neq.x%',
    ])
  })

  it('orders newest first, then by id, so every page continues where the one before ended', async () => {
    enqueue({ data: [], error: null })

    await GET(createMockRequest('/api/transactions?unmatched=true'), createMockRouteParams({}))

    expect(findCalls('open_bank_rows', 'order')).toEqual([
      ['date', { ascending: false }],
      ['id', { ascending: true }],
    ])
    expect(findCall('open_bank_rows', 'or')).toBeUndefined()
  })

  it('reads the page after the row after_date and after_id name (crm#2163)', async () => {
    const id = '00000000-0000-4000-8000-0000000001f3'
    enqueue({ data: [makeTransaction({ id: 'tx-501', date: '2026-10-29' })], error: null })

    const response = await GET(
      createMockRequest(`/api/transactions?unmatched=true&after_date=2026-10-29&after_id=${id}`),
      createMockRouteParams({}),
    )
    const { status, body } = await parseJsonResponse<{ data: Array<{ id: string }>; has_more: boolean; next: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data.map((t) => t.id)).toEqual(['tx-501'])
    expect(body.has_more).toBe(false)
    expect(body.next).toBeNull()
    expect(findCall('open_bank_rows', 'or')).toEqual([`date.lt.2026-10-29,and(date.eq.2026-10-29,id.gt.${id})`])
  })

  it('takes back its own next: the cursor of the last row it answered', async () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
    enqueue({ data: Array.from({ length: 501 }, (_, i) => makeTransaction({ id: uuid(i), date: '2026-10-29' })), error: null })
    const first = await parseJsonResponse<{ next: { after_date: string; after_id: string } }>(
      await GET(createMockRequest('/api/transactions?unmatched=true'), createMockRouteParams({})),
    )
    expect(first.body.next).toEqual({ after_date: '2026-10-29', after_id: uuid(499) })

    reset()
    enqueue({ data: [], error: null })
    const params = new URLSearchParams({ unmatched: 'true', ...first.body.next })
    const second = await GET(createMockRequest(`/api/transactions?${params}`), createMockRouteParams({}))

    expect(second.status).toBe(200)
    expect(findCall('open_bank_rows', 'or')).toEqual([`date.lt.2026-10-29,and(date.eq.2026-10-29,id.gt.${uuid(499)})`])
  })

  it('keeps the account scope and the search when it pages: each is its own filter', async () => {
    const accountId = '00000000-0000-4000-8000-00000000ca01'
    const id = '00000000-0000-4000-8000-0000000001f3'
    enqueue({ data: { id: accountId, currency: 'SEK', is_primary: true }, error: null })
    enqueue({ data: [], error: null })

    const response = await GET(
      createMockRequest(`/api/transactions?unmatched=true&account_number=1930&q=Acme&after_date=2026-10-29&after_id=${id}`),
      createMockRouteParams({}),
    )

    expect(response.status).toBe(200)
    expect(findCalls('open_bank_rows', 'or')).toEqual([
      [`cash_account_id.eq.${accountId},cash_account_id.is.null`],
      ['description.ilike.%Acme%,merchant_name.ilike.%Acme%'],
      [`date.lt.2026-10-29,and(date.eq.2026-10-29,id.gt.${id})`],
    ])
  })

  it('refuses a half cursor, an impossible date or an id that is not a uuid, before reading anything', async () => {
    const id = '00000000-0000-4000-8000-0000000001f3'
    const cursors = [
      'after_date=2026-10-29',
      `after_id=${id}`,
      `after_date=2026-02-31&after_id=${id}`,
      `after_date=2026-10-29&after_id=${encodeURIComponent('x),company_id.neq.(y')}`,
    ]
    for (const cursor of cursors) {
      reset()
      const response = await GET(createMockRequest(`/api/transactions?unmatched=true&${cursor}`), createMockRouteParams({}))
      expect(response.status, cursor).toBe(400)
      expect(findCall('open_bank_rows', 'select'), cursor).toBeUndefined()
    }
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

    expect(fromSpy).toHaveBeenCalledWith('transactions')
    const chain = fromSpy.mock.results[0].value as { __calls: { method: string; args: unknown[] }[] }
    expect(chain.__calls).toContainEqual({ method: 'eq', args: ['is_booked', true] })
    // A row booked through a link or a payment has no pointer: the filter is never on it.
    expect(chain.__calls.find((c) => c.method === 'not')).toBeUndefined()
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
    expect(body.error).toBe('Något gick fel. Försök igen, och kontakta support om det fortsätter.')
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
      // A company card never takes a row created without an account.
      ['kind', 'bank'],
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
