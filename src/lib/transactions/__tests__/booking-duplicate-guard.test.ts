/**
 * Unit tests for runBookingDuplicateGuard: the booking-time duplicate guard
 * plus bound force override shared by the dashboard categorize route and the
 * v1 :categorize / batch-categorize routes. The detector is stubbed (its
 * queries are covered in booking-duplicate-detection.test.ts); this pins the
 * verdicts, the force binding, and the behandlingshistorik record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'

const { detectDupMock, appendHistoryMock } = vi.hoisted(() => ({
  detectDupMock: vi.fn(),
  appendHistoryMock: vi.fn(),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: detectDupMock,
}))
vi.mock('@/lib/processing-history/append', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/processing-history/append')>()),
  appendProcessingHistory: appendHistoryMock,
}))

import { runBookingDuplicateGuard } from '../booking-duplicate-guard'

const supabase = {} as SupabaseClient
const log: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
}

const TX_ID = 'tx-target'
const SIBLING_TX = '11111111-1111-4111-8111-111111111111'
const SIBLING_JE = '22222222-2222-4222-8222-222222222222'
const target = {
  id: TX_ID,
  date: '2026-05-12',
  amount: -349.5,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  cash_account_id: 'ca-1',
}
const candidate = {
  transaction_id: SIBLING_TX,
  journal_entry_id: SIBLING_JE,
  voucher_label: 'A12',
  entry_date: '2026-05-12',
  description: 'ICA',
  amount: -349.5,
  account_number: null,
  currency: null,
  amount_in_currency: null,
  amount_verified: true,
  unverified_reason: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  detectDupMock.mockReset().mockResolvedValue(null)
  appendHistoryMock.mockReset().mockResolvedValue('evt-1')
})

describe('runBookingDuplicateGuard', () => {
  it('passes when nothing in the ledger books this bank line', async () => {
    const verdict = await runBookingDuplicateGuard(supabase, 'company-1', 'user-1', target, {}, log)

    expect(verdict).toEqual({ ok: true })
    expect(detectDupMock).toHaveBeenCalledWith(supabase, 'company-1', target, undefined)
  })

  it('refuses with TRANSACTION_BOOK_POSSIBLE_DUPLICATE and the candidate when no force is given', async () => {
    detectDupMock.mockResolvedValue(candidate)

    const verdict = await runBookingDuplicateGuard(supabase, 'company-1', 'user-1', target, {}, log)

    expect(verdict).toEqual({
      ok: false,
      code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE',
      details: { candidate },
    })
    expect(appendHistoryMock).not.toHaveBeenCalled()
  })

  it('passes the same-batch exclusions through to the detector', async () => {
    const exclude = { excludeTransactionIds: ['tx-a'], excludeJournalEntryIds: ['je-a'] }

    await runBookingDuplicateGuard(supabase, 'company-1', 'user-1', target, {}, log, { exclude })

    expect(detectDupMock).toHaveBeenCalledWith(supabase, 'company-1', target, exclude)
  })

  it.each([
    ['journal entry id', { expected_duplicate_journal_entry_id: SIBLING_JE }],
    ['transaction id', { expected_duplicate_transaction_id: SIBLING_TX }],
  ])('honours force=true bound by the %s and records the dismissal', async (_label, binding) => {
    detectDupMock.mockResolvedValue(candidate)

    const verdict = await runBookingDuplicateGuard(
      supabase,
      'company-1',
      'user-1',
      target,
      { force: true, ...binding },
      log,
      { via: 'api_force' },
    )

    expect(verdict).toEqual({ ok: true })
    expect(appendHistoryMock).toHaveBeenCalledTimes(1)
    expect(appendHistoryMock).toHaveBeenCalledWith({
      companyId: 'company-1',
      correlationId: TX_ID,
      aggregateType: 'BankTransaction',
      aggregateId: TX_ID,
      eventType: 'BankTransactionDuplicateDismissed',
      payload: {
        transaction_id: TX_ID,
        dismissed_transaction_id: SIBLING_TX,
        dismissed_journal_entry_id: SIBLING_JE,
        amount_ore: -34950,
        dismissed_currency: null,
        dismissed_amount_in_currency: null,
        entry_date: '2026-05-12',
        amount_verified: true,
        unverified_reason: null,
        via: 'api_force',
      },
      actor: { type: 'user', id: 'user-1' },
      occurredAt: expect.any(Date),
    })
  })

  it('omits via from the record when the door names none (dashboard payload unchanged)', async () => {
    detectDupMock.mockResolvedValue(candidate)

    await runBookingDuplicateGuard(
      supabase,
      'company-1',
      'user-1',
      target,
      { force: true, expected_duplicate_journal_entry_id: SIBLING_JE },
      log,
    )

    const payload = appendHistoryMock.mock.calls[0][0].payload as Record<string, unknown>
    expect(payload).not.toHaveProperty('via')
  })

  it('verifies the binding but writes no record when recordDismissal is false (dry-run)', async () => {
    detectDupMock.mockResolvedValue(candidate)

    const verdict = await runBookingDuplicateGuard(
      supabase,
      'company-1',
      'user-1',
      target,
      { force: true, expected_duplicate_journal_entry_id: SIBLING_JE },
      log,
      { recordDismissal: false },
    )

    expect(verdict).toEqual({ ok: true })
    expect(appendHistoryMock).not.toHaveBeenCalled()
  })

  it('refuses a force bound to an id that no longer matches the detected candidate', async () => {
    detectDupMock.mockResolvedValue(candidate)

    const verdict = await runBookingDuplicateGuard(
      supabase,
      'company-1',
      'user-1',
      target,
      { force: true, expected_duplicate_journal_entry_id: '33333333-3333-4333-8333-333333333333' },
      log,
    )

    expect(verdict).toEqual({
      ok: false,
      code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH',
      details: {
        expected_duplicate_transaction_id: null,
        expected_duplicate_journal_entry_id: '33333333-3333-4333-8333-333333333333',
        detected_transaction_id: SIBLING_TX,
        detected_journal_entry_id: SIBLING_JE,
      },
    })
    expect(appendHistoryMock).not.toHaveBeenCalled()
  })

  it('refuses a force when the candidate is gone at request time', async () => {
    const verdict = await runBookingDuplicateGuard(
      supabase,
      'company-1',
      'user-1',
      target,
      { force: true, expected_duplicate_journal_entry_id: SIBLING_JE },
      log,
    )

    expect(verdict).toMatchObject({ ok: false, code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH' })
  })

  it('fails open on a detection error without force', async () => {
    detectDupMock.mockRejectedValue(new Error('statement timeout'))

    const verdict = await runBookingDuplicateGuard(supabase, 'company-1', 'user-1', target, {}, log)

    expect(verdict).toEqual({ ok: true })
    expect(log.warn).toHaveBeenCalledWith('booking-time duplicate detection failed (continuing)', expect.any(Error))
  })

  it('fails closed on a detection error with force (the bypass cannot be re-verified)', async () => {
    detectDupMock.mockRejectedValue(new Error('statement timeout'))

    const verdict = await runBookingDuplicateGuard(
      supabase,
      'company-1',
      'user-1',
      target,
      { force: true, expected_duplicate_journal_entry_id: SIBLING_JE },
      log,
    )

    expect(verdict).toEqual({
      ok: false,
      code: 'TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH',
      details: { detection_failed: true },
    })
  })

  it('still honours the force when the behandlingshistorik write fails (best-effort)', async () => {
    detectDupMock.mockResolvedValue(candidate)
    appendHistoryMock.mockRejectedValue(new Error('service role down'))

    const verdict = await runBookingDuplicateGuard(
      supabase,
      'company-1',
      'user-1',
      target,
      { force: true, expected_duplicate_journal_entry_id: SIBLING_JE },
      log,
    )

    expect(verdict).toEqual({ ok: true })
    expect(log.error).toHaveBeenCalled()
  })
})
