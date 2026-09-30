/**
 * #2955: a manual payment of a foreign-currency supplier invoice clears the
 * SEK its linked vouchers carry on 244x, never the invoice-currency figure.
 *
 * The loader runs against the queued Supabase mock: each query takes the next
 * queued result, so the enqueue order below is the loader's read order:
 *   1. the registration verifikat (plus its corrections when stornoed)
 *   2. another invoice naming the same registration verifikat?
 *   3. this invoice's payment rows
 *   4. per chunk of payment vouchers: their status, a stornoed one's
 *      correction chain, then sharing
 *   5. the 244x lines of the live registration and the payment vouchers
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import { buildSupplierInvoicePaymentLines } from '../supplier-invoice-entries'
import { MAX_CHAIN_WALK } from '@/lib/core/bookkeeping/correction-chain'
import {
  CHAIN_HOP_BUDGET,
  MAX_PAYMENT_ROWS,
  loadSupplierInvoiceRemainingSek,
  prorateSupplierPaymentSek,
  resolveSupplierPaymentSek,
  supplierPaymentSekInputIssue,
} from '../supplier-payment-amounts'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const COMPANY = 'company-1'

// The ticket's invoice: 37.50 USD at 9.6414, registered at 361.55 kr on 2440.
function usdInvoice(overrides: Parameters<typeof makeSupplierInvoice>[0] = {}) {
  return makeSupplierInvoice({
    id: 'si-usd',
    currency: 'USD',
    exchange_rate: 9.6414,
    subtotal: 37.5,
    vat_amount: 0,
    total: 37.5,
    total_sek: 361.55,
    remaining_amount: 37.5,
    paid_amount: 0,
    registration_journal_entry_id: 'je-reg',
    ...overrides,
  })
}

const apLine = (id: string, entry: string, debit: number, credit: number) => ({
  id,
  journal_entry_id: entry,
  debit_amount: debit,
  credit_amount: credit,
})

/** An open invoice whose registration is posted and that has no payments yet. */
function enqueueFreshLedger(registrationCreditSek: number) {
  enqueue({ data: { id: 'je-reg', status: 'posted' } })
  enqueue({ data: [] }) // no other invoice on the registration
  enqueue({ data: [] }) // no payment rows
  enqueue({ data: [apLine('l-1', 'je-reg', 0, registrationCreditSek)] })
}

beforeEach(() => {
  reset()
})

describe('prorateSupplierPaymentSek', () => {
  it('a full settlement clears exactly the SEK left on 244x', () => {
    expect(prorateSupplierPaymentSek({ amount: 37.5, remaining: 37.5, remainingSek: 361.55 })).toBe(361.55)
  })

  it('a partial then the rest leaves nothing on 244x', () => {
    const first = prorateSupplierPaymentSek({ amount: 12.5, remaining: 37.5, remainingSek: 361.55 })
    expect(first).toBe(120.52)
    const rest = prorateSupplierPaymentSek({ amount: 25, remaining: 25, remainingSek: 361.55 - first })
    expect(rest).toBe(241.03)
    expect(Math.round((first + rest) * 100) / 100).toBe(361.55)
  })
})

describe('supplierPaymentSekInputIssue', () => {
  it('accepts amount_sek on a foreign invoice and anything without it', () => {
    expect(supplierPaymentSekInputIssue({ currency: 'USD', amountSek: 365 })).toBeNull()
    expect(supplierPaymentSekInputIssue({ currency: 'SEK', exchangeRateDifference: 0 })).toBeNull()
  })

  it.each([
    [{ currency: 'SEK', amountSek: 100 }],
    [{ currency: 'USD', amountSek: 100, exchangeRateDifference: 0 }],
    [{ currency: 'USD', amountSek: 100, hasLines: true }],
  ])('refuses %j', (input) => {
    expect(supplierPaymentSekInputIssue(input)?.field).toBe('amount_sek')
  })
})

