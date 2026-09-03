import { describe, it, expect } from 'vitest'
import {
  BACKFILL_NOTES_TAG,
  planInvoicePaymentBackfill,
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

const voucher = (over: Partial<BackfillVoucher> = {}): BackfillVoucher => ({
  id: 'je-1',
  source_id: 'inv-1',
  source_type: 'invoice_cash_payment',
  status: 'posted',
  entry_date: '2026-08-28',
  ...over,
})

describe('planInvoicePaymentBackfill', () => {
  it('plans one tagged row from the single posted payment voucher', () => {
    const plan = planInvoicePaymentBackfill(invoice(), [voucher()], 0)
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

  it('takes the payment date from paid_at, falling back to the voucher date on a partial', () => {
    const partial = planInvoicePaymentBackfill(
      invoice({ status: 'partially_paid', paid_amount: 5000, paid_at: null }),
      [voucher({ source_type: 'invoice_paid', entry_date: '2026-08-20' })],
      0,
    )
    expect(partial).toMatchObject({ kind: 'insert', row: { payment_date: '2026-08-20', amount: 5000 } })

    const mismatch = planInvoicePaymentBackfill(
      invoice({ paid_at: '2026-08-30T12:00:00Z' }),
      [voucher({ entry_date: '2026-08-28' })],
      0,
    )
    expect(mismatch).toMatchObject({ kind: 'insert', row: { payment_date: '2026-08-30' } })
  })

  it('keeps the invoice currency and rate on the row', () => {
    const plan = planInvoicePaymentBackfill(
      invoice({ currency: 'EUR', exchange_rate: 11.5, paid_amount: 1000 }),
      [voucher({ source_type: 'invoice_paid' })],
      0,
    )
    expect(plan).toMatchObject({
      kind: 'insert',
      row: { currency: 'EUR', exchange_rate: 11.5, amount: 1000 },
    })
  })

  it('skips invoices that already have a sub-ledger row', () => {
    expect(planInvoicePaymentBackfill(invoice(), [voucher()], 1)).toEqual({
      kind: 'skip',
      reason: 'has_rows',
    })
  })

  it('skips non-invoices, unpaid invoices and zero paid amounts', () => {
    expect(planInvoicePaymentBackfill(invoice({ document_type: 'proforma' }), [voucher()], 0))
      .toMatchObject({ kind: 'skip', reason: 'not_invoice' })
    expect(planInvoicePaymentBackfill(invoice({ status: 'sent' }), [voucher()], 0))
      .toMatchObject({ kind: 'skip', reason: 'not_paid' })
    expect(planInvoicePaymentBackfill(invoice({ paid_amount: 0 }), [voucher()], 0))
      .toMatchObject({ kind: 'skip', reason: 'no_paid_amount' })
  })

  it('never guesses the voucher: zero or several posted payment vouchers are skipped', () => {
    expect(planInvoicePaymentBackfill(invoice(), [], 0)).toEqual({
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
        0,
      ),
    ).toEqual({ kind: 'skip', reason: 'no_payment_voucher' })
    expect(
      planInvoicePaymentBackfill(invoice(), [voucher(), voucher({ id: 'je-2' })], 0),
    ).toEqual({ kind: 'skip', reason: 'multiple_payment_vouchers', voucherIds: ['je-1', 'je-2'] })
  })
})
