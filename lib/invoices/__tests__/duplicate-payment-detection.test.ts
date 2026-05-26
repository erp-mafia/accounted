import { describe, it, expect, beforeEach } from 'vitest'
import { detectDuplicatePaymentVoucher } from '../duplicate-payment-detection'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

describe('detectDuplicatePaymentVoucher', () => {
  beforeEach(() => {
    reset()
  })

  function makeLineRow(opts: {
    je_id: string
    account: string
    debit: number
    date: string
    voucher_label?: string
    source_type?: string | null
    description?: string | null
  }) {
    const [series, ...numParts] = (opts.voucher_label ?? 'A1').split('')
    const num = parseInt(numParts.join(''), 10) || 1
    return {
      account_number: opts.account,
      debit_amount: opts.debit,
      journal_entry: {
        id: opts.je_id,
        entry_date: opts.date,
        description: opts.description ?? `Voucher ${opts.je_id}`,
        voucher_series: series,
        voucher_number: num,
        status: 'posted',
        source_type: opts.source_type ?? 'manual',
        company_id: 'company-1',
      },
    }
  }

  it('returns null when transaction amount is 0', async () => {
    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 0,
    })
    expect(result).toBeNull()
  })

  it('returns null when transaction date is invalid', async () => {
    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: 'not-a-date',
      transactionAmount: 1000,
    })
    expect(result).toBeNull()
  })

  it('returns null when no lines are found', async () => {
    enqueue({ data: [], error: null })
    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
    })
    expect(result).toBeNull()
  })

  it('returns the candidate when an unlinked manual JE matches exactly on the same date', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-1',
          account: '1930',
          debit: 1000,
          date: '2026-05-15',
          voucher_label: 'A12',
        }),
      ],
      error: null,
    })
    // invoice_payments link check (no links)
    enqueue({ data: [], error: null })
    // transactions link check (no links)
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
    })

    expect(result).not.toBeNull()
    expect(result!.journal_entry_id).toBe('je-1')
    expect(result!.bank_account_number).toBe('1930')
    expect(result!.reason).toBe('exact_amount_same_date')
    expect(result!.amount).toBe(1000)
  })

  it('returns within_window reason when JE date is close but not equal', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-2',
          account: '1930',
          debit: 500,
          date: '2026-05-12',
          voucher_label: 'A5',
        }),
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 500,
    })

    expect(result).not.toBeNull()
    expect(result!.reason).toBe('exact_amount_within_window')
  })

  it('excludes JEs that are already linked via invoice_payments', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-3',
          account: '1930',
          debit: 1000,
          date: '2026-05-15',
        }),
      ],
      error: null,
    })
    // invoice_payments has a row linking this JE
    enqueue({ data: [{ journal_entry_id: 'je-3' }], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
    })

    expect(result).toBeNull()
  })

  it('excludes JEs already linked from another transaction', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-4',
          account: '1930',
          debit: 1000,
          date: '2026-05-15',
        }),
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    // another transaction already links this JE
    enqueue({ data: [{ id: 'tx-other', journal_entry_id: 'je-4' }], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
    })

    expect(result).toBeNull()
  })

  it('excludes storno entries', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-storno',
          account: '1930',
          debit: 1000,
          date: '2026-05-15',
          source_type: 'storno',
        }),
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
    })

    expect(result).toBeNull()
  })

  it('excludes correction entries', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-corr',
          account: '1930',
          debit: 1000,
          date: '2026-05-15',
          source_type: 'correction',
        }),
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
    })

    expect(result).toBeNull()
  })

  it('picks the same-date candidate over a within-window candidate', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-far',
          account: '1930',
          debit: 1000,
          date: '2026-05-12',
          voucher_label: 'A1',
        }),
        makeLineRow({
          je_id: 'je-same',
          account: '1930',
          debit: 1000,
          date: '2026-05-15',
          voucher_label: 'A2',
        }),
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
    })

    expect(result).not.toBeNull()
    expect(result!.journal_entry_id).toBe('je-same')
    expect(result!.reason).toBe('exact_amount_same_date')
  })

  it('matches absolute value for negative transaction amounts (expense)', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-x',
          account: '1930',
          debit: 250,
          date: '2026-05-15',
        }),
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: -250,
    })

    // Note: while the match-invoice route only handles income, the
    // detector itself is amount-direction agnostic — it just finds JEs
    // that book the same magnitude on the bank side. Callers gate by
    // direction.
    expect(result).not.toBeNull()
    expect(result!.amount).toBe(250)
  })

  it('skips lines whose amount differs by more than 0.01', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-off',
          account: '1930',
          debit: 1001,
          date: '2026-05-15',
        }),
      ],
      error: null,
    })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
    })

    expect(result).toBeNull()
  })

  it('ignores the caller transaction even if it carries a journal_entry_id link', async () => {
    enqueue({
      data: [
        makeLineRow({
          je_id: 'je-caller',
          account: '1930',
          debit: 1000,
          date: '2026-05-15',
        }),
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    // The caller transaction itself links the JE (defensive — shouldn't happen
    // in normal flow because we call this before the link, but a retry could).
    enqueue({ data: [{ id: 'tx-caller', journal_entry_id: 'je-caller' }], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-caller',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
    })

    expect(result).not.toBeNull()
    expect(result!.journal_entry_id).toBe('je-caller')
  })
})
