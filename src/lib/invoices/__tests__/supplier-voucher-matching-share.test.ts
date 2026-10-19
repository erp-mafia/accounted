/**
 * One verifikat that pays several debts (GitHub issue 3490): the stated share
 * (`amount`) and the capacity rule, in the pre-stage validator, the link call
 * and the candidate matcher.
 *
 * The reported case: a company came in by SIE, so an old supplier debt is only
 * part of the 2440 opening balance. One bank payment paid that debt and a new
 * invoice, booked as one verifikat (Dr 2440 for the sum / Cr 1930). The link
 * read the whole debit as the new invoice's payment and refused it.
 *
 * The RPC is the authority and is pinned against real Postgres in
 * tests/pg/link-supplier-invoice-voucher-share.pg.test.ts. What is pinned here
 * is that the TypeScript half gives the same answers before anything is
 * staged, and that the matcher offers such a voucher only where a person
 * picks. All amounts are synthetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The registration-first rule (defer_invoice_booking) has its own suites
// (registration-first.test.ts and the deferred-door tests); here no invoice
// needs its registration booked first.
vi.mock('@/lib/supplier-invoices/registration-first', () => ({
  planRegistrationBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
  planRegistrationBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
  bookRegistrationBeforeSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryId: null,
    bookedHere: false,
    warnings: [],
  })),
  planRegistrationsBeforeBatchSettlement: vi.fn(async () => ({ ok: true, plans: [] })),
  bookRegistrationsBeforeBatchSettlement: vi.fn(async () => ({
    ok: true,
    journalEntryIds: {},
    postedJournalEntryIds: {},
    warnings: [],
  })),
}))
import {
  validateVoucherForSupplierInvoiceLink,
  linkSupplierInvoiceToVoucher,
  findMatchingVouchersForSupplierInvoice,
} from '../supplier-voucher-matching'
import { makeSupplierInvoice, createQueuedMockSupabase } from '@/tests/helpers'

const AP_DEBIT = { side: 'ap_debit', accountPrefix: '244', entrySide: 'debit' } as const
const BANK_CREDIT = { side: 'bank_credit', accountPrefix: '19', entrySide: 'credit' } as const

const { mockResolveSide } = vi.hoisted(() => ({ mockResolveSide: vi.fn() }))
vi.mock('@/lib/invoices/supplier-settlement-side', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supplier-settlement-side')>()
  return { ...actual, resolveSupplierSettlementSide: mockResolveSide }
})

vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: vi.fn(),
}))
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  autoReconcileTransactionForLinkedVoucher: vi.fn().mockResolvedValue(null),
}))

const voucher = () => ({
  id: 'je-1',
  voucher_series: 'A',
  voucher_number: 12,
  entry_date: '2026-04-28',
  description: 'Leverantörsbetalning',
  status: 'posted',
  source_type: 'bank_transaction',
  fiscal_period_id: 'fp-1',
  company_id: 'company-1',
})

/** Faktureringsmetoden: one debit on 2440 for everything the payment covered. */
const payableLines = (total: number) => [
  { account_number: '2440', debit_amount: total, credit_amount: 0, currency: 'SEK', amount_in_currency: null },
  { account_number: '1930', debit_amount: 0, credit_amount: total, currency: 'SEK', amount_in_currency: null },
]

/** Kontantmetoden: the cost against the bank account, no 244x line. */
const cashLines = (total: number) => [
  { account_number: '4010', debit_amount: total, credit_amount: 0, currency: 'SEK', amount_in_currency: null },
  { account_number: '1930', debit_amount: 0, credit_amount: total, currency: 'SEK', amount_in_currency: null },
]

/** A payment row another invoice already has on the voucher. */
const otherInvoiceRow = (amount: number, currency = 'SEK') => ({
  journal_entry_id: 'je-1',
  supplier_invoice_id: 'si-other',
  amount,
  currency,
})

const sekInvoice = (remaining = 1250) =>
  makeSupplierInvoice({
    id: 'si-1',
    total: remaining,
    paid_amount: 0,
    remaining_amount: remaining,
    currency: 'SEK',
  })

