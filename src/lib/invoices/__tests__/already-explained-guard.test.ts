/**
 * The already-explained guards (lib/invoices/already-explained-guard.ts):
 * one decision on top of the detectors, shared by the dashboard route, the
 * MCP staging tools and the pending-operation commit (issue #2294). The
 * detectors themselves are pinned by duplicate-payment-detection.test.ts;
 * these tests cover the binding rules, the fail-open contract and the
 * behandlingshistorik record an honoured override leaves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockDetectSet, mockDetectCandidate, mockAppend } = vi.hoisted(() => ({
  mockDetectSet: vi.fn(),
  mockDetectCandidate: vi.fn(),
  mockAppend: vi.fn(),
}))
vi.mock('../duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: mockDetectSet,
  detectDuplicatePaymentVoucher: mockDetectCandidate,
}))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: mockAppend,
}))

import {
  alreadyExplainedDetails,
  bindDuplicateCandidateOverride,
  bindExplainedOverride,
  describeExplainingSet,
  guardAlreadyExplained,
  guardDuplicatePaymentVoucher,
  recordDuplicateCandidateOverride,
  recordExplainedOverride,
} from '../already-explained-guard'

const JE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const JE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const JE_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const TX_ID = '11111111-1111-4111-8111-111111111111'

const set = {
  vouchers: [
    { journal_entry_id: JE_A, voucher_label: 'A57', voucher_series: 'A', voucher_number: 57, entry_date: '2026-07-31', description: 'Inbetalning kundfaktura 063', source_type: 'invoice_paid', amount: 62500, bank_account_number: '1930' },
    { journal_entry_id: JE_B, voucher_label: 'A58', voucher_series: 'A', voucher_number: 58, entry_date: '2026-07-31', description: 'Inbetalning kundfaktura 064', source_type: 'invoice_paid', amount: 25750, bank_account_number: '1930' },
  ],
  total: 88250,
  bank_account_number: '1930',
  same_date: true,
}

const candidate = {
  journal_entry_id: JE_A,
  voucher_label: 'A12',
  entry_date: '2026-05-15',
  description: 'Inbetalning faktura',
  amount: 1000,
  bank_account_number: '1930',
  reason: 'exact_amount_same_date' as const,
  amount_verified: true,
  unverified_reason: null,
}

const supabase = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  mockAppend.mockResolvedValue('evt-1')
})

describe('bindExplainedOverride (1:N set)', () => {
  it('is clear when nothing explains the row, whatever the override says', () => {
    expect(bindExplainedOverride(null, {})).toEqual({ status: 'clear' })
    expect(bindExplainedOverride(null, { force: true, expected_journal_entry_ids: [JE_A] })).toEqual({ status: 'clear' })
  })

  it('blocks a set without force, and says force was not attempted', () => {
    expect(bindExplainedOverride(set, {})).toEqual({ status: 'blocked', set, force_rejected: false })
    // force without ids is no binding at all.
    expect(bindExplainedOverride(set, { force: true })).toEqual({ status: 'blocked', set, force_rejected: true })
  })

  it('honours force only for exactly the detected ids, in any order', () => {
    expect(bindExplainedOverride(set, { force: true, expected_journal_entry_ids: [JE_B, JE_A] })).toEqual({
      status: 'overridden',
      set,
    })
  })

  it('refuses a subset, a superset and a swapped id: a stale review cannot wave the guard away', () => {
    for (const ids of [[JE_A], [JE_A, JE_B, JE_C], [JE_A, JE_C]]) {
      expect(bindExplainedOverride(set, { force: true, expected_journal_entry_ids: ids })).toEqual({
        status: 'blocked',
        set,
        force_rejected: true,
      })
    }
  })

  it('never honours the ids without force', () => {
    expect(bindExplainedOverride(set, { expected_journal_entry_ids: [JE_A, JE_B] })).toMatchObject({
      status: 'blocked',
      force_rejected: false,
    })
  })

  it('hands every door the same details block', () => {
    const outcome = bindExplainedOverride(set, { force: true, expected_journal_entry_ids: [JE_A] })
    expect(outcome.status).toBe('blocked')
    expect(alreadyExplainedDetails(outcome as Extract<typeof outcome, { status: 'blocked' }>)).toEqual({
      vouchers: set.vouchers,
      total: 88250,
      bank_account_number: '1930',
      same_date: true,
      force_rejected: true,
    })
  })
})

describe('describeExplainingSet', () => {
  it('names the vouchers, the account, the date and the SEK total', () => {
    // sv-SE thousands separator is a (narrow) no-break space: match any space.
    expect(describeExplainingSet(set)).toMatch(/^A57 \+ A58 \(1930, 2026-07-31, 88\s250,00 kr\)$/)
  })

  it('spells out a date range when the vouchers are spread', () => {
    const spread = {
      ...set,
      same_date: false,
      vouchers: [set.vouchers[0], { ...set.vouchers[1], entry_date: '2026-08-02' }],
    }
    expect(describeExplainingSet(spread)).toContain('2026-07-31 till 2026-08-02')
  })
})

describe('guardAlreadyExplained', () => {
  it('passes the transaction (id or row) straight to the one detector', async () => {
    mockDetectSet.mockResolvedValue(null)
    const row = { id: TX_ID, date: '2026-07-31', amount: 88250, currency: 'SEK', cash_account_id: 'ca-1' }
    await guardAlreadyExplained(supabase, 'company-1', row, {})
    expect(mockDetectSet).toHaveBeenCalledWith(supabase, 'company-1', row)
    await guardAlreadyExplained(supabase, 'company-1', TX_ID, {})
    expect(mockDetectSet).toHaveBeenLastCalledWith(supabase, 'company-1', TX_ID)
  })

  it('binds the override to the detected set', async () => {
    mockDetectSet.mockResolvedValue(set)
    await expect(guardAlreadyExplained(supabase, 'company-1', TX_ID, {})).resolves.toMatchObject({ status: 'blocked' })
    await expect(
      guardAlreadyExplained(supabase, 'company-1', TX_ID, { force: true, expected_journal_entry_ids: [JE_A, JE_B] }),
    ).resolves.toMatchObject({ status: 'overridden' })
  })

  it('fails open when the detector throws without force, and reports the miss to the caller', async () => {
    const boom = new Error('ledger scan timed out')
    mockDetectSet.mockRejectedValue(boom)
    const onDetectError = vi.fn()
    await expect(guardAlreadyExplained(supabase, 'company-1', TX_ID, {}, { onDetectError })).resolves.toEqual({
      status: 'clear',
    })
    expect(onDetectError).toHaveBeenCalledWith(boom)
  })

  it('refuses a forced override it cannot re-verify: a detector failure under force is never a pass', async () => {
    const boom = new Error('ledger scan timed out')
    mockDetectSet.mockRejectedValue(boom)
    const onDetectError = vi.fn()
    await expect(
      guardAlreadyExplained(
        supabase,
        'company-1',
        TX_ID,
        { force: true, expected_journal_entry_ids: [JE_A, JE_B] },
        { onDetectError },
      ),
    ).resolves.toEqual({ status: 'unverifiable', error: boom })
    expect(onDetectError).toHaveBeenCalledWith(boom)
  })
})

describe('recordExplainedOverride', () => {
  it('writes a PII-free BankTransactionDuplicateDismissed record naming the vouchers', async () => {
    await recordExplainedOverride('company-1', TX_ID, set, {
      actor: { type: 'user', id: 'user-1' },
      via: 'dashboard_force',
    })
    expect(mockAppend).toHaveBeenCalledTimes(1)
    const input = mockAppend.mock.calls[0][0]
    expect(input).toMatchObject({
      companyId: 'company-1',
      correlationId: TX_ID,
      aggregateType: 'BankTransaction',
      aggregateId: TX_ID,
      eventType: 'BankTransactionDuplicateDismissed',
      actor: { type: 'user', id: 'user-1' },
      payload: {
        transaction_id: TX_ID,
        dismissed_journal_entry_ids: [JE_A, JE_B],
        dismissed_voucher_labels: ['A57', 'A58'],
        total_ore: 8825000,
        bank_account_number: '1930',
        same_date: true,
        via: 'dashboard_force',
      },
    })
    // Descriptions can carry counterparty names: they never enter the record.
    expect(JSON.stringify(input.payload)).not.toContain('kundfaktura')
    expect(input.occurredAt).toBeInstanceOf(Date)
  })

  it('is best-effort: a failed append is reported, never thrown', async () => {
    const boom = new Error('insert failed')
    mockAppend.mockRejectedValue(boom)
    const onError = vi.fn()
    await expect(
      recordExplainedOverride('company-1', TX_ID, set, { actor: { type: 'user', id: 'user-1' }, via: 'x' }, onError),
    ).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(boom)
  })
})

describe('bindDuplicateCandidateOverride (1:1 candidate)', () => {
  it('is clear with no candidate and no force', () => {
    expect(bindDuplicateCandidateOverride(null, {})).toEqual({ status: 'clear' })
  })

  it('blocks a candidate without force', () => {
    expect(bindDuplicateCandidateOverride(candidate, {})).toEqual({ status: 'blocked', candidate })
    expect(bindDuplicateCandidateOverride(candidate, { expected_journal_entry_id: JE_A })).toEqual({
      status: 'blocked',
      candidate,
    })
  })

  it('honours force only for the exact candidate echoed back', () => {
    expect(bindDuplicateCandidateOverride(candidate, { force: true, expected_journal_entry_id: JE_A })).toEqual({
      status: 'overridden',
      candidate,
    })
  })

  it('treats a stale id, a missing id and a vanished candidate as a mismatch (the dashboard contract)', () => {
    expect(bindDuplicateCandidateOverride(candidate, { force: true, expected_journal_entry_id: JE_B })).toEqual({
      status: 'mismatch',
      expected_journal_entry_id: JE_B,
      detected_journal_entry_id: JE_A,
    })
    expect(bindDuplicateCandidateOverride(candidate, { force: true })).toEqual({
      status: 'mismatch',
      expected_journal_entry_id: null,
      detected_journal_entry_id: JE_A,
    })
    expect(bindDuplicateCandidateOverride(null, { force: true, expected_journal_entry_id: JE_A })).toEqual({
      status: 'mismatch',
      expected_journal_entry_id: JE_A,
      detected_journal_entry_id: null,
    })
  })
})

describe('guardDuplicatePaymentVoucher', () => {
  const tx = { id: TX_ID, date: '2026-05-15', amount: 1000, currency: 'EUR', amount_sek: 11500, exchange_rate: 11.5 }

  it('feeds the SEK conversion fields to the detector', async () => {
    mockDetectCandidate.mockResolvedValue(null)
    await expect(guardDuplicatePaymentVoucher(supabase, 'company-1', tx, {})).resolves.toEqual({ status: 'clear' })
    expect(mockDetectCandidate).toHaveBeenCalledWith(supabase, {
      companyId: 'company-1',
      transactionId: TX_ID,
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'EUR',
      transactionAmountSek: 11500,
      transactionExchangeRate: 11.5,
    })
  })

  it('fails open without force, but refuses an override it cannot re-verify', async () => {
    const boom = new Error('scan failed')
    mockDetectCandidate.mockRejectedValue(boom)
    const onDetectError = vi.fn()
    await expect(guardDuplicatePaymentVoucher(supabase, 'company-1', tx, {}, { onDetectError })).resolves.toEqual({
      status: 'clear',
    })
    await expect(
      guardDuplicatePaymentVoucher(supabase, 'company-1', tx, { force: true, expected_journal_entry_id: JE_A }, { onDetectError }),
    ).resolves.toEqual({ status: 'mismatch', expected_journal_entry_id: JE_A, detected_journal_entry_id: null })
    expect(onDetectError).toHaveBeenCalledTimes(2)
  })
})

describe('recordDuplicateCandidateOverride', () => {
  it('writes the singular dismissal shape categorize-core uses', async () => {
    await recordDuplicateCandidateOverride('company-1', TX_ID, candidate, {
      actor: { type: 'user', id: 'user-1' },
      via: 'pending_operation_force',
    })
    expect(mockAppend.mock.calls[0][0]).toMatchObject({
      eventType: 'BankTransactionDuplicateDismissed',
      aggregateId: TX_ID,
      payload: {
        transaction_id: TX_ID,
        dismissed_journal_entry_id: JE_A,
        dismissed_voucher_label: 'A12',
        amount_ore: 100000,
        entry_date: '2026-05-15',
        amount_verified: true,
        via: 'pending_operation_force',
      },
    })
  })
})
