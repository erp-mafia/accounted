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
import { INVOICE_FULL_COLUMNS, INVOICE_PDF_COLUMNS } from '@/lib/api/v1/invoice-columns'

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

  it('never selects the encrypted personnummer blob', () => {
    expect(INVOICE_FULL_COLUMNS).not.toContain('deduction_personnummer_encrypted')
    expect(INVOICE_PDF_COLUMNS).not.toContain('deduction_personnummer_encrypted')
  })
})