async function validate(
  invoice: ReturnType<typeof makeSupplierInvoice>,
  queue: Array<{ data?: unknown; error?: unknown }>,
  amount?: number | null,
) {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  enqueueMany(queue)
  const result = await validateVoucherForSupplierInvoiceLink(
    supabase as never,
    'company-1',
    invoice as never,
    'je-1',
    amount,
  )
  return { result, supabase }
}

describe('validateVoucherForSupplierInvoiceLink: a verifikat that pays several debts (244x)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveSide.mockResolvedValue(AP_DEBIT)
  })

  it('the report: without a stated share the whole debit is still refused, nothing is split on a guess', async () => {
    // 5 250 kr left the bank: 4 000 kr for a debt that is only in the 2440
    // opening balance, 1 250 kr for this invoice.
    const { result } = await validate(sekInvoice(1250), [
      { data: voucher() },
      { data: payableLines(5250) },
      { data: [] }, // payment rows on the voucher (capacity)
    ])
    expect(result).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ap_debit: 5250, remaining: 1250 },
    })
  })

  it('the stated share settles the invoice and leaves the rest of the verifikat', async () => {
    const { result } = await validate(
      sekInvoice(1250),
      [
        { data: voucher() },
        { data: payableLines(5250) },
        { data: [] }, // capacity
        { data: [] }, // already linked to this invoice?
      ],
      1250,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.settlementSide).toBe('ap_debit')
      expect(result.paymentAmount).toBe(1250)
      expect(result.isFullyPaid).toBe(true)
      expect(result.remainingAfter).toBe(0)
      // What the old debt took: it has no invoice here, so nothing links it.
      expect(result.voucherRemainingAfter).toBe(4000)
    }
  })

  it('a share smaller than the invoice is a part payment', async () => {
    const { result } = await validate(
      sekInvoice(1250),
      [{ data: voucher() }, { data: payableLines(5250) }, { data: [] }, { data: [] }],
      400,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.paymentAmount).toBe(400)
      expect(result.isFullyPaid).toBe(false)
      expect(result.remainingAfter).toBe(850)
      expect(result.voucherRemainingAfter).toBe(4850)
    }
  })

  it('refuses a share larger than the invoice has left', async () => {
    const { result } = await validate(
      sekInvoice(1250),
      [{ data: voucher() }, { data: payableLines(5250) }, { data: [] }],
      1300,
    )
    expect(result).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { amount: 1300, remaining: 1250 },
    })
  })

  it('refuses a share larger than the verifikat has left after other invoices', async () => {
    const { result } = await validate(
      sekInvoice(1250),
      [{ data: voucher() }, { data: payableLines(5250) }, { data: [otherInvoiceRow(4500)] }],
      1250,
    )
    expect(result).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1250, available: 750, ap_debit: 5250, already_linked: 4500 },
    })
  })

  it('a 244x verifikat another invoice has used in full is refused: the same money cannot pay twice', async () => {
    const { result } = await validate(sekInvoice(1250), [
      { data: voucher() },
      { data: payableLines(1250) },
      { data: [otherInvoiceRow(1250)] },
    ])
    expect(result).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
      details: { ap_debit: 1250, already_linked: 1250 },
    })
  })

  it('what the verifikat has left links without a stated share when it fits inside the invoice', async () => {
    const { result } = await validate(sekInvoice(1250), [
      { data: voucher() },
      { data: payableLines(5250) },
      { data: [otherInvoiceRow(4000)] },
      { data: [] },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.apDebitAmount).toBe(1250)
      expect(result.paymentAmount).toBe(1250)
      expect(result.voucherRemainingAfter).toBe(0)
    }
  })

  it('the own row of this invoice does not count against the capacity: the repeated link keeps its answer', async () => {
    const { result } = await validate(sekInvoice(1250), [
      { data: voucher() },
      { data: payableLines(1250) },
      { data: [{ journal_entry_id: 'je-1', supplier_invoice_id: 'si-1', amount: 1250, currency: 'SEK' }] },
      { data: [{ id: 'p-1' }] },
    ])
    expect(result).toEqual({ ok: false, code: 'LINK_SI_VOUCHER_ALREADY_LINKED' })
  })

  it('refuses rows in another currency on the verifikat: the used part cannot be read', async () => {
    const { result } = await validate(
      sekInvoice(1250),
      [{ data: voucher() }, { data: payableLines(5250) }, { data: [otherInvoiceRow(100, 'EUR')] }],
      1250,
    )
    expect(result).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'SEK', reason: 'voucher_settles_other_currency' },
    })
  })

  it.each([0, -1250, 0.004, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a share of %s before reading anything',
    async (amount) => {
      const { result, supabase } = await validate(sekInvoice(1250), [], amount)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('LINK_SI_VOUCHER_AMOUNT_INVALID')
      expect(supabase.from).not.toHaveBeenCalled()
    },
  )

  it('reads the share to the öre', async () => {
    const { result } = await validate(
      sekInvoice(1250),
      [{ data: voucher() }, { data: payableLines(5250) }, { data: [] }, { data: [] }],
      1250.004,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.paymentAmount).toBe(1250)
  })
})

