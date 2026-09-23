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
const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))

vi.mock('@/lib/bookkeeping/bas-reference', () => ({
  getBASReference: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({
  // All referenced accounts already exist → no chart activation insert.
  fetchAllRows: vi.fn().mockResolvedValue([
    { account_number: '1930' },
    { account_number: '2099' },
  ]),
}))

import { POST } from '../correct/route'

const PERIOD_ID = '550e8400-e29b-41d4-a716-446655440000'
const BALANCED_LINES = [
  { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
  { account_number: '2099', debit_amount: 0, credit_amount: 50000 },
]

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/opening-balance/correct', {
    method: 'POST',
    body,
  })
}

function openPeriodWithOB(overrides: Record<string, unknown> = {}) {
  return {
    id: PERIOD_ID,
    company_id: 'company-1',
    is_closed: false,
    locked_at: null,
    opening_balances_set: true,
    opening_balance_entry_id: 'entry-old',
    period_start: '2026-01-01',
    ...overrides,
  }
}

describe('POST /api/import/opening-balance/correct', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 400 for invalid body', async () => {
    const res = await POST(makeRequest({ fiscal_period_id: 'not-a-uuid', lines: [] }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 for non-existent fiscal period', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('OB_PERIOD_NOT_FOUND')
  })

  it('returns 400 when the period is closed', async () => {
    enqueue({ data: openPeriodWithOB({ is_closed: true }) })

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('OB_PERIOD_CLOSED')
  })

  it('returns 400 when the period is locked', async () => {
    enqueue({ data: openPeriodWithOB({ locked_at: '2026-06-28T00:00:00Z' }) })

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('OB_PERIOD_LOCKED')
  })

  it('returns 409 when the company lock date covers the period start', async () => {
    enqueue({ data: openPeriodWithOB() }) // period (period_start 2026-01-01)
    enqueue({ data: { bookkeeping_locked_through: '2026-02-28' } }) // company lock-date pre-flight

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(409)
    const err = body.error as unknown as { code: string; details?: { lockDate?: string; entryDate?: string } }
    expect(err.code).toBe('OB_COMPANY_LOCK_DATE')
    expect(err.details?.lockDate).toBe('2026-02-28')
    expect(err.details?.entryDate).toBe('2026-01-01')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('proceeds when the company lock date is before the period start', async () => {
    enqueue({ data: openPeriodWithOB() }) // period (period_start 2026-01-01)
    enqueue({ data: { bookkeeping_locked_through: '2025-12-31' } }) // company lock-date pre-flight
    enqueue({ count: 0 }) // year-end check
    enqueue({ error: null }) // replace_period_opening_balance_link RPC

    mockCreateJournalEntry.mockResolvedValue({ id: 'entry-new', voucher_series: 'A', voucher_number: 5 })
    mockReverseEntry.mockResolvedValue({ id: 'entry-storno' })

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
  })

  it('maps a raced lock-date trigger rejection to OB_COMPANY_LOCK_DATE instead of a retryable 500', async () => {
    enqueue({ data: openPeriodWithOB() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // pre-flight passes (lock set after it)
    enqueue({ count: 0 }) // year-end check

    // The enforce_company_lock_date trigger fired inside the engine.
    mockCreateJournalEntry.mockRejectedValue(
      new Error('Database operation "create_draft_entry" failed: Bokföringen är låst t.o.m. 2026-02-28. Kan inte skapa verifikation med datum 2026-01-01.'),
    )

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(409)
    expect((body.error as unknown as { code: string }).code).toBe('OB_COMPANY_LOCK_DATE')
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('returns 409 when the period has no opening balances to correct', async () => {
    enqueue({ data: openPeriodWithOB({ opening_balances_set: false, opening_balance_entry_id: null }) })
    enqueue({ data: { bookkeeping_locked_through: null } }) // company lock-date pre-flight

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(409)
    expect((body.error as unknown as { code: string }).code).toBe('OB_CORRECT_NO_EXISTING')
  })

  it('returns 409 when a year-end close exists on the period', async () => {
    enqueue({ data: openPeriodWithOB() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // company lock-date pre-flight
    enqueue({ count: 1 }) // year-end entry count

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(409)
    expect((body.error as unknown as { code: string }).code).toBe('OB_CORRECT_YEAR_END_EXISTS')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('returns 400 for unbalanced corrected lines', async () => {
    enqueue({ data: openPeriodWithOB() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // company lock-date pre-flight
    enqueue({ count: 0 }) // year-end check

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

  it('books a corrected IB, stornoes the old one, and relinks on success', async () => {
    enqueue({ data: openPeriodWithOB() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // company lock-date pre-flight
    enqueue({ count: 0 }) // year-end check
    enqueue({ error: null }) // replace_period_opening_balance_link RPC

    mockCreateJournalEntry.mockResolvedValue({ id: 'entry-new', voucher_series: 'A', voucher_number: 5 })
    mockReverseEntry.mockResolvedValue({ id: 'entry-storno' })

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(body.data.journal_entry_id).toBe('entry-new')
    expect(body.data.reversed_entry_id).toBe('entry-old')
    expect(body.data.lines_created).toBe(2)

    // New IB created before the old one is reversed.
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ source_type: 'opening_balance', voucher_series: 'A' }),
    )
    expect(mockReverseEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'entry-old',
    )
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'replace_period_opening_balance_link',
      expect.objectContaining({ p_period_id: PERIOD_ID, p_new_entry_id: 'entry-new' }),
    )
  })

  it('returns 500 OB_CORRECT_FAILED if the relink RPC fails', async () => {
    enqueue({ data: openPeriodWithOB() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // company lock-date pre-flight
    enqueue({ count: 0 }) // year-end check
    enqueue({ error: { message: 'relink boom' } }) // RPC failure

    mockCreateJournalEntry.mockResolvedValue({ id: 'entry-new', voucher_series: 'A', voucher_number: 5 })
    mockReverseEntry.mockResolvedValue({ id: 'entry-storno' })

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('OB_CORRECT_FAILED')
  })
})
