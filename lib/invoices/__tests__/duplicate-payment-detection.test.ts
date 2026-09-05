import { describe, it, expect, beforeEach } from 'vitest'
import {
  detectDuplicatePaymentVoucher,
  detectExplainingVoucherSet,
  detectExplainingVoucherSetForTransaction,
} from '../duplicate-payment-detection'
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

  /**
   * Enqueue the two pages the two-step entry-lines fetch reads
   * (lib/bookkeeping/entry-lines.ts): the parent entries first, then the bare
   * lines keyed by journal_entry_id. Fixtures stay embed-shaped; the helper
   * reattaches the parent under `journal_entry`, which is exactly what the
   * old aliased `journal_entry:journal_entries!inner(...)` embed produced.
   */
  function enqueueLines(rows: ReturnType<typeof makeLineRow>[]) {
    const entries = [
      ...new Map(rows.map((r) => [r.journal_entry.id, r.journal_entry])).values(),
    ]
    enqueue({ data: entries, error: null })
    // No entries means the helper never queries the lines at all.
    if (entries.length === 0) return
    enqueue({
      data: rows.map((r, i) => ({
        id: `line-${String(i).padStart(4, '0')}`,
        journal_entry_id: r.journal_entry.id,
        account_number: r.account_number,
        debit_amount: r.debit_amount,
      })),
      error: null,
    })
  }

  it('returns null when transaction amount is 0', async () => {
    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 0,
      transactionCurrency: 'SEK',
    })
    expect(result).toBeNull()
  })

  it('returns null when transaction date is invalid', async () => {
    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: 'not-a-date',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
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
      transactionCurrency: 'SEK',
    })
    expect(result).toBeNull()
  })

  it('returns the candidate when an unlinked manual JE matches exactly on the same date', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-1',
        account: '1930',
        debit: 1000,
        date: '2026-05-15',
        voucher_label: 'A12',
      }),
    ])
    // invoice_payments link check (no links)
    enqueue({ data: [], error: null })
    // transactions link check (no links)
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    expect(result).not.toBeNull()
    expect(result!.journal_entry_id).toBe('je-1')
    expect(result!.bank_account_number).toBe('1930')
    expect(result!.reason).toBe('exact_amount_same_date')
    expect(result!.amount).toBe(1000)
  })

  it('drives the scan from journal_entries and reattaches the parent under journal_entry', async () => {
    // Shape guard for the entry-lines conversion: no query starts on
    // journal_entry_lines with the tenant scope buried in an embed, and the
    // candidate is still built from the parent fields (voucher label, date,
    // description) plus the line fields (account, debit).
    // The mock client is module-level, so only this test's calls are read.
    const callsBefore = supabase.from.mock.calls.length
    enqueueLines([
      makeLineRow({
        je_id: 'je-shape',
        account: '1930',
        debit: 1000,
        date: '2026-05-15',
        voucher_label: 'A12',
        description: 'Manuell inbetalning',
      }),
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    const tables = supabase.from.mock.calls.slice(callsBefore).map((c) => c[0])
    expect(tables[0]).toBe('journal_entries')
    expect(tables[1]).toBe('journal_entry_lines')
    expect(result).toEqual({
      journal_entry_id: 'je-shape',
      voucher_label: 'A12',
      entry_date: '2026-05-15',
      description: 'Manuell inbetalning',
      amount: 1000,
      bank_account_number: '1930',
      reason: 'exact_amount_same_date',
      amount_verified: true,
      unverified_reason: null,
    })
  })

  it('returns within_window reason when JE date is close but not equal', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-2',
        account: '1930',
        debit: 500,
        date: '2026-05-12',
        voucher_label: 'A5',
      }),
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 500,
      transactionCurrency: 'SEK',
    })

    expect(result).not.toBeNull()
    expect(result!.reason).toBe('exact_amount_within_window')
  })

  it('excludes JEs that are already linked via invoice_payments', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-3',
        account: '1930',
        debit: 1000,
        date: '2026-05-15',
      }),
    ])
    // invoice_payments has a row linking this JE to a bank transaction
    enqueue({ data: [{ journal_entry_id: 'je-3', transaction_id: 'tx-bank' }], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    expect(result).toBeNull()
  })

  // #2019: "Markera som betald" and Stripe now write a payment row WITHOUT a
  // bank transaction. That row means "paid by hand", not "reconciled to a
  // bank line", so the voucher must still surface when the real bank line
  // arrives; otherwise a second payment voucher posts silently.
  it('still flags a voucher whose payment row carries no bank transaction (manual settlement)', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-manual',
        account: '1930',
        debit: 1000,
        date: '2026-05-15',
      }),
    ])
    enqueue({ data: [{ journal_entry_id: 'je-manual', transaction_id: null }], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    expect(result?.journal_entry_id).toBe('je-manual')
  })

  it('excludes JEs already linked from another transaction', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-4',
        account: '1930',
        debit: 1000,
        date: '2026-05-15',
      }),
    ])
    enqueue({ data: [], error: null })
    // another transaction already links this JE
    enqueue({ data: [{ id: 'tx-other', journal_entry_id: 'je-4' }], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    expect(result).toBeNull()
  })

  it('excludes storno entries', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-storno',
        account: '1930',
        debit: 1000,
        date: '2026-05-15',
        source_type: 'storno',
      }),
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    expect(result).toBeNull()
  })

  it('excludes correction entries', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-corr',
        account: '1930',
        debit: 1000,
        date: '2026-05-15',
        source_type: 'correction',
      }),
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    expect(result).toBeNull()
  })

  it('picks the same-date candidate over a within-window candidate', async () => {
    enqueueLines([
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
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    expect(result).not.toBeNull()
    expect(result!.journal_entry_id).toBe('je-same')
    expect(result!.reason).toBe('exact_amount_same_date')
  })

  it('matches absolute value for negative transaction amounts (expense)', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-x',
        account: '1930',
        debit: 250,
        date: '2026-05-15',
      }),
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: -250,
      transactionCurrency: 'SEK',
    })

    // Note: while the match-invoice route only handles income, the
    // detector itself is amount-direction agnostic: it just finds JEs
    // that book the same magnitude on the bank side. Callers gate by
    // direction.
    expect(result).not.toBeNull()
    expect(result!.amount).toBe(250)
  })

  it('skips lines whose amount differs by more than 0.01', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-off',
        account: '1930',
        debit: 1001,
        date: '2026-05-15',
      }),
    ])

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    expect(result).toBeNull()
  })

  it('ignores the caller transaction even if it carries a journal_entry_id link', async () => {
    enqueueLines([
      makeLineRow({
        je_id: 'je-caller',
        account: '1930',
        debit: 1000,
        date: '2026-05-15',
      }),
    ])
    enqueue({ data: [], error: null })
    // The caller transaction itself links the JE (defensive: shouldn't happen
    // in normal flow because we call this before the link, but a retry could).
    enqueue({ data: [{ id: 'tx-caller', journal_entry_id: 'je-caller' }], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-caller',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'SEK',
    })

    expect(result).not.toBeNull()
    expect(result!.journal_entry_id).toBe('je-caller')
  })

  // ── FX: the bank line may be foreign, the 19xx debit is always SEK ─────────
  //
  // journal_entry_lines.debit_amount is written in SEK even when the line
  // carries currency='EUR' + amount_in_currency as document metadata, so the
  // bank line has to be converted before the two can be compared at all.

  it('flags a foreign receipt against the SEK voucher its own booking produced', async () => {
    // 100 EUR at 11.50 was booked as a 1150 SEK debit.
    enqueueLines([
      makeLineRow({ je_id: 'je-fx', account: '1930', debit: 1150, date: '2026-05-15', voucher_label: 'A9' }),
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 100,
      transactionCurrency: 'EUR',
      transactionAmountSek: 1150,
      transactionExchangeRate: 11.5,
    })

    expect(result).not.toBeNull()
    expect(result!.journal_entry_id).toBe('je-fx')
    expect(result!.amount).toBe(1150)
    expect(result!.amount_verified).toBe(true)
    expect(result!.unverified_reason).toBeNull()
  })

  it('converts via exchange_rate when amount_sek was never stored', async () => {
    enqueueLines([
      makeLineRow({ je_id: 'je-rate', account: '1930', debit: 1150, date: '2026-05-15' }),
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 100,
      transactionCurrency: 'EUR',
      transactionAmountSek: null,
      transactionExchangeRate: 11.5,
    })

    expect(result!.journal_entry_id).toBe('je-rate')
    expect(result!.amount_verified).toBe(true)
  })

  it('does NOT flag a EUR line against an unrelated same-magnitude SEK voucher', async () => {
    // 1000 EUR is ~11 500 SEK, nothing to do with a 1000 SEK voucher. The old
    // comparison put the raw 1000 against the leg and matched.
    enqueueLines([
      makeLineRow({ je_id: 'je-coincidence', account: '1930', debit: 1000, date: '2026-05-15' }),
    ])

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: 'EUR',
      transactionAmountSek: 11500,
      transactionExchangeRate: 11.5,
    })

    expect(result).toBeNull()
  })

  it('WARNS rather than passing when a foreign line carries no rate', async () => {
    // Nothing can be compared. A null return would read as "no duplicate" and
    // let the matcher post a second payment voucher for one affärshändelse.
    enqueueLines([
      makeLineRow({ je_id: 'je-unverifiable', account: '1930', debit: 1150, date: '2026-05-15' }),
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 100,
      transactionCurrency: 'EUR',
      transactionAmountSek: null,
      transactionExchangeRate: null,
    })

    expect(result).not.toBeNull()
    expect(result!.journal_entry_id).toBe('je-unverifiable')
    expect(result!.amount_verified).toBe(false)
    expect(result!.unverified_reason).toBe('transaction_missing_sek_value')
    // The amount test never ran, so the reason must not claim an amount match:
    // 'exact_amount_*' here made the dialog render "på samma belopp" for a
    // candidate whose amounts were never compared.
    expect(result!.reason).toBe('date_window_only')
    // The leg's SEK figure, never the bank line's foreign 100.
    expect(result!.amount).toBe(1150)
  })

  it('returns null (a verified pass) for a rateless foreign line with no 19xx debit in the window', async () => {
    enqueueLines([])

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 100,
      transactionCurrency: 'EUR',
      transactionAmountSek: null,
      transactionExchangeRate: null,
    })

    expect(result).toBeNull()
  })

  it('still excludes storno when the amount cannot be verified', async () => {
    enqueueLines([
      makeLineRow({ je_id: 'je-s', account: '1930', debit: 1150, date: '2026-05-15', source_type: 'storno' }),
    ])

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 100,
      transactionCurrency: 'EUR',
      transactionAmountSek: null,
      transactionExchangeRate: null,
    })

    expect(result).toBeNull()
  })

  it('leaves a SEK company on exactly the old path (null currency = SEK default)', async () => {
    enqueueLines([
      makeLineRow({ je_id: 'je-sek', account: '1930', debit: 1000, date: '2026-05-15' }),
    ])
    enqueue({ data: [], error: null })
    enqueue({ data: [], error: null })

    const result = await detectDuplicatePaymentVoucher(supabase as never, {
      companyId: 'company-1',
      transactionId: 'tx-1',
      transactionDate: '2026-05-15',
      transactionAmount: 1000,
      transactionCurrency: null,
    })

    expect(result!.journal_entry_id).toBe('je-sek')
    expect(result!.amount_verified).toBe(true)
  })
})

