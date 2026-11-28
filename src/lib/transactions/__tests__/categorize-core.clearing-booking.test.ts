/**
 * categorizeTransaction with a clearing proposal's record (clearing_ref): the
 * proposer states every line beside the bank leg (a payout: the provider's
 * fees and the clearing account gross), the record is claimed for the row
 * before the verifikat is written, let go when no verifikat stands, and
 * settled on the verifikat afterwards. A clearing booking teaches nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { mockCreateJE, mockReverseOrphanedJE, mockUpsertTemplate, mockSaveRule, booking, mockUpload } = vi.hoisted(() => ({
  mockUpload: vi.fn(),
  mockCreateJE: vi.fn(),
  mockReverseOrphanedJE: vi.fn(),
  mockUpsertTemplate: vi.fn(),
  mockSaveRule: vi.fn(),
  booking: { lines: vi.fn(), claim: vi.fn(), release: vi.fn(), settle: vi.fn() },
}))

vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: (...args: unknown[]) => mockUpload(...args) }))
vi.mock('@/lib/composition/clearing-proposals', () => ({
  CLEARING_PROPOSERS: [{ id: 'test-payouts', module: 'webshop', propose: vi.fn(), booking }],
}))
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/bookkeeping/transaction-entries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/transaction-entries')>()),
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJE(...args),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: (...args: unknown[]) => mockReverseOrphanedJE(...args),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  upsertCounterpartyTemplate: (...args: unknown[]) => mockUpsertTemplate(...args),
}))
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: vi.fn().mockResolvedValue(false),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/bookkeeping/mapping-engine', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/mapping-engine')>()),
  saveUserMappingRule: (...args: unknown[]) => mockSaveRule(...args),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))

import { categorizeTransaction } from '../categorize-core'

const TX_ID = '00000000-0000-4000-8000-0000000000dd'
const PAYOUT_ID = '00000000-0000-4000-8000-0000000000ee'

const txRow = (over: Record<string, unknown> = {}) => ({
  id: TX_ID,
  company_id: 'company-1',
  date: '2026-11-20',
  amount: 934.37,
  currency: 'SEK',
  amount_sek: 934.37,
  exchange_rate: 1,
  description: 'KUSTOM AB',
  merchant_name: 'KUSTOM AB',
  cash_account_id: null,
  document_id: null,
  journal_entry_id: null,
  ...over,
})

const settingsRow = { entity_type: 'aktiebolag', fiscal_year_start_month: 1, vat_registered: true }

/** The payout's lines beside the bank leg: fees, their VAT, the clearing account gross. */
const PAYOUT_LINES = [
  { account_number: '6570', debit_amount: 12.5, credit_amount: 0, description: 'Avgifter Kustom' },
  { account_number: '2641', debit_amount: 3.13, credit_amount: 0, description: 'Moms på avgifter Kustom' },
  { account_number: '1686', debit_amount: 0, credit_amount: 950, description: 'Utbetalning Kustom PAY123 2026-11-19' },
]

const input = { is_business: true, category: 'income_other' as const, clearing_ref: { proposer: 'test-payouts', ref: PAYOUT_ID } }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  booking.lines.mockResolvedValue({ ok: true, lines: PAYOUT_LINES, description: 'Utbetalning Kustom PAY123 2026-11-19' })
  booking.claim.mockResolvedValue(true)
  booking.release.mockResolvedValue(undefined)
  booking.settle.mockResolvedValue(null)
  mockUpload.mockResolvedValue({ id: 'doc-1' })
  mockCreateJE.mockResolvedValue({ id: 'je-payout-1' })
})

/** The reads before the mapping: the row, the junction gate, the company's settings. */
function enqueueRow(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: txRow() })
  enqueue({ data: [] }) // the gate: no posted verifikat booked from the row
  enqueue({ data: settingsRow })
  enqueue({ data: [] }) // resolveSettlementAccount: no enabled cash accounts -> 1930
}

