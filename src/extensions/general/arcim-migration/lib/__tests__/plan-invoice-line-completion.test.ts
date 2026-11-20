import { describe, it, expect } from 'vitest'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { planInvoiceLineCompletion, type CandidateRow } from '../complete-invoice-lines'

/**
 * The per-invoice planner the hourly completion worker runs on every joined,
 * hydrated invoice: write the rows only when the provider's total agrees with
 * the stored one and the rows add up to the header the same payload
 * established, and overwrite the header VAT split only when the stored split
 * holds no evidence (the pre-#1745 shape or a null rate).
 */

const amount = (value: number, currencyCode = 'SEK') => ({ value, currencyCode })

/** A hydrated Fortnox-shaped invoice: 1 000 kr net, 25 % VAT, 1 250 kr total. */
function providerInvoice(overrides: Partial<SalesInvoiceDto> = {}): SalesInvoiceDto {
  return {
    id: '1001',
    invoiceNumber: '1001',
    issueDate: '2026-03-14',
    currencyCode: 'SEK',
    status: 'paid',
    supplier: { name: 'Leverantör AB', identifications: [] },
    customer: { name: 'Kund AB', identifications: [] },
    lines: [
      {
        id: '1',
        description: 'Konsulttid',
        quantity: 10,
        unitCode: 'h',
        unitPrice: amount(100),
        lineExtensionAmount: amount(1000),
        taxPercent: 25,
      },
    ],
    taxTotal: { taxAmount: amount(250) },
    legalMonetaryTotal: {
      lineExtensionAmount: amount(1000),
      taxInclusiveAmount: amount(1250),
      payableAmount: amount(1250),
    },
    paymentStatus: { paid: true, balance: amount(0) },
    ...overrides,
  }
}

/** A stored row as the pre-#1745 import left it: 25 % label, 0 kr VAT, no rows. */
function storedRow(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: '1001',
    invoice_date: '2026-03-14',
    total: 1250,
    subtotal: 1250,
    vat_amount: 0,
    vat_rate: 25,
    vat_treatment: 'standard_25',
    currency: 'SEK',
    exchange_rate: null,
    invoice_items: [],
    ...overrides,
  }
}

function planned(row: CandidateRow, dto: SalesInvoiceDto) {
  const result = planInvoiceLineCompletion(row, dto, 'co-1')
  if (!('plan' in result)) throw new Error(`expected a plan, got ${result.reason}`)
  return result.plan
}

describe('planInvoiceLineCompletion', () => {
  it('plans the rows and fills a header that held no VAT evidence', () => {
    const plan = planned(storedRow(), providerInvoice())

    expect(plan.items).toEqual([{
      sort_order: 1,
      description: 'Konsulttid',
      quantity: 10,
      unit: 'h',
      unit_price: 100,
      line_total: 1000,
      vat_rate: 25,
      vat_amount: 250,
      line_type: 'product',
    }])
    // The RPC stamps invoice_id itself.
    expect(plan.items[0]).not.toHaveProperty('invoice_id')
    expect(plan.header).toEqual({
      subtotal: 1000,
      subtotal_sek: 1000,
      vat_amount: 250,
      vat_amount_sek: 250,
      vat_rate: 25,
      vat_treatment: 'standard_25',
    })
    // Never the total or the status.
    expect(Object.keys(plan.header!)).not.toContain('total')
    expect(Object.keys(plan.header!)).not.toContain('status')
  })

  it('plans the rows but leaves a header whose split is consistent (momsfri)', () => {
    const plan = planned(storedRow({ vat_rate: 0, vat_amount: 0, subtotal: 1250 }), providerInvoice())

    expect(plan.items).toHaveLength(1)
    expect(plan.header).toBeNull()
  })

  it('fills a header whose rate is null (the post-#1745 "source did not say")', () => {
    const plan = planned(storedRow({ vat_rate: null, vat_amount: 0, subtotal: 1250 }), providerInvoice())

    expect(plan.header).toMatchObject({ vat_rate: 25, vat_amount: 250, subtotal: 1000 })
  })

  it('derives the SEK twins from the rate the row already carries', () => {
    const plan = planned(
      storedRow({ currency: 'EUR', exchange_rate: 11.2, total: 1250 }),
      providerInvoice({ currencyCode: 'EUR' }),
    )

    expect(plan.header).toMatchObject({ subtotal: 1000, subtotal_sek: 11200, vat_amount: 250, vat_amount_sek: 2800 })
  })

  it('refuses rows that do not add up to the header the same payload established', () => {
    // Rows priced with VAT inside, summing to the gross, beside a header that
    // was right: storing them would contradict the invoice's own totals.
    const dto = providerInvoice({
      lines: [
        { id: '1', description: 'Mugg', quantity: 1, unitPrice: amount(1250), lineExtensionAmount: amount(1250), taxPercent: 25 },
      ],
    })

    expect(planInvoiceLineCompletion(storedRow(), dto, 'co-1')).toEqual({ reason: 'rowsMismatch' })
  })

  it('tolerates öresavrundning between the rows and the header', () => {
    // Fortnox rounds Total to whole kronor; the header net absorbs the öre.
    const dto = providerInvoice({
      lines: [{ id: '1', description: 'Konsult', quantity: 1, unitPrice: amount(9810), lineExtensionAmount: amount(9810), taxPercent: 25 }],
      taxTotal: { taxAmount: amount(2452.5) },
      legalMonetaryTotal: { lineExtensionAmount: amount(9810.5), taxInclusiveAmount: amount(12263), payableAmount: amount(12263) },
    })

    expect(planned(storedRow({ total: 12263 }), dto).items).toHaveLength(1)
  })

  it('leaves an invoice untouched when the provider total differs from the stored one', () => {
    expect(planInvoiceLineCompletion(storedRow({ total: 1300, subtotal: 1300 }), providerInvoice(), 'co-1'))
      .toEqual({ reason: 'totalMismatch' })
  })

  it('leaves an invoice untouched when the detail form carries no rows', () => {
    expect(planInvoiceLineCompletion(storedRow(), providerInvoice({ lines: [] }), 'co-1'))
      .toEqual({ reason: 'noLinesAtProvider' })
  })

  it('reverses the rows of a kreditfaktura the way the migration does', () => {
    const plan = planned(
      storedRow({ total: -1250, subtotal: -1250 }),
      providerInvoice({ invoiceTypeCode: '381', status: 'credited' }),
    )

    expect(plan.items[0]).toMatchObject({ quantity: -10, unit_price: 100, line_total: -1000, vat_amount: -250 })
    expect(plan.header).toMatchObject({ subtotal: -1000, vat_amount: -250 })
  })
})
