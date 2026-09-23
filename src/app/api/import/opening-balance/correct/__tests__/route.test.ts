import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  // All referenced accounts already exist → no chart activation insert (and no
  // extra supabase.from() call that would shift the queued-mock cursor).
  fetchAllRows: vi.fn().mockResolvedValue([
    { account_number: '1930' },
    { account_number: '2099' },
  ]),
}))

import { POST } from '../route'

type SpyInstance = ReturnType<typeof vi.spyOn>

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
    // Embedded resource from the period fetch: the original IB verifikat's
    // voucher label, used to build the BFL 5 kap 5§ reference.
    opening_balance_entry: { voucher_series: 'A', voucher_number: 123 },
    ...overrides,
  }
}

/** Flatten every console.error call into one searchable string. */
function auditLines(spy: SpyInstance): string {
  return spy.mock.calls
    .map((call) => call.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .filter((line) => line.includes('opening balance correction failed'))
    .join('\n')
}

describe('POST /api/import/opening-balance/correct: atomicity, audit, BFL reference', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  let errorSpy: SpyInstance

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    // The structured logger writes error-level records to console.error even in
    // the test env; spy on it so we can assert the durable audit line.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  // FIX 3 (BFL 5 kap 5§): the corrected entry references the original voucher.
  it('references the original verifikationsnummer in the corrected entry description', async () => {
    enqueue({ data: openPeriodWithOB({ opening_balance_entry: { voucher_series: 'B', voucher_number: 7 } }) }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // company lock-date pre-flight
    enqueue({ count: 0 }) // year-end check
    enqueue({ error: null }) // replace_period_opening_balance_link RPC

    mockCreateJournalEntry.mockResolvedValue({ id: 'entry-new', voucher_series: 'A', voucher_number: 9 })
    mockReverseEntry.mockResolvedValue({ id: 'entry-storno' })

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body.data.success).toBe(true)
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        description: 'Ingående balanser (korrigerade, rättelse av B7)',
        source_type: 'opening_balance',
      }),
    )
    // Happy path stornoes ONLY the old entry, no compensating reverse.
    expect(mockReverseEntry).toHaveBeenCalledTimes(1)
    expect(mockReverseEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'entry-old')
  })

  // FIX 1 (ASVS V2.3): compensation when the storno of the OLD entry throws
  // after the new entry was already created.
  it('compensates by stornoing the new entry when reverseEntry throws, returning OB_CORRECT_FAILED', async () => {
    enqueue({ data: openPeriodWithOB() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // company lock-date pre-flight
    enqueue({ count: 0 }) // year-end check
    // No RPC enqueue: step B throws before the relink is reached.

    mockCreateJournalEntry.mockResolvedValue({ id: 'entry-new', voucher_series: 'A', voucher_number: 9 })
    mockReverseEntry
      .mockRejectedValueOnce(new Error('storno of old failed')) // step B (oldEntryId)
      .mockResolvedValueOnce({ id: 'entry-storno-new' }) // compensation (newEntry.id)

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('OB_CORRECT_FAILED')

    // First the failed storno of the old entry, then the compensating storno of
    // the new entry.
    expect(mockReverseEntry).toHaveBeenCalledTimes(2)
    expect(mockReverseEntry).toHaveBeenNthCalledWith(1, expect.anything(), 'company-1', 'user-1', 'entry-old')
    expect(mockReverseEntry).toHaveBeenNthCalledWith(2, expect.anything(), 'company-1', 'user-1', 'entry-new')

    // Durable audit carries both ids for manual recovery.
    const audit = auditLines(errorSpy)
    expect(audit).toContain('entry-new')
    expect(audit).toContain('entry-old')
  })

  // FIX 1 + FIX 2: relink RPC error triggers compensation and a durable audit.
  it('compensates and emits a durable audit when the relink RPC returns an error', async () => {
    enqueue({ data: openPeriodWithOB() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // company lock-date pre-flight
    enqueue({ count: 0 }) // year-end check
    enqueue({ error: { message: 'relink boom' } }) // RPC failure

    mockCreateJournalEntry.mockResolvedValue({ id: 'entry-new', voucher_series: 'A', voucher_number: 9 })
    mockReverseEntry.mockResolvedValue({ id: 'entry-storno' }) // step B + compensation both succeed

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(500)
    const err = body.error as unknown as { code: string; details?: { newEntryId?: string; oldEntryId?: string } }
    expect(err.code).toBe('OB_CORRECT_FAILED')
    expect(err.details?.newEntryId).toBe('entry-new')
    expect(err.details?.oldEntryId).toBe('entry-old')

    // Compensation: old entry stornoed (step B) then the new entry stornoed.
    expect(mockReverseEntry).toHaveBeenCalledTimes(2)
    expect(mockReverseEntry).toHaveBeenNthCalledWith(1, expect.anything(), 'company-1', 'user-1', 'entry-old')
    expect(mockReverseEntry).toHaveBeenNthCalledWith(2, expect.anything(), 'company-1', 'user-1', 'entry-new')

    // Durable audit event payload contains newEntryId + oldEntryId.
    const audit = auditLines(errorSpy)
    expect(audit).toContain('opening_balance.correction_failed')
    expect(audit).toContain('entry-new')
    expect(audit).toContain('entry-old')
  })

  // FIX 2: the compensating storno may itself fail; the handler must still
  // return the envelope and audit the compensation failure (never rethrow).
  it('audits a compensation failure and still returns OB_CORRECT_FAILED', async () => {
    enqueue({ data: openPeriodWithOB() }) // period
    enqueue({ data: { bookkeeping_locked_through: null } }) // company lock-date pre-flight
    enqueue({ count: 0 }) // year-end check
    enqueue({ error: { message: 'relink boom' } }) // RPC failure

    mockCreateJournalEntry.mockResolvedValue({ id: 'entry-new', voucher_series: 'A', voucher_number: 9 })
    mockReverseEntry
      .mockResolvedValueOnce({ id: 'entry-storno' }) // step B ok
      .mockRejectedValueOnce(new Error('compensation storno failed')) // compensation throws

    const res = await POST(makeRequest({ fiscal_period_id: PERIOD_ID, lines: BALANCED_LINES }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('OB_CORRECT_FAILED')

    const audit = auditLines(errorSpy)
    expect(audit).toContain('compensation_failed')
    expect(audit).toContain('entry-new')
    expect(audit).toContain('entry-old')
  })
})