describe('categorizeTransaction with a clearing record', () => {
  it('previews the bank net beside the record\'s lines, and claims nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueRow(enqueue)
    const outcome = await categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, input, {
      onBooked: 'update_flags',
      dryRun: true,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1930', 934.37, 0],
      ['6570', 12.5, 0],
      ['2641', 3.13, 0],
      ['1686', 0, 950],
    ])
    expect(booking.lines).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      { id: TX_ID, date: '2026-11-20', amount: 934.37, currency: 'SEK' },
      PAYOUT_ID,
      { vatRegistered: true },
    )
    expect(booking.claim).not.toHaveBeenCalled()
  })

  it('claims the record, books, settles it on the verifikat and learns nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueRow(enqueue)
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: [txRow({ journal_entry_id: 'je-payout-1', category: 'income_other', is_business: true })] }) // the link
    const outcome = await categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, input, { onBooked: 'refuse' })
    expect(outcome).toMatchObject({ ok: true, dryRun: false, booked: { journal_entry_id: 'je-payout-1' } })
    expect(booking.claim).toHaveBeenCalledWith(expect.anything(), 'company-1', PAYOUT_ID, TX_ID)
    expect(booking.claim.mock.invocationCallOrder[0]).toBeLessThan(mockCreateJE.mock.invocationCallOrder[0])
    expect(booking.settle).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', PAYOUT_ID, TX_ID, 'je-payout-1')
    expect(booking.release).not.toHaveBeenCalled()
    expect(mockUpload).not.toHaveBeenCalled()
    // The verifikat books the record's lines beside the bank leg.
    const mapping = mockCreateJE.mock.calls[0][4] as { vat_lines: unknown[]; all_lines_complete: boolean }
    expect(mapping.all_lines_complete).toBe(true)
    expect(mapping.vat_lines).toEqual(PAYOUT_LINES)
    expect(mockSaveRule).not.toHaveBeenCalled()
    expect(mockUpsertTemplate).not.toHaveBeenCalled()
  })

  it('files the underlag the settle hands back on the verifikat, once per record', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueRow(enqueue)
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: [txRow({ journal_entry_id: 'je-payout-1', category: 'income_other', is_business: true })] }) // the link
    booking.settle.mockResolvedValueOnce({ name: 'Utbetalning.pdf', bytes: new Uint8Array([37, 80, 68, 70]), type: 'application/pdf', idempotencyKey: `test:${PAYOUT_ID}` })
    const outcome = await categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, input, { onBooked: 'refuse' })
    expect(outcome).toMatchObject({ ok: true, booked: { journal_entry_id: 'je-payout-1' } })
    expect(mockUpload).toHaveBeenCalledTimes(1)
    const [, userId, companyId, file, meta] = mockUpload.mock.calls[0] as [unknown, string, string, { name: string; type: string }, Record<string, unknown>]
    expect([userId, companyId, file.name, file.type]).toEqual(['user-1', 'company-1', 'Utbetalning.pdf', 'application/pdf'])
    expect(meta).toMatchObject({ upload_source: 'system', journal_entry_id: 'je-payout-1', idempotency_key: `test:${PAYOUT_ID}`, extractionOwner: 'none' })
  })

  it('keeps the verifikat when the underlag cannot be filed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueRow(enqueue)
    enqueue({ data: [{ id: 'fp-1' }] }) // ensureFiscalPeriod
    enqueue({ data: [txRow({ journal_entry_id: 'je-payout-1', category: 'income_other', is_business: true })] }) // the link
    booking.settle.mockResolvedValueOnce({ name: 'Utbetalning.pdf', bytes: new Uint8Array([1]), type: 'application/pdf', idempotencyKey: 'k' })
    mockUpload.mockRejectedValueOnce(new Error('storage down'))
    const outcome = await categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, input, { onBooked: 'refuse' })
    expect(outcome).toMatchObject({ ok: true, booked: { journal_entry_id: 'je-payout-1' } })
  })

  it('refuses when another booking holds the record, before anything is written', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueRow(enqueue)
    enqueue({ data: [{ id: 'fp-1' }] })
    booking.claim.mockResolvedValue(false)
    const outcome = await categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, input, { onBooked: 'refuse' })
    expect(outcome).toMatchObject({ ok: false, code: 'CLEARING_RECORD_TAKEN' })
    expect(mockCreateJE).not.toHaveBeenCalled()
    expect(booking.settle).not.toHaveBeenCalled()
  })

  it('lets go of the claim when no verifikat is written', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueRow(enqueue)
    enqueue({ data: [{ id: 'fp-1' }] })
    mockCreateJE.mockRejectedValue(new Error('engine down'))
    const outcome = await categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, input, { onBooked: 'refuse' })
    expect(outcome).toMatchObject({ ok: false, code: 'TX_CATEGORIZE_JOURNAL_ENTRY_FAILED' })
    expect(booking.release).toHaveBeenCalledWith(expect.anything(), 'company-1', PAYOUT_ID, TX_ID)
    expect(booking.settle).not.toHaveBeenCalled()
  })

  it('answers the record\'s refusal and books nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueRow(enqueue)
    booking.lines.mockResolvedValue({ ok: false, code: 'WEBSHOP_PAYOUT_ROW_MISMATCH', details: { payout_amount: 900 } })
    const outcome = await categorizeTransaction(supabase as never, 'user-1', 'company-1', TX_ID, input, { onBooked: 'refuse' })
    expect(outcome).toMatchObject({ ok: false, code: 'WEBSHOP_PAYOUT_ROW_MISMATCH', details: { payout_amount: 900 } })
    expect(booking.claim).not.toHaveBeenCalled()
    expect(mockCreateJE).not.toHaveBeenCalled()
  })

  it('refuses a record no proposer books, and money out', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueRow(enqueue)
    const unknown = await categorizeTransaction(
      supabase as never,
      'user-1',
      'company-1',
      TX_ID,
      { ...input, clearing_ref: { proposer: 'nobody', ref: PAYOUT_ID } },
      { onBooked: 'refuse' },
    )
    expect(unknown).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })

    const second = createQueuedMockSupabase()
    second.enqueue({ data: txRow({ amount: -934.37, amount_sek: -934.37 }) })
    second.enqueue({ data: [] })
    second.enqueue({ data: settingsRow })
    const out = await categorizeTransaction(second.supabase as never, 'user-1', 'company-1', TX_ID, input, { onBooked: 'refuse' })
    expect(out).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(booking.lines).not.toHaveBeenCalled()
  })
})
