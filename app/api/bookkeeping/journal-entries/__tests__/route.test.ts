import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeJournalEntry,
} from '@/tests/helpers'

// Mock dependencies
const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
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
    expect(body.error).toBe('DB error')
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
    expect(body.error).toBe('Unbalanced entry')
  })
})