describe('detectExplainingVoucherSet', () => {
  beforeEach(() => {
    reset()
  })

  type SetLine = {
    account_number: string
    debit_amount: number
    credit_amount: number
    journal_entry: {
      id: string
      entry_date: string
      description: string | null
      voucher_series: string
      voucher_number: number
      status: string
      source_type: string | null
      company_id: string
    }
  }

  function leg(opts: {
    je_id: string
    date: string
    debit?: number
    credit?: number
    account?: string
    label?: string
    source_type?: string | null
    description?: string
  }): SetLine {
    const label = opts.label ?? 'A1'
    return {
      account_number: opts.account ?? '1930',
      debit_amount: opts.debit ?? 0,
      credit_amount: opts.credit ?? 0,
      journal_entry: {
        id: opts.je_id,
        entry_date: opts.date,
        description: opts.description ?? `Voucher ${opts.je_id}`,
        voucher_series: label[0],
        voucher_number: parseInt(label.slice(1), 10) || 1,
        status: 'posted',
        source_type: opts.source_type === undefined ? 'invoice_paid' : opts.source_type,
        company_id: 'company-1',
      },
    }
  }

  /** entries page, lines page, then the four link lookups (all empty unless given). */
  function enqueueScan(
    rows: SetLine[],
    links: {
      invoicePayments?: unknown[]
      supplierPayments?: unknown[]
      transactions?: unknown[]
      junction?: unknown[]
    } = {},
  ) {
    const entries = [...new Map(rows.map((r) => [r.journal_entry.id, r.journal_entry])).values()]
    enqueue({ data: entries, error: null })
    if (entries.length === 0) return
    enqueue({
      data: rows.map((r, i) => ({
        id: `line-${i}`,
        journal_entry_id: r.journal_entry.id,
        account_number: r.account_number,
        debit_amount: r.debit_amount,
        credit_amount: r.credit_amount,
      })),
      error: null,
    })
    enqueue({ data: links.invoicePayments ?? [], error: null })
    enqueue({ data: links.supplierPayments ?? [], error: null })
    enqueue({ data: links.transactions ?? [], error: null })
    enqueue({ data: links.junction ?? [], error: null })
  }

  const baseArgs = {
    companyId: 'company-1',
    transactionId: 'tx-bg',
    transactionDate: '2026-07-31',
    transactionCurrency: 'SEK',
  }

  it('explains a Bankgirot aggregate with the two mark-paid vouchers that sum to it', async () => {
    // The reported case: 063 and 064 marked paid by hand (A57 + A58), then one
    // 88 250 "BGGIRERING" row. Their payment rows carry no bank transaction.
    enqueueScan(
      [
        leg({ je_id: 'A57', date: '2026-07-31', debit: 62500, label: 'A57', description: 'Inbetalning kundfaktura 063' }),
        leg({ je_id: 'A58', date: '2026-07-31', debit: 25750, label: 'A58', description: 'Inbetalning kundfaktura 064' }),
        leg({ je_id: 'A56', date: '2026-07-20', debit: 150, label: 'A56', source_type: 'bank_transaction' }),
      ],
      {
        invoicePayments: [
          { journal_entry_id: 'A57', transaction_id: null },
          { journal_entry_id: 'A58', transaction_id: null },
        ],
      },
    )

    const set = await detectExplainingVoucherSet(supabase as never, {
      ...baseArgs,
      transactionAmount: 88250,
      bankAccountNumber: '1930',
    })

    expect(set).not.toBeNull()
    expect(set!.vouchers.map((v) => v.journal_entry_id).sort()).toEqual(['A57', 'A58'])
    expect(set!.total).toBe(88250)
    expect(set!.bank_account_number).toBe('1930')
    expect(set!.same_date).toBe(true)
    expect(set!.vouchers[0].voucher_label).toBe('A57')
  })

  it('scopes the scan to the row settlement account and the row direction', async () => {
    const callsBefore = supabase.from.mock.calls.length
    enqueueScan([leg({ je_id: 'je-1', date: '2026-07-31', credit: 1185 })])

    const set = await detectExplainingVoucherSet(supabase as never, {
      ...baseArgs,
      transactionAmount: -1185,
      bankAccountNumber: '1930',
    })

    const tables = supabase.from.mock.calls.slice(callsBefore).map((c) => c[0])
    expect(tables.slice(0, 2)).toEqual(['journal_entries', 'journal_entry_lines'])
    // Money out: the credit leg is the voucher's bank line.
    expect(set?.vouchers.map((v) => v.amount)).toEqual([1185])
  })

  it('returns null when no set of at most four vouchers sums exactly to the row', async () => {
    enqueueScan([
      leg({ je_id: 'a', date: '2026-07-31', debit: 62500 }),
      leg({ je_id: 'b', date: '2026-07-31', debit: 25000 }),
    ])
    const set = await detectExplainingVoucherSet(supabase as never, {
      ...baseArgs,
      transactionAmount: 88250,
    })
    expect(set).toBeNull()
  })

  it('drops vouchers a bank transaction already explains through any anchor', async () => {
    enqueueScan(
      [
        leg({ je_id: 'via-tx', date: '2026-07-31', debit: 100 }),
        leg({ je_id: 'via-payment', date: '2026-07-31', debit: 100 }),
        leg({ je_id: 'via-supplier-payment', date: '2026-07-31', debit: 100 }),
        leg({ je_id: 'via-junction', date: '2026-07-31', debit: 100 }),
        leg({ je_id: 'free', date: '2026-07-31', debit: 100 }),
      ],
      {
        invoicePayments: [{ journal_entry_id: 'via-payment', transaction_id: 'tx-other' }],
        supplierPayments: [{ journal_entry_id: 'via-supplier-payment', transaction_id: 'tx-other' }],
        transactions: [{ id: 'tx-other', journal_entry_id: 'via-tx' }],
        junction: [{ journal_entry_id: 'via-junction' }],
      },
    )
    const set = await detectExplainingVoucherSet(supabase as never, {
      ...baseArgs,
      transactionAmount: 100,
    })
    expect(set?.vouchers.map((v) => v.journal_entry_id)).toEqual(['free'])
  })

  it('never sums storno, correction or opening-balance entries', async () => {
    enqueueScan([
      leg({ je_id: 'storno', date: '2026-07-31', debit: 500, source_type: 'storno' }),
      leg({ je_id: 'corr', date: '2026-07-31', debit: 300, source_type: 'correction' }),
      leg({ je_id: 'ib', date: '2026-07-31', debit: 200, source_type: 'opening_balance' }),
    ])
    const set = await detectExplainingVoucherSet(supabase as never, {
      ...baseArgs,
      transactionAmount: 1000,
    })
    expect(set).toBeNull()
  })

  it('returns null without scanning when the row cannot be stated in SEK', async () => {
    const callsBefore = supabase.from.mock.calls.length
    const set = await detectExplainingVoucherSet(supabase as never, {
      ...baseArgs,
      transactionAmount: 1000,
      transactionCurrency: 'EUR',
      transactionAmountSek: null,
      transactionExchangeRate: null,
    })
    expect(set).toBeNull()
    expect(supabase.from.mock.calls.length).toBe(callsBefore)
  })

  it('states a foreign row in SEK before summing', async () => {
    enqueueScan([leg({ je_id: 'je-eur', date: '2026-07-31', debit: 11500 })])
    const set = await detectExplainingVoucherSet(supabase as never, {
      ...baseArgs,
      transactionAmount: 1000,
      transactionCurrency: 'EUR',
      transactionAmountSek: 11500,
    })
    expect(set?.vouchers.map((v) => v.journal_entry_id)).toEqual(['je-eur'])
    expect(set?.total).toBe(11500)
  })

  it('fails open (null) when the ledger scan throws', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    const set = await detectExplainingVoucherSet(supabase as never, {
      ...baseArgs,
      transactionAmount: 1000,
    })
    expect(set).toBeNull()
  })
})