describe('validateVoucherForSupplierInvoiceLink: a share and a foreign invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveSide.mockResolvedValue(AP_DEBIT)
  })

  const eurInvoice = () =>
    makeSupplierInvoice({
      id: 'si-1',
      total: 100,
      paid_amount: 0,
      remaining_amount: 100,
      currency: 'EUR',
      exchange_rate: 11,
    })

  it('a verifikat whose 244x debit is in the invoice currency takes a share', async () => {
    // 300 EUR left the books on one verifikat; this invoice is 100 EUR of it.
    const lines = [
      { account_number: '2440', debit_amount: 3300, credit_amount: 0, currency: 'EUR', amount_in_currency: 300 },
      { account_number: '1930', debit_amount: 0, credit_amount: 3300, currency: 'SEK', amount_in_currency: null },
    ]
    const without = await validate(eurInvoice(), [{ data: voucher() }, { data: lines }, { data: [] }])
    expect(without.result).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ap_debit: 300, remaining: 100 },
    })

    const { result } = await validate(
      eurInvoice(),
      [{ data: voucher() }, { data: lines }, { data: [] }, { data: [] }],
      100,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.paymentAmount).toBe(100)
      expect(result.voucherRemainingAfter).toBe(200)
    }
  })

  it('a kronor verifikat takes no share: the kursdifferens of a part would be a guess', async () => {
    const { result } = await validate(
      eurInvoice(),
      [{ data: voucher() }, { data: payableLines(5250) }],
      100,
    )
    expect(result).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'EUR', line_currency: 'SEK', reason: 'amount_needs_invoice_currency' },
    })
  })

  it('a kronor verifikat that settles the whole foreign invoice still does, without a share', async () => {
    const { result } = await validate(eurInvoice(), [
      { data: voucher() },
      { data: payableLines(1130) },
      { data: [] },
      { data: [] },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.paymentAmount).toBe(100)
      expect(result.voucherRemainingAfter).toBe(0)
    }
  })
})

describe('validateVoucherForSupplierInvoiceLink: a share of a 19xx credit (kontantmetoden)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveSide.mockResolvedValue(BANK_CREDIT)
  })

  it('one payout that paid two purchases settles this invoice with its share', async () => {
    const { result } = await validate(
      sekInvoice(1250),
      [{ data: voucher() }, { data: cashLines(5250) }, { data: [] }, { data: [] }],
      1250,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.settlementSide).toBe('bank_credit')
      expect(result.paymentAmount).toBe(1250)
      expect(result.voucherRemainingAfter).toBe(4000)
    }
  })

  it('names the 19xx side when the share is more than the payout has left', async () => {
    const { result } = await validate(
      sekInvoice(1250),
      [{ data: voucher() }, { data: cashLines(5250) }, { data: [otherInvoiceRow(4500)] }],
      1250,
    )
    expect(result).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1250, available: 750, bank_credit: 5250, already_linked: 4500 },
    })
  })
})

