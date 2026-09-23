import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

vi.mock('@/lib/bookkeeping/bas-reference', () => ({
  getBASReference: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn().mockResolvedValue([
    { account_number: '1930' },
    { account_number: '2099' },
    { account_number: '2440' },
    { account_number: '1510' },
    { account_number: '3001' },
  ]),
}))

import { POST } from '../execute/route'

const PERIOD_ID = '550e8400-e29b-41d4-a716-446655440000'

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/opening-balance/execute', {
    method: 'POST',
    body,
  })
}

describe('POST /api/import/opening-balance/execute', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const res = await POST(makeRequest({
      fiscal_period_id: PERIOD_ID,
      lines: [
        { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
        { account_number: '2099', debit_amount: 0, credit_amount: 50000 },
      ],
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 400 for invalid body', async () => {
    const res = await POST(makeRequest({
      fiscal_period_id: 'not-a-uuid',
      lines: [],
    }))
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(400)
  })

  it('returns 404 for non-existent fiscal period', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const res = await POST(makeRequest({
      fiscal_period_id: PERIOD_ID,
      lines: [
        { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
        { account_number: '2099', debit_amount: 0, credit_amount: 50000 },
      ],
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('OB_PERIOD_NOT_FOUND')
  })

  it('returns 409 if period already has opening balances', async () => {
    enqueue({
      data: {
        id: PERIOD_ID,
        company_id: 'company-1',
        is_closed: false,
        locked_at: null,
        opening_balances_set: true,
        opening_balance_entry_id: 'entry-existing',
        period_start: '2026-01-01',
      },
    })

    const res = await POST(makeRequest({
      fiscal_period_id: PERIOD_ID,
      lines: [
        { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
        { account_number: '2099', debit_amount: 0, credit_amount: 50000 },
      ],
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(409)
    expect((body.error as unknown as { code: string }).code).toBe('OB_PERIOD_ALREADY_HAS_BALANCES')
    expect(
      (body.error as unknown as { details: { existingEntryId: string } }).details.existingEntryId,
    ).toBe('entry-existing')
  })

  it('returns 400 for unbalanced lines', async () => {
    enqueue({
      data: {
        id: PERIOD_ID,
        company_id: 'company-1',
        is_closed: false,
        locked_at: null,
        opening_balances_set: false,
        period_start: '2026-01-01',
      },
    })

    const res = await POST(makeRequest({
      fiscal_period_id: PERIOD_ID,
      lines: [
        { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
        { account_number: '2099', debit_amount: 0, credit_amount: 40000 },
      ],
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('OB_UNBALANCED')
  })

  it('returns 400 for P&L accounts', async () => {
    enqueue({
      data: {
        id: PERIOD_ID,
        company_id: 'company-1',
        is_closed: false,
        locked_at: null,
        opening_balances_set: false,
        period_start: '2026-01-01',
      },
    })

    const res = await POST(makeRequest({
      fiscal_period_id: PERIOD_ID,
      lines: [
        { account_number: '3001', debit_amount: 0, credit_amount: 50000 },
        { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
      ],
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('OB_PNL_ACCOUNT')
  })

  it('creates journal entry on success', async () => {
    // Fiscal period query
    enqueue({
      data: {
        id: PERIOD_ID,
        company_id: 'company-1',
        is_closed: false,
        locked_at: null,
        opening_balances_set: false,
        period_start: '2026-01-01',
      },
    })

    // Fiscal period update
    enqueue({ data: null })

    mockCreateJournalEntry.mockResolvedValue({
      id: 'entry-new',
      company_id: 'company-1',
      user_id: 'user-1',
      fiscal_period_id: PERIOD_ID,
      entry_date: '2026-01-01',
      description: 'Ingående balanser (Excel-import)',
      source_type: 'opening_balance',
      voucher_series: 'A',
      voucher_number: 1,
      source_id: null,
      reverses_id: null,
      reversed_by_id: null,
      correction_of_id: null,
      attachment_urls: null,
      notes: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    })

    const res = await POST(makeRequest({
      fiscal_period_id: PERIOD_ID,
      lines: [
        { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
        { account_number: '2099', debit_amount: 0, credit_amount: 50000 },
      ],
    }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(body.data.journal_entry_id).toBe('entry-new')
    expect(body.data.lines_created).toBe(2)
    expect(body.data.total_debit).toBe(50000)
    expect(body.data.total_credit).toBe(50000)

    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        fiscal_period_id: PERIOD_ID,
        entry_date: '2026-01-01',
        source_type: 'opening_balance',
        voucher_series: 'A',
      }),
    )
  })
})
