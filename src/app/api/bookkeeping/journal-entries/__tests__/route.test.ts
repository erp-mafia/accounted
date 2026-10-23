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

const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }))
vi.mock('@/lib/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    child: (): unknown => logger,
  }
  return { createLogger: () => logger }
})

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

  it('keeps a pure storno visible under collapse_corrections and folds only corrected groups (#3149)', async () => {
    // The list builder is created before the corrections prefetch, and the
    // queued mock binds a result at from() time: list result first.
    enqueue({ data: [], error: null, count: 0 })
    enqueue({ data: [{ correction_of_id: 'orig-1' }], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', include_related: 'false', collapse_corrections: 'true' },
    })
    const response = await GET(request, {} as never)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // No blanket storno filter: a storno that no correction replaced is the
    // only row carrying its voucher number and must stay in the series.
    expect(findCalls('journal_entries', 'neq').map((c) => c[0])).not.toContain('source_type')
    // The corrected original folds, and so does its storno: a storno drops
    // only when reverses_id points at a corrected original.
    expect(findCalls('journal_entries', 'not')).toContainEqual(['id', 'in', '(orig-1)'])
    expect(findCalls('journal_entries', 'or').map((c) => c[0])).toContain(
      'source_type.neq.storno,reverses_id.is.null,reverses_id.not.in.(orig-1)',
    )
  })

  it('applies no collapse filter when the company has no posted correction', async () => {
    enqueue({ data: [], error: null, count: 0 })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', include_related: 'false', collapse_corrections: 'true' },
    })
    const response = await GET(request, {} as never)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(findCalls('journal_entries', 'neq').map((c) => c[0])).not.toContain('source_type')
    expect(findCalls('journal_entries', 'or')).toEqual([])
    expect(findCalls('journal_entries', 'not').filter((c) => c[0] === 'id')).toEqual([])
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

  it('orders by the display_amount computed column on amount sort, bypassing the RPC', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', sort_by: 'total_desc' },
    })
    const response = await GET(request)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // Amount sort orders by a PostgREST computed column (migration
    // 20261018135300) that the include_related RPC can't express, so the
    // route must fall through to the direct query (strict period view),
    // exactly like voucher sort. It is display_amount, the amount the Belopp
    // column shows, not total_amount, the omslutning (crm#1280).
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(findCalls('journal_entries', 'order')[0]).toEqual([
      'display_amount',
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
      ['display_amount', { ascending: false }],
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
      ['display_amount', { ascending: true }],
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

  it('clamps a large limit to the 1,000 rows one request can return, and floors a negative offset', async () => {
    enqueue({ data: [], error: null, count: 0 })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      // PostgREST cuts every response at 1,000 rows, so a larger limit would
      // come back truncated under a count that claims more. "Alla" collects
      // the list in 1,000-row chunks instead. Both bounds are server-side
      // (ASVS V1.2.5).
      searchParams: { limit: '999999', offset: '-5', include_related: 'false' },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
    expect(findCalls('journal_entries', 'range')).toEqual([[0, 999]])
  })

  it('passes the clamped limit to the fiscal-period RPC as well', async () => {
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      searchParams: { period_id: 'period-1', limit: '100000', offset: '2000' },
    })
    const response = await GET(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'list_fiscal_period_entries_with_related',
      expect.objectContaining({ p_limit: 1000, p_offset: 2000 }),
    )
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

  describe('missing_underlag=true (the dashboard deep-link filter)', () => {
    // UUID-shaped ids, as journal_entries.id produces them.
    const E1 = '11111111-1111-4111-8111-111111111111'
    const E2 = '22222222-2222-4222-8222-222222222222'
    const E3 = '33333333-3333-4333-8333-333333333333'
    const RPC = 'list_verifikat_missing_underlag'
    const rpcArgs = () =>
      (mockSupabase.rpc.mock.calls.find(([name]) => name === RPC) as unknown[] | undefined)?.[1] as
        | Record<string, unknown>
        | undefined

    it('returns the page the RPC resolved, in its order, with the full-set count', async () => {
      enqueue({ data: { ok: true, total_count: 3, ids: [E3, E1] }, error: null }) // the RPC
      enqueue({ data: [makeJournalEntry({ id: E1 }), makeJournalEntry({ id: E3 })], error: null }) // page rows

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', exclude_draft: 'true', limit: '2' },
      })
      const { status, body } = await parseJsonResponse<{ data: { id: string }[]; count: number }>(
        await GET(request)
      )

      expect(status).toBe(200)
      // Reassembled in the RPC's order (the .in() row fetch has none).
      expect(body.data.map((e) => e.id)).toEqual([E3, E1])
      expect(body.count).toBe(3)
    })

    it('costs one RPC call and one page-row read, however long the ledger (crm#1390)', async () => {
      enqueue({ data: { ok: true, total_count: 4600, ids: [E1, E2] }, error: null })
      enqueue({ data: [makeJournalEntry({ id: E1 }), makeJournalEntry({ id: E2 })], error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', exclude_draft: 'true', limit: '20' },
      })
      const { status, body } = await parseJsonResponse<{ data: unknown[]; count: number }>(await GET(request))

      expect(status).toBe(200)
      expect(body.count).toBe(4600)
      // Before: every candidate read into the server, then 7 lookups per
      // 150 ids, chunk after chunk; a 4,600-verifikat ledger paid ~100
      // sequential round trips before this page could render.
      expect(mockSupabase.rpc.mock.calls.filter(([name]) => name === RPC)).toHaveLength(1)
      expect(mockSupabase.from).toHaveBeenCalledTimes(1)
      expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
      expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
      expect(mockSupabase.from).not.toHaveBeenCalledWith('journal_entry_no_doc_required')
    })

    it('passes the scope, page and the list sort through to the RPC', async () => {
      enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: {
          missing_underlag: 'true',
          period_id: 'period-1',
          series: 'B',
          date_from: '2026-01-01',
          date_to: '2026-06-30',
          exclude_draft: 'true',
          sort_by: 'total_desc',
          limit: '50',
          offset: '100',
        },
      })
      const { status, body } = await parseJsonResponse<{ data: unknown[]; count: number }>(await GET(request))

      expect(status).toBe(200)
      expect(body).toEqual({ data: [], count: 0 })
      expect(rpcArgs()).toMatchObject({
        p_company_id: 'company-1',
        p_period_id: 'period-1',
        p_series: 'B',
        p_date_from: '2026-01-01',
        p_date_to: '2026-06-30',
        // Amount sorts order by the amount the list shows (crm#1280).
        p_order: ['display_amount.desc', 'voucher_series.desc', 'voucher_number.desc', 'id.desc'],
        p_limit: 50,
        p_offset: 100,
      })
      // No page rows to read for an empty page.
      expect(mockSupabase.from).not.toHaveBeenCalled()
    })

    it('takes this path instead of the include_related RPC when a period is selected', async () => {
      enqueue({ data: { ok: true, total_count: 0, ids: [] }, error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', period_id: 'period-1', exclude_draft: 'true' },
      })
      const { status } = await parseJsonResponse(await GET(request))

      expect(status).toBe(200)
      expect(mockSupabase.rpc).not.toHaveBeenCalledWith(
        'list_fiscal_period_entries_with_related',
        expect.anything(),
      )
    })

    it('matches a voucher-label search against series+number, like the direct path', async () => {
      enqueue({ data: { ok: true, total_count: 1, ids: [E1] }, error: null })
      enqueue({ data: [makeJournalEntry({ id: E1 })], error: null })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', exclude_draft: 'true', search: 'A209' },
      })
      const { status, body } = await parseJsonResponse<{ data: { id: string }[]; count: number }>(
        await GET(request)
      )

      expect(status).toBe(200)
      expect(body.data.map((e) => e.id)).toEqual([E1])
      expect(rpcArgs()).toMatchObject({
        p_search_pattern: '%A209%',
        p_search_voucher_series: 'A',
        p_search_voucher_number: 209,
      })
    })

    it('logs the driver error and answers with the Swedish text when the RPC fails (#2395)', async () => {
      const driverError = { message: 'canceling statement due to statement timeout', code: '57014', details: null, hint: null }
      enqueue({ data: null, error: driverError })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', exclude_draft: 'true' },
      })
      const { status, body } = await parseJsonResponse<{ error: string }>(await GET(request, { params: Promise.resolve({}) }))

      expect(status).toBe(500)
      expect(body.error).toBe('Verifikationerna kunde inte hämtas. Försök igen.')
      const call = mockLogError.mock.calls.find(([msg]) => msg === 'failed to resolve missing-underlag entries')
      expect(call).toBeDefined()
      expect(call![2]).toEqual({ cause: driverError })
    })

    it('is ignored for the drafts view', async () => {
      enqueue({ data: [], error: null, count: 0 })

      const request = createMockRequest('/api/bookkeeping/journal-entries', {
        searchParams: { missing_underlag: 'true', status: 'draft' },
      })
      const { status } = await parseJsonResponse(await GET(request))

      expect(status).toBe(200)
      // The drafts view goes through the normal direct query, not the RPC.
      expect(mockSupabase.from).toHaveBeenCalledWith('journal_entries')
      expect(mockSupabase.rpc).not.toHaveBeenCalledWith(RPC, expect.anything())
    })
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
    // Through the posting port, whose ledger adapter always passes the
    // commitMethod and rubricVersion positions (undefined here).
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', input, undefined, undefined)
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