describe('detectExplainingVoucherSetForTransaction', () => {
  beforeEach(() => {
    reset()
  })

  it('returns null for a row that already carries a pointer, without scanning', async () => {
    enqueue({ data: { id: 'tx-1', date: '2026-07-31', amount: 100, currency: 'SEK', journal_entry_id: 'je-live' }, error: null })
    const callsBefore = supabase.from.mock.calls.length
    const set = await detectExplainingVoucherSetForTransaction(supabase as never, 'company-1', 'tx-1')
    expect(set).toBeNull()
    expect(supabase.from.mock.calls.length - callsBefore).toBe(1)
  })

  it('resolves the settlement account from the cash account before scanning', async () => {
    const callsBefore = supabase.from.mock.calls.length
    enqueue({ data: { id: 'tx-1', date: '2026-07-31', amount: 100, currency: 'SEK', cash_account_id: 'ca-1', journal_entry_id: null }, error: null })
    enqueue({ data: { ledger_account: '1940' }, error: null })
    // entries page: nothing on the account, scan ends.
    enqueue({ data: [], error: null })
    const set = await detectExplainingVoucherSetForTransaction(supabase as never, 'company-1', 'tx-1')
    expect(set).toBeNull()
    const tables = supabase.from.mock.calls.slice(callsBefore).map((c) => c[0])
    expect(tables).toEqual(['transactions', 'cash_accounts', 'journal_entries'])
  })
})