describe('linkSupplierInvoiceToVoucher: the stated share reaches the RPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const rpcOk = {
    ok: true,
    payment_id: 'sip-1',
    invoice_status: 'paid',
    paid_amount: 1250,
    remaining_amount: 0,
    payment_amount: 1250,
    journal_entry_id: 'je-1',
    currency: 'SEK',
    voucher_remaining: 4000,
  }

  it('sends p_amount and answers with what the verifikat has left', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: rpcOk })
    enqueue({ data: null }) // post-link invoice re-fetch (best-effort)

    const outcome = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-1',
      journalEntryId: 'je-1',
      amount: 1250,
    })

    expect(supabase.rpc).toHaveBeenCalledWith('link_supplier_invoice_to_voucher', {
      p_supplier_invoice_id: 'si-1',
      p_journal_entry_id: 'je-1',
      p_user_id: 'user-1',
      p_company_id: 'company-1',
      p_notes: null,
      p_amount: 1250,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.paymentAmount).toBe(1250)
      expect(outcome.result.voucherRemaining).toBe(4000)
    }
  })

  it('without a share the call is the five-argument one, readable by a database that predates the share', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // The answer of the function before migration 20261011153000: no voucher_remaining.
    enqueue({ data: { ...rpcOk, voucher_remaining: undefined } })
    enqueue({ data: null })

    const outcome = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-1',
      journalEntryId: 'je-1',
    })

    expect(supabase.rpc).toHaveBeenCalledWith('link_supplier_invoice_to_voucher', {
      p_supplier_invoice_id: 'si-1',
      p_journal_entry_id: 'je-1',
      p_user_id: 'user-1',
      p_company_id: 'company-1',
      p_notes: null,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.result.voucherRemaining).toBeNull()
  })

  it('passes the refusal of a share through with its details', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ok: false,
        code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
        details: { amount: 1250, available: 750, ap_debit: 5250, already_linked: 4500 },
      },
    })

    const outcome = await linkSupplierInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      supplierInvoiceId: 'si-1',
      journalEntryId: 'je-1',
      amount: 1250,
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1250, available: 750, ap_debit: 5250, already_linked: 4500 },
    })
  })
})