/**
 * The dashboard route accepts only the source types the dashboard's own forms
 * author ('manual', and 'vat_settlement' for the reviewed momsredovisning
 * proposal and VAT templates). An engine-owned label would let a business
 * voucher claim that type's dimension-policy exemption ('system' skips every
 * rule, 'accrual' skips registry validation) and show a false source.
 */
describe('POST /api/bookkeeping/journal-entries: source_type allowlist', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const emptyParams = { params: Promise.resolve({}) }
  const baseBody = {
    fiscal_period_id: VALID_UUID,
    entry_date: '2024-06-15',
    description: 'Test entry',
    lines: [
      { account_number: '6570', debit_amount: 100, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 100 },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it.each([
    'system',
    'accrual',
    'storno',
    'correction',
    'year_end',
    'import',
    'opening_balance',
    'credit_note',
    'invoice_paid',
  ])('rejects the engine-owned source_type %s with 400 before the engine runs', async (sourceType) => {
    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: { ...baseBody, source_type: sourceType },
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string; errors: Array<{ field: string }> }>(response)

    expect(status).toBe(400)
    expect(body.errors.map((e) => e.field)).toEqual(['source_type'])
    expect(body.error).toContain('"manual" eller "vat_settlement"')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('books the reviewed VAT settlement with source_type vat_settlement', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry())

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: { ...baseBody, source_type: 'vat_settlement' },
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'vat_settlement' }),
      undefined,
      undefined,
    )
  })

  it('defaults an omitted source_type to manual', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry())

    const request = createMockRequest('/api/bookkeeping/journal-entries', {
      method: 'POST',
      body: baseBody,
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'manual' }),
      undefined,
      undefined,
    )
  })
})
