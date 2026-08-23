import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeJournalEntry,
} from '@/tests/helpers'

// Mock dependencies
const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

import { GET, POST } from '../route'

describe('GET /api/bookkeeping/journal-entries', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/bookkeeping/journal-entries')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns entries list', async () => {
    const entries = [makeJournalEntry(), makeJournalEntry()]
    enqueue({ data: entries, error: null, count: 2 })

    const request = createMockRequest('/api/bookkeeping/journal-entries')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ data: unknown[]; count: number }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(entries)
    expect(body.count).toBe(2)
  })

  it('passes filters to query', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: {
        period_id: 'period-1',
        status: 'posted',
        date_from: '2024-01-01',
        date_to: '2024-12-31',
        limit: '10',
        offset: '5',
        // Strict period filtering: exercises the PostgREST path, not the RPC.
        include_related: 'false',
      },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
  })

  it('uses RPC with include_related when period_id is set', async () => {
    const rpcRows = [
      {
        entry: { ...makeJournalEntry({ id: 'je-1' }), out_of_period: false },
        total_count: 2,
      },
      {
        entry: { ...makeJournalEntry({ id: 'je-2' }), out_of_period: true },
        total_count: 2,
      },
    ]
    enqueue({ data: rpcRows, error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1' },
    })
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{
      data: Array<{ id: string; out_of_period?: boolean }>
      count: number
    }>(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'list_fiscal_period_entries_with_related',
      expect.objectContaining({
        p_company_id: 'company-1',
        p_period_id: 'period-1',
        p_include_related: true,
      })
    )
    expect(body.data).toHaveLength(2)
    expect(body.data[1].out_of_period).toBe(true)
    expect(body.count).toBe(2)
  })

  it('forwards explicit ?status=cancelled to the RPC', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', status: 'cancelled' },
    })
    await GET(request)

    // The RPC itself hides cancelled entries unless p_status='cancelled' is
    // passed explicitly (see migration 20260428153500). The behavior of the
    // hide-by-default logic lives in SQL and is covered by pg-real tests.
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'list_fiscal_period_entries_with_related',
      expect.objectContaining({ p_status: 'cancelled' })
    )
  })

  it('uses the direct query path (not the RPC) when a search term is set', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', search: 'luftfyllning' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // Free-text search needs an ILIKE the include_related RPC can't express, so
    // the route must fall through to the direct PostgREST query.
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('matches a voucher label like "A209" on series+number as well as description', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', search: 'A209' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const orCalls = findCalls('journal_entries', 'or')
    expect(orCalls).toHaveLength(1)
    expect(orCalls[0][0]).toBe(
      'description.ilike."%A209%",and(voucher_series.eq.A,voucher_number.eq.209)',
    )
    // The plain ilike path must not ALSO run, or the OR would be ANDed away.
    expect(findCalls('journal_entries', 'ilike')).toHaveLength(0)
  })

  it('accepts "a 209" and "A-209" as voucher labels', async () => {
    for (const needle of ['a 209', 'A-209']) {
      reset()
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
      enqueue({ data: [], error: null, count: 0 })
      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { period_id: 'period-1', search: needle },
      })
      await GET(request)
      const orCalls = findCalls('journal_entries', 'or')
      expect(orCalls, needle).toHaveLength(1)
      expect(String(orCalls[0][0])).toContain('and(voucher_series.eq.A,voucher_number.eq.209)')
    }
  })

  it('keeps the plain description ilike for non-label needles', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', search: 'hyra, kvartal 1 (50%)' },
    })
    await GET(request)

    expect(findCalls('journal_entries', 'or')).toHaveLength(0)
    const ilikeCalls = findCalls('journal_entries', 'ilike')
    expect(ilikeCalls).toHaveLength(1)
    expect(ilikeCalls[0][0]).toBe('description')
    expect(ilikeCalls[0][1]).toBe('%hyra, kvartal 1 (50\\%)%')
  })

  it('orders by the total_amount computed column on amount sort, bypassing the RPC', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', sort_by: 'total_desc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // Amount sort orders by a PostgREST computed column (migration
    // 20260811100000) that the include_related RPC can't express, so the
    // route must fall through to the direct query (strict period view),
    // exactly like voucher sort.
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(findCalls('journal_entries', 'order')[0]).toEqual([
      'total_amount',
      { ascending: false },
    ])
  })

  it('orders by description on description sort, bypassing the RPC', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', sort_by: 'description_asc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(findCalls('journal_entries', 'order')[0]).toEqual([
      'description',
      { ascending: true },
    ])
  })

  it('chains stacked sort keys in priority order and bypasses the RPC', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', sort_by: 'total_desc,description_asc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    // Priority order preserved, then the voucher tiebreak in the LAST key's
    // direction (ascending here), then the globally unique id tiebreak:
    // series+number repeat across fiscal years, so equal keys need a total
    // order for stable pagination.
    expect(findCalls('journal_entries', 'order')).toEqual([
      ['total_amount', { ascending: false }],
      ['description', { ascending: true }],
      ['voucher_series', { ascending: true }],
      ['voucher_number', { ascending: true }],
      ['id', { ascending: true }],
    ])
  })

  it('dedupes repeated sort columns and caps the stack at three keys', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: {
        include_related: 'false',
        sort_by: 'date_desc,date_asc,nonsense,voucher_desc,total_asc,description_asc',
      },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // date deduped (first token wins), the unknown token is ignored, and the
    // stack caps at three keys (date, voucher, total): description never
    // makes it in. Voucher is in the stack, so no series+number tiebreak is
    // appended; the id tiebreak always is (duplicate series+number across
    // fiscal years on the all-years scope).
    expect(findCalls('journal_entries', 'order')).toEqual([
      ['entry_date', { ascending: false }],
      ['voucher_series', { ascending: false }],
      ['voucher_number', { ascending: false }],
      ['total_amount', { ascending: true }],
      ['id', { ascending: true }],
    ])
  })

  it('appends the id tiebreak on the all-years scope where voucher identifiers repeat', async () => {
    enqueue({ data: [], error: null, count: 0 })

    // No period_id: the "Alla räkenskapsår" scope, where A-1 exists once per
    // fiscal year. Without a globally unique final key, rows with equal
    // (entry_date, series, number) can swap between page requests and be
    // duplicated or dropped at page boundaries.
    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { include_related: 'false', sort_by: 'date_desc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    const orderCalls = findCalls('journal_entries', 'order')
    expect(orderCalls[orderCalls.length - 1]).toEqual(['id', { ascending: false }])
  })

  it('still serves a single date sort key through the include_related RPC', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', sort_by: 'date_asc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'list_fiscal_period_entries_with_related',
      expect.objectContaining({ p_sort_date: 'asc' }),
    )
  })

  it('accepts a large limit (the "Alla" page size) and a negative offset without erroring', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      // 'Alla' sends a large limit; the route clamps it to MAX_LIMIT. A negative
      // offset is floored to 0. Both are bounded server-side (ASVS V1.2.5).
      searchParams: { limit: '999999', offset: '-5', include_related: 'false' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
  })

  it('returns 500 on database error', async () => {
    enqueue({ data: null, error: { message: 'DB error' } })

    const request = createMockRequest('/api/bookkeeping/journal-entries')
    const response = await GET(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    // Raw Supabase messages never reach the response field (issue #337).
    expect(body.error).toBe('Verifikationerna kunde inte hämtas. Försök igen.')
  })
})

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

describe('POST /api/bookkeeping/journal-entries', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('creates journal entry and returns it', async () => {
    const entry = makeJournalEntry()
    mockCreateJournalEntry.mockResolvedValue(entry)

    const input = {
      fiscal_period_id: VALID_UUID,
      entry_date: '2024-06-15',
      description: 'Test entry',
      source_type: 'manual',
      lines: [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
      ],
    }

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: input,
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ data: unknown }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual(entry)
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', input)
  })

  it('returns 400 when engine throws', async () => {
    mockCreateJournalEntry.mockRejectedValue(new Error('Unbalanced entry'))

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: {
        fiscal_period_id: VALID_UUID,
        entry_date: '2024-06-15',
        description: 'Bad entry',
        source_type: 'manual',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 500 },
        ],
      },
    })
    const response = await POST(request)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    // Untyped engine errors map to the Swedish context fallback (issue #337).
    expect(body.error).toBe('Kunde inte hantera verifikationen. Försök igen.')
  })
})