describe('resolveSupplierPaymentSek', () => {
  it('a SEK invoice passes its amount through without reading the ledger', async () => {
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, makeSupplierInvoice(), {
      amount: 10000,
    })
    expect(result).toEqual({ ok: true, clearingSek: 10000, exchangeRateDifference: undefined })
    expect(findCalls('journal_entries', 'select')).toHaveLength(0)
  })

  it('the ticket: 37.50 USD fully settled clears 361.55 kr, and the verifikat says so', async () => {
    enqueueFreshLedger(361.55)
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), { amount: 37.5 })
    expect(result).toEqual({ ok: true, clearingSek: 361.55, exchangeRateDifference: undefined })
    if (!result.ok) throw new Error('unreachable')

    const { lines } = buildSupplierInvoicePaymentLines(usdInvoice(), {
      paymentAmount: result.clearingSek,
      exchangeRateDifference: result.exchangeRateDifference,
      paymentAccount: '1686',
    })
    expect(lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2440', 361.55, 0],
      ['1686', 0, 361.55],
    ])
  })

  it('reads 244x off the vouchers, not the rate: per-line rounding is cleared to the öre', async () => {
    // Registration credited 742.12 (per-line rounding) while 76.97 x 9.6418
    // rounds to 742.13: the rate would strand an öre on 2440.
    enqueueFreshLedger(742.12)
    const result = await resolveSupplierPaymentSek(
      supabase as never,
      COMPANY,
      usdInvoice({ total: 76.97, remaining_amount: 76.97, exchange_rate: 9.6418 }),
      { amount: 76.97 },
    )
    expect(result).toMatchObject({ ok: true, clearingSek: 742.12 })
  })

  it.each([
    [365, -3.45, '7960'],
    [358, 3.55, '3960'],
  ])('amount_sek %d books the difference to the cleared SEK (%d) on %s', async (amountSek, diff, account) => {
    enqueueFreshLedger(361.55)
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), {
      amount: 37.5,
      amountSek,
    })
    expect(result).toEqual({ ok: true, clearingSek: 361.55, exchangeRateDifference: diff })
    if (!result.ok) throw new Error('unreachable')

    const { lines } = buildSupplierInvoicePaymentLines(usdInvoice(), {
      paymentAmount: result.clearingSek,
      exchangeRateDifference: result.exchangeRateDifference,
    })
    expect(lines.find((l) => l.account_number === '2440')?.debit_amount).toBe(361.55)
    expect(lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(amountSek)
    const fx = lines.find((l) => l.account_number === account)
    expect(fx?.debit_amount || fx?.credit_amount).toBe(Math.abs(diff))
  })

  it('keeps a legacy exchange_rate_difference on the SEK cleared from the ledger', async () => {
    enqueueFreshLedger(361.55)
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), {
      amount: 37.5,
      exchangeRateDifference: -2,
    })
    expect(result).toEqual({ ok: true, clearingSek: 361.55, exchangeRateDifference: -2 })
  })

  it('an earlier bank-matched partial at another rate is subtracted as booked, and the rest clears exactly', async () => {
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'p-1', amount: 12.5, journal_entry_id: 'je-pay-1' }] })
    enqueue({ data: [{ id: 'je-pay-1', status: 'posted' }] })
    enqueue({ data: [] }) // the payment voucher settles no other invoice
    enqueue({
      data: [apLine('l-1', 'je-reg', 0, 361.55), apLine('l-2', 'je-pay-1', 125, 0)],
    })
    const result = await resolveSupplierPaymentSek(
      supabase as never,
      COMPANY,
      usdInvoice({ paid_amount: 12.5, remaining_amount: 25, status: 'partially_paid' }),
      { amount: 25 },
    )
    expect(result).toMatchObject({ ok: true, clearingSek: 236.55 })
  })

  it('a stornoed registration is followed to its correction, whose 244x is the skuld now', async () => {
    // The original booked 37.50 kr (no rate); its rättelse books 361.55 kr.
    enqueue({ data: { id: 'je-reg', status: 'reversed' } })
    enqueue({ data: [{ id: 'je-corr' }] })
    enqueue({ data: { id: 'je-corr', status: 'posted' } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [apLine('l-9', 'je-corr', 0, 361.55)] })
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), { amount: 37.5 })
    expect(result).toMatchObject({ ok: true, clearingSek: 361.55 })
    // Lines are read for the live correction, not the reversed original.
    const lineRead = findCalls('journal_entry_lines', 'in')[0]
    expect(lineRead).toEqual(['journal_entry_id', ['je-corr']])
  })

  it('a ledger skuld far from the invoice rate is refused, not booked as a kursdifferens', async () => {
    // 99.58 USD at 9.2738 owes 923.49 kr, but the registration was corrected
    // to omvänd skattskyldighet and its rättelse credits 2440 only 738.75 kr.
    // Paying 930 kr would otherwise book 191.25 kr on 7960 as a kursförlust.
    enqueue({ data: { id: 'je-reg', status: 'reversed' } })
    enqueue({ data: [{ id: 'je-corr' }] })
    enqueue({ data: { id: 'je-corr', status: 'posted' } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [apLine('l-9', 'je-corr', 0, 738.75)] })
    const result = await resolveSupplierPaymentSek(
      supabase as never,
      COMPANY,
      usdInvoice({ total: 99.58, remaining_amount: 99.58, exchange_rate: 9.2738 }),
      { amount: 99.58, amountSek: 930 },
    )
    expect(result).toEqual({
      ok: false,
      code: 'SI_PAID_SEK_UNRESOLVED',
      details: {
        reason: 'ledger_rate_mismatch',
        invoice_currency: 'USD',
        expected_sek: 923.49,
        ledger_sek: 738.75,
      },
    })
  })

  it('a ledger skuld inside the 10% band still clears what the ledger says', async () => {
    // 37.50 x 9.6414 = 361.55; the registration credited 330 kr (8.7% off).
    enqueueFreshLedger(330)
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), { amount: 37.5 })
    expect(result).toMatchObject({ ok: true, clearingSek: 330 })
  })

  it('a foreign invoice with no registration verifikat uses its own booked rate', async () => {
    const result = await resolveSupplierPaymentSek(
      supabase as never,
      COMPANY,
      usdInvoice({ registration_journal_entry_id: null }),
      { amount: 37.5 },
    )
    expect(result).toEqual({ ok: true, clearingSek: 361.55, exchangeRateDifference: undefined })
  })

  it('a foreign invoice with neither a registration nor a rate is refused, never booked 1:1', async () => {
    const result = await resolveSupplierPaymentSek(
      supabase as never,
      COMPANY,
      usdInvoice({ registration_journal_entry_id: null, exchange_rate: null }),
      { amount: 37.5 },
    )
    expect(result).toMatchObject({ ok: false, code: 'SI_FX_RATE_MISSING' })
  })

  it('an overpayment of a foreign invoice is refused before the ledger is read', async () => {
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), {
      amount: 40,
      amountSek: 385,
    })
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', details: { field: 'amount' } })
    expect(findCalls('journal_entries', 'select')).toHaveLength(0)
  })

  it('an unresolvable ledger is refused with SI_PAID_SEK_UNRESOLVED and its reason', async () => {
    enqueue({ data: { id: 'je-reg', status: 'reversed' } })
    enqueue({ data: [] }) // stornoed with no correction
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), { amount: 37.5 })
    expect(result).toEqual({
      ok: false,
      code: 'SI_PAID_SEK_UNRESOLVED',
      details: { reason: 'registration_voucher_not_live', invoice_currency: 'USD' },
    })
  })
})

