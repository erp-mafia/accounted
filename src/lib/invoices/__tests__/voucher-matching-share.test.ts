/**
 * One verifikat that settles several customer invoices (crm#1434): the stated
 * share (`amount`) and the capacity rule, in the pre-stage validator and the
 * link call. The customer-side mirror of supplier-voucher-matching-share.
 *
 * The reported case: a company migrated from another system booked one
 * konstaterad kundförlust verifikat for several invoices (Dr 635x, Dr 26xx /
 * Cr 1510 for the sum). The link read the whole 1510 credit as the one
 * invoice's settlement and refused it, so the invoices stayed open in the
 * kundreskontra although the ledger had cleared them. A bankgiro bundle that
 * pays several invoices has the same shape.
 *
 * The RPC is the authority and is pinned against real Postgres in
 * tests/pg/link-invoice-voucher-share.pg.test.ts. What is pinned here is that
 * the TypeScript half gives the same answers before anything is staged, and
 * that the share reaches the RPC only when it is stated. All amounts are
 * synthetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlementById: vi.fn(async () => ({ ok: true, required: false })),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
vi.mock('@/lib/core/documents/customer-invoice-underlag', () => ({
  anchorCustomerInvoiceDocument: vi.fn(),
}))
vi.mock('@/lib/customer-loss/doubtful', () => ({
  releaseDoubtfulReserveAfterChange: vi.fn(),
}))
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  autoReconcileTransactionForLinkedVoucher: vi.fn().mockResolvedValue(null),
}))

import { validateVoucherForInvoiceLink, linkInvoiceToVoucher } from '../voucher-matching'
import { makeInvoice, createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

// invoice_settlement_side rows (supabase.rpc consumes a queue slot like a
// table read).
const AR_CREDIT_ROW = { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' }
const BANK_DEBIT_ROW = { settlement_side: 'bank_debit', account_prefix: '19', entry_side: 'debit' }

const voucher = (sourceType = 'import') => ({
  id: 'je-1',
  voucher_series: 'A',
  voucher_number: 285,
  entry_date: '2025-12-31',
  description: 'Konstaterade kundförluster',
  status: 'posted',
  source_type: sourceType,
  fiscal_period_id: 'fp-1',
  company_id: 'company-1',
})

/** A konstaterad kundförlust for several invoices in one verifikat. */
const lossLines = (total: number) => [
  { account_number: '6351', debit_amount: total * 0.8, credit_amount: 0, currency: 'SEK', amount_in_currency: null },
  { account_number: '2611', debit_amount: total * 0.2, credit_amount: 0, currency: 'SEK', amount_in_currency: null },
  { account_number: '1510', debit_amount: 0, credit_amount: total, currency: 'SEK', amount_in_currency: null },
]

/** Kontantmetoden: one deposit for several never-booked invoices. */
const depositLines = (total: number) => [
  { account_number: '1930', debit_amount: total, credit_amount: 0, currency: 'SEK', amount_in_currency: null },
  { account_number: '3001', debit_amount: 0, credit_amount: total * 0.8, currency: 'SEK', amount_in_currency: null },
  { account_number: '2611', debit_amount: 0, credit_amount: total * 0.2, currency: 'SEK', amount_in_currency: null },
]

/** A payment row another invoice already has on the voucher. */
const otherInvoiceRow = (amount: number, currency = 'SEK') => ({ invoice_id: 'inv-other', amount, currency })

const sekInvoice = (remaining = 1500) =>
  makeInvoice({ id: 'inv-1', total: remaining, paid_amount: 0, remaining_amount: remaining, currency: 'SEK' })

async function validate(
  invoice: ReturnType<typeof makeInvoice>,
  queue: Array<{ data?: unknown; error?: unknown }>,
  amount?: number | null,
) {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  enqueueMany(queue)
  return validateVoucherForInvoiceLink(supabase as never, 'company-1', invoice as never, 'je-1', amount)
}

