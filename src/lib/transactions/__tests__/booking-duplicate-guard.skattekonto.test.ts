import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDetectBank = vi.fn()
const mockDetectTax = vi.fn()
const mockPlausible = vi.fn()
const mockAppend = vi.fn()

vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...args: unknown[]) => mockDetectBank(...args),
}))
vi.mock('@/lib/transactions/skattekonto-tax-double', () => ({
  detectSkattekontoTaxDouble: (...args: unknown[]) => mockDetectTax(...args),
  isSkattekontoTaxCandidateFor: (...args: unknown[]) => mockPlausible(...args),
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppend(...args),
}))

import { runBookingDuplicateGuard, runSkattekontoTaxGuard } from '../booking-duplicate-guard'

/**
 * Issue #50: the skattekonto half of the booking guard runs once the
 * categorize door knows its kontering. It shares the bank-line halves' code
 * and override, so a force reviewed on its candidate passes the first call
 * (deferred) and is bound by the second.
 */

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() } as never
const supabase = {} as never
const target = { id: 'tx-1', date: '2026-07-10', amount: -12225, currency: 'SEK' }
const taxCandidate = {
  transaction_id: null,
  journal_entry_id: 'je-moms',
  voucher_label: 'A12',
  entry_date: '2026-07-12',
  description: null,
  amount: 12225,
  account_number: null,
  currency: null,
  amount_in_currency: null,
  amount_verified: true,
  unverified_reason: null,
  skattekonto: { tax_account: '2650', skattekonto_account: '1630' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDetectBank.mockResolvedValue(null)
  mockDetectTax.mockResolvedValue(null)
  mockPlausible.mockResolvedValue(false)
  mockAppend.mockResolvedValue(undefined)
})

describe('runBookingDuplicateGuard: a force on the skattekonto candidate', () => {
  it('is deferred when no bank-line candidate exists and the verifikat can be one', async () => {
    mockPlausible.mockResolvedValue(true)
    const result = await runBookingDuplicateGuard(
      supabase, 'c1', 'u1', target,
      { force: true, expected_duplicate_journal_entry_id: 'je-moms' },
      log,
      { deferForceToSkattekonto: true },
    )
    expect(result).toEqual({ ok: true, verdict: { kind: 'clear' }, deferredForce: 'je-moms' })
    expect(mockPlausible).toHaveBeenCalledWith(supabase, 'c1', '2026-07-10', 'je-moms')
    expect(mockAppend).not.toHaveBeenCalled()
  })

  it('is still refused when the verifikat cannot be a skattekonto candidate (a guessed id)', async () => {
    const result = await runBookingDuplicateGuard(
      supabase, 'c1', 'u1', target,
      { force: true, expected_duplicate_journal_entry_id: 'je-guess' },
      log,
      { deferForceToSkattekonto: true },
    )
    expect(result).toMatchObject({ ok: false, code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH' })
  })

  it('never defers without the option, or when a bank-line candidate exists', async () => {
    mockPlausible.mockResolvedValue(true)
    const without = await runBookingDuplicateGuard(
      supabase, 'c1', 'u1', target, { force: true, expected_duplicate_journal_entry_id: 'je-moms' }, log,
    )
    expect(without).toMatchObject({ ok: false, code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH' })
    expect(mockPlausible).not.toHaveBeenCalled()

    mockDetectBank.mockResolvedValue({ ...taxCandidate, skattekonto: undefined, journal_entry_id: 'je-twin', transaction_id: 'tx-twin' })
    const twin = await runBookingDuplicateGuard(
      supabase, 'c1', 'u1', target, { force: true, expected_duplicate_journal_entry_id: 'je-moms' }, log,
      { deferForceToSkattekonto: true },
    )
    expect(twin).toMatchObject({ ok: false, code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH' })
  })
})

describe('runSkattekontoTaxGuard', () => {
  it('refuses a candidate with the shared duplicate code', async () => {
    mockDetectTax.mockResolvedValue(taxCandidate)
    const result = await runSkattekontoTaxGuard(supabase, 'c1', 'u1', target, {}, log)
    expect(result).toEqual({ ok: false, code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE', details: { candidate: taxCandidate } })
  })

  it('lets the booking through with no verdict when nothing is found', async () => {
    expect(await runSkattekontoTaxGuard(supabase, 'c1', 'u1', target, {}, log)).toEqual({ ok: true, verdict: null })
  })

  it('binds a deferred force to exactly the re-detected verifikat and records the dismissal', async () => {
    mockDetectTax.mockResolvedValue(taxCandidate)
    const result = await runSkattekontoTaxGuard(supabase, 'c1', 'u1', target, {}, log, { deferredForce: 'je-moms', via: 'api_force' })
    expect(result).toEqual({ ok: true, verdict: { kind: 'forced', journal_entry_id: 'je-moms', transaction_id: null } })
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BankTransactionDuplicateDismissed',
        payload: expect.objectContaining({ dismissed_journal_entry_id: 'je-moms', amount_ore: 1222500, via: 'api_force' }),
      }),
    )
  })

  it('refuses a deferred force the half no longer detects', async () => {
    const gone = await runSkattekontoTaxGuard(supabase, 'c1', 'u1', target, {}, log, { deferredForce: 'je-moms' })
    expect(gone).toMatchObject({
      ok: false,
      code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH',
      details: { expected_duplicate_journal_entry_id: 'je-moms', detected_journal_entry_id: null },
    })
    mockDetectTax.mockResolvedValue({ ...taxCandidate, journal_entry_id: 'je-other' })
    const other = await runSkattekontoTaxGuard(supabase, 'c1', 'u1', target, {}, log, { deferredForce: 'je-moms' })
    expect(other).toMatchObject({ ok: false, code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH' })
    expect(mockAppend).not.toHaveBeenCalled()
  })

  it('books over a candidate on allow_duplicate, with the dismissal record on a live call only', async () => {
    mockDetectTax.mockResolvedValue(taxCandidate)
    const live = await runSkattekontoTaxGuard(supabase, 'c1', 'u1', target, { allow_duplicate: true }, log)
    expect(live).toEqual({ ok: true, verdict: { kind: 'allowed', journal_entry_id: 'je-moms', transaction_id: null } })
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ via: 'allow_duplicate', dismissed_journal_entry_id: 'je-moms' }) }),
    )

    mockAppend.mockClear()
    const dry = await runSkattekontoTaxGuard(supabase, 'c1', 'u1', target, { allow_duplicate: true }, log, { recordDismissal: false })
    expect(dry).toEqual({ ok: true, verdict: null })
    expect(mockAppend).not.toHaveBeenCalled()
  })
})