describe('loadSupplierInvoiceRemainingSek: contradictions are refused, not guessed', () => {
  const invoice = { id: 'si-usd', paid_amount: 0, registration_journal_entry_id: 'je-reg' }

  it('scopes every read to the company', async () => {
    enqueueFreshLedger(361.55)
    await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, invoice)
    for (const table of ['journal_entries', 'supplier_invoices', 'supplier_invoice_payments']) {
      expect(findCalls(table, 'eq')).toContainEqual(['company_id', COMPANY])
    }
  })

  it('registration verifikat shared with another invoice', async () => {
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [{ id: 'si-other' }] })
    expect(await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, invoice)).toEqual({
      ok: false,
      reason: 'registration_voucher_shared',
    })
  })

  it('payment rows that do not add up to paid_amount', async () => {
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [] })
    enqueue({ data: [] }) // paid 12.50 but no row says so
    expect(
      await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, { ...invoice, paid_amount: 12.5 }),
    ).toEqual({ ok: false, reason: 'payment_history_mismatch' })
  })

  it('a payment voucher reversed with no correction', async () => {
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'p-1', amount: 12.5, journal_entry_id: 'je-pay-1' }] })
    enqueue({ data: [{ id: 'je-pay-1', status: 'reversed' }] })
    enqueue({ data: { id: 'je-pay-1', status: 'reversed' } }) // chain walk
    enqueue({ data: [] }) // no correction
    expect(
      await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, { ...invoice, paid_amount: 12.5 }),
    ).toEqual({ ok: false, reason: 'payment_voucher_not_posted' })
  })

  it('a stornoed payment voucher counts its correction, which carries the payment now', async () => {
    // correctEntry leaves the payment row on the reversed original.
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'p-1', amount: 12.5, journal_entry_id: 'je-pay-1' }] })
    enqueue({ data: [{ id: 'je-pay-1', status: 'reversed' }] })
    enqueue({ data: { id: 'je-pay-1', status: 'reversed' } })
    enqueue({ data: [{ id: 'je-pay-1-corr' }] })
    enqueue({ data: { id: 'je-pay-1-corr', status: 'posted' } })
    enqueue({ data: [] }) // settles no other invoice
    enqueue({ data: [apLine('l-1', 'je-reg', 0, 361.55), apLine('l-2', 'je-pay-1-corr', 120.52, 0)] })
    expect(
      await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, { ...invoice, paid_amount: 12.5 }),
    ).toEqual({ ok: true, remainingSek: 241.03 })
    expect(findCalls('journal_entry_lines', 'in')[0]).toEqual(['journal_entry_id', ['je-reg', 'je-pay-1-corr']])
  })

  it('a batch payment voucher that also settles another invoice', async () => {
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'p-1', amount: 12.5, journal_entry_id: 'je-batch' }] })
    enqueue({ data: [{ id: 'je-batch', status: 'posted' }] })
    enqueue({ data: [{ id: 'p-other' }] })
    expect(
      await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, { ...invoice, paid_amount: 12.5 }),
    ).toEqual({ ok: false, reason: 'payment_voucher_shared' })
  })

  it('nothing left on 244x for an invoice the reskontra calls open', async () => {
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'p-1', amount: 12.5, journal_entry_id: 'je-pay-1' }] })
    enqueue({ data: [{ id: 'je-pay-1', status: 'posted' }] })
    enqueue({ data: [] })
    enqueue({ data: [apLine('l-1', 'je-reg', 0, 361.55), apLine('l-2', 'je-pay-1', 361.55, 0)] })
    expect(
      await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, { ...invoice, paid_amount: 12.5 }),
    ).toEqual({ ok: false, reason: 'no_liability_left' })
  })
})

