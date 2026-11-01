/**
 * #2955: a manual payment of a foreign-currency supplier invoice clears the
 * SEK its linked vouchers carry on 244x, never the invoice-currency figure.
 *
 * What the ledger carries is public.document_carried_sek, on real Postgres in
 * tests/pg/document-carried-sek.pg.test.ts: every voucher shape and refusal.
 * Here the door: which question it asks and what it does with the answer.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase, makeSupplierInvoice } from '@/tests/helpers'
import { buildSupplierInvoicePaymentLines } from '../supplier-invoice-entries'
import { resolveSupplierPaymentSek, supplierPaymentSekInputIssue } from '../supplier-payment-amounts'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
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

/** What public.document_carried_sek answers for the invoice. */
function ledgerCarries(sek: number) {
  enqueue({ data: { ok: true, sek } })
}

beforeEach(() => {
  reset()
  supabase.rpc.mockClear()
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
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('the ticket: 37.50 USD fully settled clears 361.55 kr, and the verifikat says so', async () => {
    ledgerCarries(361.55)
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
    ledgerCarries(742.12)
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
    ledgerCarries(361.55)
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
    ledgerCarries(361.55)
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), {
      amount: 37.5,
      exchangeRateDifference: -2,
    })
    expect(result).toEqual({ ok: true, clearingSek: 361.55, exchangeRateDifference: -2 })
  })

  it('asks the ledger for this invoice on this company', async () => {
    ledgerCarries(361.55)
    await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), { amount: 37.5 })
    expect(supabase.rpc).toHaveBeenCalledWith('document_carried_sek', {
      p_company_id: COMPANY,
      p_side: 'supplier',
      p_document_id: 'si-usd',
    })
  })

  it('a part payment clears its share of what the ledger carries, and the rest what is left', async () => {
    ledgerCarries(361.55)
    const part = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), { amount: 12.5 })
    expect(part).toMatchObject({ ok: true, clearingSek: 120.52 })
    ledgerCarries(241.03)
    const rest = await resolveSupplierPaymentSek(
      supabase as never,
      COMPANY,
      usdInvoice({ paid_amount: 12.5, remaining_amount: 25, status: 'partially_paid' }),
      { amount: 25 },
    )
    expect(rest).toMatchObject({ ok: true, clearingSek: 241.03 })
  })

  it('a ledger skuld far from the invoice rate is refused, not booked as a kursdifferens', async () => {
    // 99.58 USD at 9.2738 owes 923.49 kr, but the registration was corrected
    // to omvänd skattskyldighet and its rättelse credits 2440 only 738.75 kr.
    // Paying 930 kr would otherwise book 191.25 kr on 7960 as a kursförlust.
    enqueue({ data: { ok: false, reason: 'ledger_rate_mismatch', expected_sek: 923.49, ledger_sek: 738.75 } })
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
    ledgerCarries(330)
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

  it('an unresolvable ledger is refused with SI_PAID_SEK_UNRESOLVED and its reason', async () => {
    enqueue({ data: { ok: false, reason: 'registration_voucher_not_live' } })
    const result = await resolveSupplierPaymentSek(supabase as never, COMPANY, usdInvoice(), { amount: 37.5 })
    expect(result).toEqual({
      ok: false,
      code: 'SI_PAID_SEK_UNRESOLVED',
      details: { reason: 'registration_voucher_not_live', invoice_currency: 'USD' },
    })
  })
})