describe('findMatchingVouchersForSupplierInvoice: a verifikat with more left than the invoice needs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveSide.mockResolvedValue(AP_DEBIT)
  })

  const entry = (over: Partial<{ id: string; description: string; entry_date: string }> = {}) => ({
    id: over.id ?? 'je-1',
    voucher_series: 'A',
    voucher_number: 12,
    entry_date: over.entry_date ?? '2026-04-28',
    description: over.description ?? 'LB-utbetalning',
    status: 'posted',
    source_type: 'bank_transaction',
    fiscal_period_id: 'fp-1',
  })

  const line = (entryId: string, debit: number) => ({
    id: `line-${entryId}`,
    journal_entry_id: entryId,
    account_number: '2440',
    debit_amount: debit,
    credit_amount: 0,
    currency: 'SEK',
    amount_in_currency: null,
  })

  const invoice = () =>
    makeSupplierInvoice({
      id: 'si-1',
      total: 1250,
      paid_amount: 0,
      remaining_amount: 1250,
      currency: 'SEK',
      due_date: '2026-05-01',
      supplier_invoice_number: 'LF-77001',
    })

  const openPeriod = { data: [{ id: 'fp-1', is_closed: false, locked_at: null }] }

  async function find(
    queue: Array<{ data?: unknown; error?: unknown }>,
    options: { includeShared?: boolean } = {},
  ) {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany(queue)
    return findMatchingVouchersForSupplierInvoice(supabase as never, 'company-1', invoice() as never, options)
  }

  it('is not offered where nobody picks: the unattended pass keeps to amount matches', async () => {
    const result = await find([
      { data: [entry()] },
      { data: [line('je-1', 5250)] },
      { data: [] }, // payment rows on the candidates
    ])
    expect(result).toEqual([])
  })

  it('is offered where a person picks, as a weak match carrying the share to state', async () => {
    const result = await find(
      [{ data: [entry()] }, { data: [line('je-1', 5250)] }, { data: [] }, openPeriod],
      { includeShared: true },
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      journal_entry_id: 'je-1',
      ap_debit_amount: 5250,
      settlement_side: 'ap_debit',
      link_amount: 1250,
    })
    // Far under the unattended auto-link bar (0.95) and a "weak match" (< 0.7)
    // to the picker: the amount says nothing about which debts were paid.
    expect(result[0].confidence).toBeLessThan(0.7)
    // The thousands separator is a non-breaking space: match around it.
    expect(result[0].match_reason).toMatch(/^Verifikationen har 5.250,00 SEK kvar, mer än fakturans belopp/)
  })

  it('ranks under a verifikat whose amount is the amount of the invoice', async () => {
    const result = await find(
      [
        { data: [entry({ id: 'je-shared' }), entry({ id: 'je-exact', description: 'Betalning' })] },
        { data: [line('je-shared', 5250), line('je-exact', 1250)] },
        { data: [] },
        openPeriod,
      ],
      { includeShared: true },
    )
    expect(result.map((c) => c.journal_entry_id)).toEqual(['je-exact', 'je-shared'])
    expect(result[0].link_amount).toBeUndefined()
    expect(result[1].link_amount).toBe(1250)
  })

  it('puts the payment run closest to the due date first, not the oldest one in the window', async () => {
    // Weekly payment runs, each larger than the invoice: the one that paid an
    // invoice due 2026-05-01 is far more likely the run of 05-04 than the run
    // of 02-16. Sorted on the entry date alone, a list of ten would start with
    // the oldest runs and could cut the right one.
    const result = await find(
      [
        {
          data: [
            entry({ id: 'je-feb', entry_date: '2026-02-16' }),
            entry({ id: 'je-apr', entry_date: '2026-04-13' }),
            entry({ id: 'je-may', entry_date: '2026-05-04' }),
            entry({ id: 'je-jul', entry_date: '2026-07-20' }),
          ],
        },
        { data: [line('je-feb', 9000), line('je-apr', 7000), line('je-may', 5250), line('je-jul', 8000)] },
        { data: [] },
        openPeriod,
      ],
      { includeShared: true },
    )
    expect(result.map((c) => c.journal_entry_id)).toEqual(['je-may', 'je-apr', 'je-feb', 'je-jul'])
    // Every one of them stays a weak match.
    expect(Math.max(...result.map((c) => c.confidence))).toBeLessThan(0.7)
    expect(Math.min(...result.map((c) => c.confidence))).toBeGreaterThanOrEqual(0.4)
  })

  it('scores a 244x verifikat on what other invoices have left of it', async () => {
    // 4 000 kr of the 5 250 kr are another invoice's: what is left is exactly
    // this invoice, so it is an amount match and needs no stated share.
    const result = await find([
      { data: [entry()] },
      { data: [line('je-1', 5250)] },
      { data: [{ journal_entry_id: 'je-1', supplier_invoice_id: 'si-other', amount: 4000, currency: 'SEK' }] },
      openPeriod,
    ])
    expect(result).toHaveLength(1)
    expect(result[0].ap_debit_amount).toBe(1250)
    expect(result[0].link_amount).toBeUndefined()
    expect(result[0].confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('drops a 244x verifikat other invoices have used in full, and one already linked to this invoice', async () => {
    const usedUp = await find(
      [
        { data: [entry()] },
        { data: [line('je-1', 1250)] },
        { data: [{ journal_entry_id: 'je-1', supplier_invoice_id: 'si-other', amount: 1250, currency: 'SEK' }] },
      ],
      { includeShared: true },
    )
    expect(usedUp).toEqual([])

    const alreadyLinked = await find(
      [
        { data: [entry()] },
        { data: [line('je-1', 5250)] },
        { data: [{ journal_entry_id: 'je-1', supplier_invoice_id: 'si-1', amount: 400, currency: 'SEK' }] },
      ],
      { includeShared: true },
    )
    expect(alreadyLinked).toEqual([])
  })
})