describe('loadSupplierInvoiceRemainingSek: the work one resolution does is bounded', () => {
  const invoice = { id: 'si-usd', paid_amount: 0, registration_journal_entry_id: 'je-reg' }

  it('reads the payment rows in one query capped one past MAX_PAYMENT_ROWS', async () => {
    enqueueFreshLedger(361.55)
    await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, invoice)
    expect(findCalls('supplier_invoice_payments', 'limit')).toContainEqual([MAX_PAYMENT_ROWS + 1])
    expect(findCalls('supplier_invoice_payments', 'range')).toHaveLength(0)
  })

  it('more payment rows than the cap are refused before any voucher is read', async () => {
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [] })
    const rows = Array.from({ length: MAX_PAYMENT_ROWS + 1 }, (_, i) => ({
      id: `p-${i}`,
      amount: 0.01,
      journal_entry_id: `je-pay-${i}`,
    }))
    enqueue({ data: rows })
    expect(
      await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, {
        ...invoice,
        paid_amount: roundTo2(0.01 * rows.length),
      }),
    ).toEqual({ ok: false, reason: 'ledger_history_too_long' })
    // Only the registration lookup touched journal_entries; no line read.
    expect(findCalls('journal_entries', 'select')).toHaveLength(1)
    expect(findCalls('journal_entry_lines', 'select')).toHaveLength(0)
  })

  it('storno walks share one hop budget across the registration and every payment voucher', async () => {
    // A registration corrected MAX_CHAIN_WALK times uses MAX_CHAIN_WALK + 1
    // hops; a stornoed payment voucher then needs more than the budget left.
    enqueue({ data: { id: 'je-reg', status: 'reversed' } })
    for (let i = 1; i <= MAX_CHAIN_WALK; i++) {
      enqueue({ data: [{ id: `je-reg-${i}` }] })
      enqueue({ data: { id: `je-reg-${i}`, status: i === MAX_CHAIN_WALK ? 'posted' : 'reversed' } })
    }
    enqueue({ data: [] }) // no other invoice on the registration
    const payments = Array.from({ length: 5 }, (_, i) => ({
      id: `p-${i}`,
      amount: 1,
      journal_entry_id: `je-pay-${i}`,
    }))
    enqueue({ data: payments })
    enqueue({ data: payments.map((p) => ({ id: p.journal_entry_id, status: 'reversed' })) })
    for (let i = 0; i < 5; i++) {
      enqueue({ data: { id: `je-pay-${i}`, status: 'reversed' } })
      enqueue({ data: [{ id: `je-pay-${i}-corr` }] })
      enqueue({ data: { id: `je-pay-${i}-corr`, status: 'posted' } })
    }
    expect(
      await loadSupplierInvoiceRemainingSek(supabase as never, COMPANY, { ...invoice, paid_amount: 5 }),
    ).toEqual({ ok: false, reason: 'ledger_history_too_long' })
    expect(findCalls('journal_entry_lines', 'select')).toHaveLength(0)
    expect(CHAIN_HOP_BUDGET).toBe(2 * MAX_CHAIN_WALK)
  })
})

function roundTo2(x: number): number {
  return Math.round(x * 100) / 100
}