describe('validateVoucherForInvoiceLink: a verifikat that settles several invoices (151x)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('the report: without a stated share the whole credit is still refused, nothing is split on a guess', async () => {
    const result = await validate(sekInvoice(1500), [
      { data: AR_CREDIT_ROW },
      { data: voucher() },
      { data: lossLines(6000) },
      { data: [] }, // payment rows on the voucher (capacity)
    ])
    // The details are the ones the refusal always had.
    expect(result).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ar_credit: 6000, remaining: 1500 },
    })
  })

  it('the stated share settles the invoice and leaves the rest of the verifikat for the others', async () => {
    const result = await validate(
      sekInvoice(1500),
      [
        { data: AR_CREDIT_ROW },
        { data: voucher() },
        { data: lossLines(6000) },
        { data: [] }, // capacity
        { data: [] }, // already linked to this invoice?
      ],
      1500,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.paymentAmount).toBe(1500)
      expect(result.isFullyPaid).toBe(true)
      expect(result.remainingAfter).toBe(0)
      expect(result.voucherRemainingAfter).toBe(4500)
    }
  })

  it('a share smaller than the invoice is a part settlement', async () => {
    const result = await validate(
      sekInvoice(1500),
      [{ data: AR_CREDIT_ROW }, { data: voucher() }, { data: lossLines(6000) }, { data: [] }, { data: [] }],
      400,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.paymentAmount).toBe(400)
      expect(result.isFullyPaid).toBe(false)
      expect(result.remainingAfter).toBe(1100)
      expect(result.voucherRemainingAfter).toBe(5600)
    }
  })

  it('refuses a share larger than the invoice has left', async () => {
    const result = await validate(
      sekInvoice(1500),
      [{ data: AR_CREDIT_ROW }, { data: voucher() }, { data: lossLines(6000) }, { data: [] }],
      1500.01,
    )
    expect(result).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { amount: 1500.01, remaining: 1500 },
    })
  })

  it('refuses a share larger than the verifikat has left after its other invoices', async () => {
    const result = await validate(
      sekInvoice(1500),
      [{ data: AR_CREDIT_ROW }, { data: voucher() }, { data: lossLines(6000) }, { data: [otherInvoiceRow(5000)] }],
      1500,
    )
    expect(result).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1500, available: 1000, ar_credit: 6000, already_linked: 5000 },
    })
  })

  it('a verifikat whose credit is used up by other invoices has nothing left, with or without a share', async () => {
    for (const amount of [undefined, 500]) {
      const result = await validate(
        sekInvoice(1500),
        [{ data: AR_CREDIT_ROW }, { data: voucher() }, { data: lossLines(6000) }, { data: [otherInvoiceRow(4500), otherInvoiceRow(1500)] }],
        amount,
      )
      expect(result, String(amount)).toEqual({
        ok: false,
        code: 'LINK_VOUCHER_FULLY_ALLOCATED',
        details: { ar_credit: 6000, already_linked: 6000 },
      })
    }
  })

  it('the last invoice takes what is left without a share when it fits', async () => {
    const result = await validate(sekInvoice(1500), [
      { data: AR_CREDIT_ROW },
      { data: voucher() },
      { data: lossLines(6000) },
      { data: [otherInvoiceRow(4500)] },
      { data: [] },
    ])
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.paymentAmount).toBe(1500)
      expect(result.arCreditAmount).toBe(1500)
      expect(result.voucherRemainingAfter).toBe(0)
    }
  })

  it('before the capacity rule a second invoice could take the same credit in full: no longer', async () => {
    // A 1 500 kr verifikat already linked in full to another 1 500 kr invoice.
    const result = await validate(sekInvoice(1500), [
      { data: AR_CREDIT_ROW },
      { data: voucher('manual') },
      { data: lossLines(1500) },
      { data: [otherInvoiceRow(1500)] },
    ])
    expect(result).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_FULLY_ALLOCATED',
      details: { ar_credit: 1500, already_linked: 1500 },
    })
  })

  it('this invoice\'s own row is the already-linked guard\'s, not capacity', async () => {
    const result = await validate(
      sekInvoice(1500),
      [
        { data: AR_CREDIT_ROW },
        { data: voucher() },
        { data: lossLines(6000) },
        { data: [{ invoice_id: 'inv-1', amount: 1000, currency: 'SEK' }] },
        { data: [{ id: 'pmt-1' }] },
      ],
      500,
    )
    expect(result).toEqual({ ok: false, code: 'LINK_VOUCHER_ALREADY_LINKED' })
  })

  it('rows in another currency leave no readable capacity', async () => {
    const result = await validate(
      sekInvoice(1500),
      [{ data: AR_CREDIT_ROW }, { data: voucher() }, { data: lossLines(6000) }, { data: [otherInvoiceRow(100, 'EUR')] }],
      1500,
    )
    expect(result).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'SEK', reason: 'voucher_settles_other_currency' },
    })
  })

  it('zero, negative, below one öre or not a number is refused before any read', async () => {
    for (const amount of [0, -1500, 0.004, Number.NaN]) {
      const { supabase } = createQueuedMockSupabase()
      const result = await validateVoucherForInvoiceLink(supabase as never, 'company-1', sekInvoice() as never, 'je-1', amount)
      expect(result, String(amount)).toEqual({ ok: false, code: 'LINK_VOUCHER_AMOUNT_INVALID', details: { amount } })
      expect(supabase.from).not.toHaveBeenCalled()
      expect(supabase.rpc).not.toHaveBeenCalled()
    }
  })

  it('reads the share to the öre', async () => {
    const result = await validate(
      sekInvoice(1500),
      [{ data: AR_CREDIT_ROW }, { data: voucher() }, { data: lossLines(6000) }, { data: [] }, { data: [] }],
      1499.996,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.paymentAmount).toBe(1500)
  })
})

