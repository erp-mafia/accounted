/**
 * The voucher form's door hands a posted typed verifikat to the bank matcher
 * (lib/reconciliation/voucher-bank-link.ts, tested there), so the open bank
 * row it books is linked instead of staying under Att bokföra (crm#1958).
 * Here only when the door asks, and with what.
 */
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

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

const mockLink = vi.fn()
vi.mock('@/lib/reconciliation/voucher-bank-link', () => ({
  linkOpenBankRowsToVoucher: (...args: unknown[]) => mockLink(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

const VALID_UUID = '11111111-1111-4111-8111-111111111111'

/** A bank payment of a card debt, typed by hand after its bank booking was reversed. */
const BANK_PAYMENT = {
  fiscal_period_id: VALID_UUID,
  entry_date: '2026-09-01',
  description: 'Bank till kortskuld',
  lines: [
    { account_number: '1930', debit_amount: 0, credit_amount: 61.25 },
    { account_number: '2890', debit_amount: 61.25, credit_amount: 0 },
  ],
}

describe('POST /api/bookkeeping/journal-entries: a posted typed verifikat meets its open bank row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
    mockLink.mockResolvedValue({ linked: 1, suggested: 0 })
  })

  it('hands the posted verifikat, its date and its lines to the bank matcher (crm#1958)', async () => {
    mockCreateJournalEntry.mockResolvedValue(makeJournalEntry({ id: 'je-48' }))

    const response = await POST(createMockRequest('/api/bookkeeping/journal-entries', { method: 'POST', body: BANK_PAYMENT }), emptyParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockLink).toHaveBeenCalledTimes(1)
    const [, companyId, userId, voucher] = mockLink.mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect(voucher).toMatchObject({ journalEntryId: 'je-48', entryDate: '2026-09-01' })
    expect((voucher as { lines: Array<{ account_number: string }> }).lines.map((l) => l.account_number)).toEqual(['1930', '2890'])
  })

  it('leaves a draft alone: it meets its row when it is committed', async () => {
    mockCreateDraftEntry.mockResolvedValue(makeJournalEntry({ id: 'je-draft', status: 'draft' }))

    const response = await POST(
      createMockRequest('/api/bookkeeping/journal-entries?as_draft=true', { method: 'POST', body: BANK_PAYMENT }),
      emptyParams,
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockCreateDraftEntry).toHaveBeenCalledTimes(1)
    expect(mockLink).not.toHaveBeenCalled()
  })

  it('asks nothing of the matcher when the verifikat was not posted', async () => {
    mockCreateJournalEntry.mockRejectedValue(new Error('period locked'))

    const response = await POST(createMockRequest('/api/bookkeeping/journal-entries', { method: 'POST', body: BANK_PAYMENT }), emptyParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockLink).not.toHaveBeenCalled()
  })
})
