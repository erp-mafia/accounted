import { describe, it, expect } from 'vitest'
import {
  BACKFILL_NOTES_TAG,
  planInvoicePaymentBackfill,
  settlementSekFromLines,
  type BackfillInvoice,
  type BackfillVoucher,
} from '../backfill-invoice-payment-rows'

const invoice = (over: Partial<BackfillInvoice> = {}): BackfillInvoice => ({
  id: 'inv-1',
  company_id: 'co-1',
  user_id: 'user-1',
  invoice_number: '001',
  status: 'paid',
  document_type: 'invoice',
  currency: 'SEK',
  exchange_rate: null,
  paid_amount: 12500,
  paid_at: '2026-08-28T12:00:00+00:00',
  ...over,
})

const NONE = { count: 0, sum: 0 }

const voucher = (over: Partial<BackfillVoucher> = {}): BackfillVoucher => ({
  id: 'je-1',
  source_id: 'inv-1',
  source_type: 'invoice_cash_payment',
  status: 'posted',
  entry_date: '2026-08-28',
  settlement_sek: 12500,
  ...over,
})

describe('planInvoicePaymentBackfill', () => {
  it('plans one tagged row from the single posted payment voucher', () => {
    const plan = planInvoicePaymentBackfill(invoice(), [voucher()], NONE)
    expect(plan).toEqual({
      kind: 'insert',
      row: {
        user_id: 'user-1',
        company_id: 'co-1',
        invoice_id: 'inv-1',
        payment_date: '2026-08-28',
        amount: 12500,
        currency: 'SEK',
        exchange_rate: null,
        journal_entry_id: 'je-1',
        transaction_id: null,
        notes: expect.stringContaining(BACKFILL_NOTES_TAG),
      },
    })
  })

  it('takes the payment date from the voucher, never from paid_at', () => {
    const partial = planInvoicePaymentBackfill(
      invoice({ status: 'partially_paid', paid_amount: 5000, paid_at: null }),
      [voucher({ source_type: 'invoice_paid', entry_date: '2026-08-20', settlement_sek: 5000 })],
      NONE,
    )
    expect(partial).toMatchObject({ kind: 'insert', row: { payment_date: '2026-08-20', amount: 5000 } })

    // Pre-#1332 paid_at was the wall-clock registration time: a December
    // payment booked in January must stay in December.
    const registeredLater = planInvoicePaymentBackfill(
      invoice({ paid_at: '2026-01-08T09:12:44Z' }),
      [voucher({ entry_date: '2025-12-30' })],
      NONE,
    )
    expect(registeredLater).toMatchObject({ kind: 'insert', row: { payment_date: '2025-12-30' } })
  })

  it('keeps the invoice currency and rate on the row', () => {
    const plan = planInvoicePaymentBackfill(
      invoice({ currency: 'EUR', exchange_rate: 11.5, paid_amount: 1000 }),
      [voucher({ source_type: 'invoice_paid', settlement_sek: 11500 })],
      NONE,
    )
    expect(plan).toMatchObject({
      kind: 'insert',
      row: { currency: 'EUR', exchange_rate: 11.5, amount: 1000 },
    })
  })

  it('skips invoices that already have a sub-ledger row', () => {
    expect(planInvoicePaymentBackfill(invoice(), [voucher()], { count: 1, sum: 12500 })).toEqual({
      kind: 'skip',
      reason: 'has_rows',
    })
  })

  it('reports rows that sum to less than paid_amount instead of patching the difference', () => {
    // Manual partial 4 000 (no row) followed by a bank-matched 6 000 (row).
    expect(
      planInvoicePaymentBackfill(
        invoice({ paid_amount: 10000 }),
        [voucher(), voucher({ id: 'je-bank' })],
        { count: 1, sum: 6000 },
      ),
    ).toEqual({ kind: 'skip', reason: 'rows_short' })
    // Öre noise is not a shortfall.
    expect(
      planInvoicePaymentBackfill(invoice({ paid_amount: 10000 }), [voucher()], { count: 1, sum: 9999.996 }),
    ).toEqual({ kind: 'skip', reason: 'has_rows' })
  })

  it('skips non-invoices, unpaid invoices and zero paid amounts', () => {
    expect(planInvoicePaymentBackfill(invoice({ document_type: 'proforma' }), [voucher()], NONE))
      .toMatchObject({ kind: 'skip', reason: 'not_invoice' })
    expect(planInvoicePaymentBackfill(invoice({ status: 'sent' }), [voucher()], NONE))
      .toMatchObject({ kind: 'skip', reason: 'not_paid' })
    expect(planInvoicePaymentBackfill(invoice({ paid_amount: 0 }), [voucher()], NONE))
      .toMatchObject({ kind: 'skip', reason: 'no_paid_amount' })
  })

  it('refuses a row whose amount the voucher never booked', () => {
    // Header says 12 500 paid, the clearing entry credited 1510 with 12 000.
    expect(
      planInvoicePaymentBackfill(invoice(), [voucher({ settlement_sek: 12000 })], NONE),
    ).toEqual({ kind: 'skip', reason: 'voucher_amount_mismatch', voucherIds: ['je-1'] })
    // Öre absorption on 3740 (voucher 12 500.40 vs paid 12 500) is inside the band.
    expect(
      planInvoicePaymentBackfill(invoice(), [voucher({ settlement_sek: 12500.4 })], NONE),
    ).toMatchObject({ kind: 'insert' })
    // Foreign currency: SEK leg checked through the invoice rate within 1 %.
    expect(
      planInvoicePaymentBackfill(
        invoice({ currency: 'EUR', exchange_rate: 11.5, paid_amount: 1000 }),
        [voucher({ settlement_sek: 11000 })],
        NONE,
      ),
    ).toEqual({ kind: 'skip', reason: 'voucher_amount_mismatch', voucherIds: ['je-1'] })
    // No rate and no readable settlement leg cannot be verified.
    expect(
      planInvoicePaymentBackfill(
        invoice({ currency: 'EUR', exchange_rate: null, paid_amount: 1000 }),
        [voucher({ settlement_sek: 11500 })],
        NONE,
      ),
    ).toEqual({ kind: 'skip', reason: 'voucher_amount_unverifiable', voucherIds: ['je-1'] })
    expect(
      planInvoicePaymentBackfill(invoice(), [voucher({ settlement_sek: null })], NONE),
    ).toEqual({ kind: 'skip', reason: 'voucher_amount_unverifiable', voucherIds: ['je-1'] })
  })

  it('reads the applied amount from the 1510 credit, else from the settlement debit', () => {
    expect(
      settlementSekFromLines([
        { account_number: '1930', debit_amount: 12500.4, credit_amount: 0 },
        { account_number: '1510', debit_amount: 0, credit_amount: 12500 },
        { account_number: '3740', debit_amount: 0, credit_amount: 0.4 },
      ]),
    ).toBe(12500)
    // Kontantmetoden ROT: the 1513 leg is Skatteverket's share, not customer money.
    expect(
      settlementSekFromLines([
        { account_number: '1930', debit_amount: 17500, credit_amount: 0 },
        { account_number: '1513', debit_amount: 7500, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 20000 },
        { account_number: '2611', debit_amount: 0, credit_amount: 5000 },
      ]),
    ).toBe(17500)
    expect(
      settlementSekFromLines([
        { account_number: '1686', debit_amount: 1250, credit_amount: 0 },
        { account_number: '3001', debit_amount: 0, credit_amount: 1250 },
      ]),
    ).toBe(1250)
    expect(settlementSekFromLines([])).toBeNull()
  })

  it('reports a row that would land in a closed or locked period instead of writing it', () => {
    const closedBefore2026 = (date: string) => date < '2026-01-01'
    expect(
      planInvoicePaymentBackfill(
        invoice(),
        [voucher({ entry_date: '2025-12-30' })],
        NONE,
        { isPeriodClosed: closedBefore2026 },
      ),
    ).toEqual({ kind: 'skip', reason: 'period_closed', voucherIds: ['je-1'] })
    expect(
      planInvoicePaymentBackfill(invoice(), [voucher()], NONE, { isPeriodClosed: closedBefore2026 }),
    ).toMatchObject({ kind: 'insert', row: { payment_date: '2026-08-28' } })
  })

  it('never guesses the voucher: zero or several posted payment vouchers are skipped', () => {
    expect(planInvoicePaymentBackfill(invoice(), [], NONE)).toEqual({
      kind: 'skip',
      reason: 'no_payment_voucher',
    })
    // A reversed voucher, a registration entry and a voucher of another
    // invoice are not payment vouchers of this one.
    expect(
      planInvoicePaymentBackfill(
        invoice(),
        [
          voucher({ status: 'reversed' }),
          voucher({ id: 'je-reg', source_type: 'invoice_created' }),
          voucher({ id: 'je-other', source_id: 'inv-2' }),
        ],
        NONE,
      ),
    ).toEqual({ kind: 'skip', reason: 'no_payment_voucher' })
    expect(
      planInvoicePaymentBackfill(invoice(), [voucher(), voucher({ id: 'je-2' })], NONE),
    ).toEqual({ kind: 'skip', reason: 'multiple_payment_vouchers', voucherIds: ['je-1', 'je-2'] })
  })
})