describe('validateVoucherForInvoiceLink: a share of a 19xx debit (kontantmetoden)', () => {
  it('names the 19xx side when the share is more than the deposit has left', async () => {
    const result = await validate(
      sekInvoice(1500),
      [{ data: BANK_DEBIT_ROW }, { data: voucher('bank_transaction') }, { data: depositLines(2000) }, { data: [otherInvoiceRow(1000)] }],
      1500,
    )
    expect(result).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 1500, available: 1000, bank_debit: 2000, already_linked: 1000 },
    })
  })
})

describe('validateVoucherForInvoiceLink: a share and a foreign invoice', () => {
  it('a kronor verifikat takes no share of a foreign invoice: the kursdifferens would be a guess', async () => {
    const eur = makeInvoice({ id: 'inv-eur', total: 100, paid_amount: 0, remaining_amount: 100, currency: 'EUR', exchange_rate: 11 })
    const result = await validate(eur, [{ data: AR_CREDIT_ROW }, { data: voucher('manual') }, { data: lossLines(5000) }], 100)
    expect(result).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_CURRENCY_MISMATCH',
      details: { invoice_currency: 'EUR', line_currency: 'SEK', reason: 'amount_needs_invoice_currency' },
    })
  })
})

describe('linkInvoiceToVoucher: the share reaches the RPC only when stated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  const rpcOk = (voucherRemaining?: number) => ({
    data: {
      ok: true,
      payment_id: 'pay-1',
      invoice_status: 'paid',
      paid_amount: 1500,
      remaining_amount: 0,
      payment_amount: 1500,
      journal_entry_id: 'je-1',
      currency: 'SEK',
      payment_date: '2025-12-31',
      ...(voucherRemaining === undefined ? {} : { voucher_remaining: voucherRemaining }),
    },
    error: null,
  })

  it('a stated share is sent as p_amount and the rest of the verifikat comes back', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(rpcOk(4500))
    const result = await linkInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      invoiceId: 'inv-1',
      journalEntryId: 'je-1',
      amount: 1500,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.voucherRemaining).toBe(4500)
    expect(supabase.rpc).toHaveBeenCalledWith('link_invoice_to_voucher', {
      p_invoice_id: 'inv-1',
      p_journal_entry_id: 'je-1',
      p_user_id: 'user-1',
      p_company_id: 'company-1',
      p_notes: null,
      p_amount: 1500,
    })
  })

  it('without a share p_amount is not sent, so the call reads the same against an older database', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(rpcOk())
    const result = await linkInvoiceToVoucher(supabase as never, 'user-1', 'company-1', {
      invoiceId: 'inv-1',
      journalEntryId: 'je-1',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.voucherRemaining).toBeNull()
    const linkCall = (supabase.rpc as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      ([fn]) => fn === 'link_invoice_to_voucher',
    )
    expect(linkCall?.[1]).not.toHaveProperty('p_amount')
  })
})
