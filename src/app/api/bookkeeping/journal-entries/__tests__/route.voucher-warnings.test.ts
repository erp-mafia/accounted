import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase, makeJournalEntry } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
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

vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: (): unknown => logger }
  return { createLogger: () => logger }
})

const mockCreateJournalEntry = vi.fn()
const mockCreateDraftEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  createDraftEntry: (...args: unknown[]) => mockCreateDraftEntry(...args),
}))

const mockAppendProcessingHistory = vi.fn().mockResolvedValue('event-1')
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

const VALID_UUID = '11111111-1111-4111-8111-111111111111'

/** A receipt whose discount total was typed as VAT (2026-10-26 sweep). */
const DISCOUNT_AS_VAT = {
  fiscal_period_id: VALID_UUID,
  entry_date: '2026-07-05',
  description: 'Dryck till kontoret',
  lines: [
    { account_number: '5460', debit_amount: 195.7, credit_amount: 0 },
    { account_number: '2641', debit_amount: 135.3, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 331 },
  ],
}

describe('POST /api/bookkeeping/journal-entries: booking-time voucher warnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  })

  it('refuses with VOUCHER_NEEDS_CONFIRMATION and the warnings before anything is posted', async () => {
    const response = await POST(createMockRequest('/api/bookkeeping/journal-entries', { method: 'POST', body: DISCOUNT_AS_VAT }), emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { warnings: Array<{ code: string }> } } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('VOUCHER_NEEDS_CONFIRMATION')
    expect(body.error.details.warnings.map((w) => w.code)).toEqual(['INPUT_VAT_ABOVE_RATE'])
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('posts once the person confirmed the warnings, and records that they did', async () => {
    const entry = makeJournalEntry({ id: 'je-1' })
    mockCreateJournalEntry.mockResolvedValue(entry)

    const response = await POST(
      createMockRequest('/api/bookkeeping/journal-entries', {
        method: 'POST',
        body: { ...DISCOUNT_AS_VAT, acknowledged_warnings: ['INPUT_VAT_ABOVE_RATE'] },
      }), emptyParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    // The engine never sees the acknowledgement.
    expect(mockCreateJournalEntry.mock.calls[0][3]).not.toHaveProperty('acknowledged_warnings')
    expect(mockAppendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'VoucherWarningsAcknowledged',
        aggregateId: 'je-1',
        payload: expect.objectContaining({ codes: ['INPUT_VAT_ABOVE_RATE'], door: 'dashboard_voucher' }),
      }),
    )
  })

  it('refuses a confirmation that does not cover every warning', async () => {
    const response = await POST(
      createMockRequest('/api/bookkeeping/journal-entries', {
        method: 'POST',
        body: { ...DISCOUNT_AS_VAT, acknowledged_warnings: ['REVERSE_CHARGE_ONE_SIDED'] },
      }), emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('VOUCHER_NEEDS_CONFIRMATION')
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects an unknown warning code with 400', async () => {
    const response = await POST(
      createMockRequest('/api/bookkeeping/journal-entries', {
        method: 'POST',
        body: { ...DISCOUNT_AS_VAT, acknowledged_warnings: ['ANYTHING'] },
      }), emptyParams)
    expect((await parseJsonResponse(response)).status).toBe(400)
  })

  it('saves a draft without asking: the commit asks', async () => {
    mockCreateDraftEntry.mockResolvedValue(makeJournalEntry({ id: 'draft-1', status: 'draft' }))

    const response = await POST(
      createMockRequest('/api/bookkeeping/journal-entries?as_draft=true', { method: 'POST', body: DISCOUNT_AS_VAT }), emptyParams)

    expect((await parseJsonResponse(response)).status).toBe(200)
    expect(mockCreateDraftEntry).toHaveBeenCalledTimes(1)
  })

  it('posts an ordinary purchase without a question', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-2' }))

    const response = await POST(
      createMockRequest('/api/bookkeeping/journal-entries', {
        method: 'POST',
        body: {
          ...DISCOUNT_AS_VAT,
          lines: [
            { account_number: '5460', debit_amount: 264.8, credit_amount: 0 },
            { account_number: '2641', debit_amount: 66.2, credit_amount: 0 },
            { account_number: '1930', debit_amount: 0, credit_amount: 331 },
          ],
        },
      }), emptyParams)

    expect((await parseJsonResponse(response)).status).toBe(200)
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })
})
