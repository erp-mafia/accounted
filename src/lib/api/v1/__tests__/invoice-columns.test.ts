/**
 * Guards the v1 invoice projections against silently starving the render
 * path. getAmountToPay treats a missing column as "no deduction" / "default
 * rounding" (`deduction_total ?? 0`, `ore_rounding ?? company ?? true`), so a
 * projection that drops one of its inputs does not error: it renders a PDF
 * and a locked Swish QR (editmask 0) with the WRONG amount on that surface
 * only, while the dashboard PDF and the sent email for the same invoice show
 * the deducted "Att betala". That is the exact bug shipped on the v1 pdf
 * route when INVOICE_PDF_COLUMNS predated ROT/RUT and nothing pinned it.
 */
import { describe, expect, it } from 'vitest'
import {
  INVOICE_FULL_COLUMNS,
  INVOICE_ITEM_FULL_COLUMNS,
  INVOICE_PDF_COLUMNS,
} from '@/lib/api/v1/invoice-columns'

/** Columns getAmountToPay + the Swish QR/totals path read off the invoice. */
const AMOUNT_TO_PAY_COLUMNS = ['total', 'currency', 'ore_rounding', 'deduction_total', 'credited_invoice_id']

const parse = (projection: string): string[] => projection.split(',').map((c) => c.trim())

describe('v1 invoice projections feed the render amount path', () => {
  it.each(AMOUNT_TO_PAY_COLUMNS)('INVOICE_PDF_COLUMNS contains %s', (column) => {
    expect(parse(INVOICE_PDF_COLUMNS)).toContain(column)
  })

  it.each(AMOUNT_TO_PAY_COLUMNS)('INVOICE_FULL_COLUMNS contains %s (v1 send renders from it)', (column) => {
    expect(parse(INVOICE_FULL_COLUMNS)).toContain(column)
  })

  it('INVOICE_PDF_COLUMNS carries the display-safe personnummer for the PDF deduction box', () => {
    expect(parse(INVOICE_PDF_COLUMNS)).toContain('deduction_personnummer_last4')
  })

  it('INVOICE_PDF_COLUMNS carries delivery_date (ML 17 kap 24 §: rendered when it differs from invoice_date)', () => {
    expect(parse(INVOICE_PDF_COLUMNS)).toContain('delivery_date')
  })

  // The one payment QR (lib/invoices/payment-qr.ts) reads the invoice's own
  // QR choice and its payment link: without them the v1 render would print
  // another code than the dashboard download and the sent file.
  it.each(['qr_mode', 'payment_link_url'])('INVOICE_PDF_COLUMNS carries %s for the payment QR', (column) => {
    expect(parse(INVOICE_PDF_COLUMNS)).toContain(column)
  })

  it.each(['qr_mode', 'payment_link_url'])('INVOICE_FULL_COLUMNS carries %s (v1 send renders from it)', (column) => {
    expect(parse(INVOICE_FULL_COLUMNS)).toContain(column)
  })

  it('never selects the encrypted personnummer blob', () => {
    expect(INVOICE_FULL_COLUMNS).not.toContain('deduction_personnummer_encrypted')
    expect(INVOICE_PDF_COLUMNS).not.toContain('deduction_personnummer_encrypted')
  })

  // v1 :send books from INVOICE_ITEM_FULL_COLUMNS (markInvoiceSentAndBook):
  // every item column the booking builders read must be in it, or the line
  // books as if the field were empty. Without accrual_* a periodised line
  // books immediate revenue on 30xx instead of 29xx with a schedule.
  it.each([
    'line_type',
    'quantity',
    'unit_price',
    'discount_percent',
    'line_total',
    'vat_rate',
    'vat_amount',
    'revenue_account',
    'article_id',
    'deduction_type',
    'deduction_amount',
    'work_type',
    'dimensions',
    'accrual_period_start',
    'accrual_period_end',
    'accrual_balance_account',
  ])('INVOICE_ITEM_FULL_COLUMNS carries %s (v1 send books from it)', (column) => {
    expect(parse(INVOICE_ITEM_FULL_COLUMNS)).toContain(column)
  })
})
