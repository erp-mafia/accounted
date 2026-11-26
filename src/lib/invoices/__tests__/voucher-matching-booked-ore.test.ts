/**
 * The pre-stage link validator on a SEK customer invoice whose own verifikat
 * booked the öresavrundning (1510 at the rounded "Att betala", the öre on
 * 3740): the voucher that clears what 1510 carries settles the invoice in
 * full, as link_invoice_to_voucher settles it (migration 20261126170500,
 * pinned against real Postgres in
 * tests/pg/link-invoice-voucher-booked-ore.pg.test.ts). What is pinned here is
 * that the TypeScript half gives the same answers before anything is staged.
 * All amounts are synthetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { validateVoucherForInvoiceLink } from '../voucher-matching'
import { makeInvoice, createQueuedMockSupabase } from '@/tests/helpers'

// invoice_settlement_side and document_carried_sek are rpc calls: each takes
// a queue slot like a table read.
const AR_CREDIT_ROW = { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' }

const voucher = {
  id: 'je-1',
  voucher_series: 'A',
  voucher_number: 12,
  entry_date: '2026-03-20',
  description: 'Inbetalning',
  status: 'posted',
  source_type: 'manual',
  fiscal_period_id: 'fp-1',
  company_id: 'company-1',
}

/** A payment booked by hand that clears `amount` off 1510. */
const paymentLines = (amount: number) => [
  { account_number: '1930', debit_amount: amount, credit_amount: 0, currency: 'SEK', amount_in_currency: null },
  { account_number: '1510', debit_amount: 0, credit_amount: amount, currency: 'SEK', amount_in_currency: null },
]

const invoice = (remaining: number, journalEntryId: string | null = 'je-issue') =>
  makeInvoice({ id: 'inv-1', total: remaining, paid_amount: 0, remaining_amount: remaining, currency: 'SEK', journal_entry_id: journalEntryId } as never)

async function validate(
  inv: ReturnType<typeof makeInvoice>,
  queue: Array<{ data?: unknown; error?: unknown }>,
  amount?: number | null,
) {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  enqueueMany(queue)
  return validateVoucherForInvoiceLink(supabase as never, 'company-1', inv as never, 'je-1', amount)
}

/** The reads up to the carried figure: side, voucher, lines, capacity rows. */
const upTo = (amount: number) => [{ data: AR_CREDIT_ROW }, { data: voucher }, { data: paymentLines(amount) }, { data: [] }]

describe('validateVoucherForInvoiceLink: the issue verifikat booked the öresavrundning', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rounded up: 1 000 clears what 1510 carries and settles 999,75 in full', async () => {
    const result = await validate(invoice(999.75), [...upTo(1000), { data: { ok: true, sek: 1000 } }, { data: [] }])
    expect(result).toMatchObject({ ok: true, paymentAmount: 999.75, remainingAfter: 0, isFullyPaid: true, voucherRemainingAfter: 0 })
  })

  it('rounded down: 1 000 clears what 1510 carries and settles 1 000,40 in full', async () => {
    const result = await validate(invoice(1000.4), [...upTo(1000), { data: { ok: true, sek: 1000 } }, { data: [] }])
    expect(result).toMatchObject({ ok: true, paymentAmount: 1000.4, remainingAfter: 0, isFullyPaid: true, voucherRemainingAfter: 0 })
  })

  it('a stated share of the rounded amount settles in full', async () => {
    const result = await validate(invoice(999.75), [...upTo(1000), { data: { ok: true, sek: 1000 } }, { data: [] }], 1000)
    expect(result).toMatchObject({ ok: true, paymentAmount: 999.75, isFullyPaid: true, voucherRemainingAfter: 0 })
  })

  it('a share that settles in full needs what 1510 carries left on the verifikat', async () => {
    const result = await validate(invoice(999.75), [...upTo(999.8), { data: { ok: true, sek: 1000 } }], 999.75)
    expect(result).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
      details: { amount: 999.75, receivable: 1000, available: 999.8, ar_credit: 999.8, already_linked: 0 },
    })
  })

  it('a part payment links as before', async () => {
    const result = await validate(invoice(1000.4), [...upTo(400), { data: { ok: true, sek: 1000 } }, { data: [] }])
    expect(result).toMatchObject({ ok: true, paymentAmount: 400, remainingAfter: 600.4, isFullyPaid: false, voucherRemainingAfter: 0 })
  })

  it('an invoice whose 1510 carries the remainder still refuses the rounded payment', async () => {
    const result = await validate(invoice(999.75), [...upTo(1000), { data: { ok: true, sek: 999.75 } }])
    expect(result).toEqual({
      ok: false,
      code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      details: { ar_credit: 1000, remaining: 999.75 },
    })
  })

  it('a failed carried read judges the link on the remainder, as before', async () => {
    const result = await validate(invoice(999.75), [...upTo(1000), { error: { message: 'boom' } }])
    expect(result).toMatchObject({ ok: false, code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING' })
  })

  it('an invoice without a verifikat costs no carried read', async () => {
    const result = await validate(invoice(999.75, null), [...upTo(1000)])
    expect(result).toMatchObject({ ok: false, code: 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING' })
  })
})
