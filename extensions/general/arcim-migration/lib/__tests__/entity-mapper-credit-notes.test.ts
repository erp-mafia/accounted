import { describe, it, expect } from 'vitest'
import { mapSalesInvoice } from '../entity-mapper'
import type { InvoiceStatusCode, PartyDto, SalesInvoiceDto } from '@/lib/providers/dto'

/**
 * Guards the kreditfaktura shape written by mapSalesInvoice.
 *
 * The mapper used to write `document_type: 'credit_note'`, which
 * invoices_document_type_check refuses (it allows only 'invoice', 'proforma'
 * and 'delivery_note'). Every migrated kreditfaktura was rejected with a 23514
 * and counted as skipped, so the imported AR and revenue were overstated by
 * the credited amounts while the credit notes themselves, which are
 * räkenskapsinformation, never landed.
 *
 * Accounted models a credit note as an ordinary invoice row with reversed
 * amounts (app/api/invoices/route.ts, app/api/v1/.../invoices/[id]/credit) and
 * a `credited_invoice_id` pointing at the invoice it credits.
 */

const party: PartyDto = { name: 'Kund AB', identifications: [] }

/** allow-list of invoices_document_type_check */
const DOCUMENT_TYPES = ['invoice', 'proforma', 'delivery_note']

/** allow-list of invoices_status_check */
const STATUSES = ['draft', 'sent', 'paid', 'partially_paid', 'overdue', 'cancelled', 'credited']

function makeDto(over: {
  status?: InvoiceStatusCode
  invoiceTypeCode?: string
  /** Sign of the amounts as the provider states them: Visma negates, the gateway does not. */
  signOfAmounts?: 1 | -1
  net?: number
  vat?: number
  quantity?: number
  paid?: boolean
  balance?: number
  note?: string
} = {}): SalesInvoiceDto {
  const s = over.signOfAmounts ?? 1
  const net = (over.net ?? 1000) * s
  const vat = (over.vat ?? 250) * s
  const gross = net + vat
  return {
    id: 'inv-1',
    invoiceNumber: 'KF-100',
    issueDate: '2026-03-10',
    dueDate: '2026-04-10',
    invoiceTypeCode: over.invoiceTypeCode,
    currencyCode: 'SEK',
    status: over.status ?? 'credited',
    supplier: party,
    customer: party,
    lines: [
      {
        id: '1',
        description: 'Konsulttimmar',
        quantity: (over.quantity ?? 2) * s,
        unitCode: 'tim',
        unitPrice: { value: (over.net ?? 1000) / (over.quantity ?? 2), currencyCode: 'SEK' },
        lineExtensionAmount: { value: net, currencyCode: 'SEK' },
        taxPercent: 25,
        taxAmount: { value: vat, currencyCode: 'SEK' },
      },
    ],
    taxTotal: { taxAmount: { value: vat, currencyCode: 'SEK' } },
    legalMonetaryTotal: {
      lineExtensionAmount: { value: net, currencyCode: 'SEK' },
      payableAmount: { value: gross, currencyCode: 'SEK' },
    },
    paymentStatus: {
      paid: over.paid ?? false,
      balance: { value: over.balance ?? gross, currencyCode: 'SEK' },
    },
    note: over.note,
  }
}

function map(over: Parameters<typeof makeDto>[0] = {}) {
  return mapSalesInvoice(makeDto(over), 'user-1', 'company-1', 'customer-1')
}

describe('mapSalesInvoice: kreditfaktura', () => {
  it('writes a document_type the invoices CHECK constraint accepts', () => {
    for (const invoiceTypeCode of ['381', '380', undefined]) {
      const { invoice } = map({ invoiceTypeCode })
      expect(invoice.document_type, `invoiceTypeCode=${invoiceTypeCode}`).toBe('invoice')
      expect(DOCUMENT_TYPES).toContain(invoice.document_type as string)
    }
  })

  it('reverses the header amounts, matching an in-app credit note', () => {
    const { invoice } = map({ invoiceTypeCode: '381' })
    expect(invoice.subtotal).toBe(-1000)
    expect(invoice.vat_amount).toBe(-250)
    expect(invoice.total).toBe(-1250)
    // SEK invoice: sekFactor 1, so the SEK columns mirror the stated amounts.
    expect(invoice.subtotal_sek).toBe(-1000)
    expect(invoice.vat_amount_sek).toBe(-250)
    expect(invoice.total_sek).toBe(-1250)
  })

  it('reverses quantity, line total and VAT per item, and keeps the unit price positive', () => {
    const { items } = map({ invoiceTypeCode: '381' })
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(-2)
    expect(items[0].line_total).toBe(-1000)
    expect(items[0].vat_amount).toBe(-250)
    expect(items[0].unit_price).toBe(500)
    expect(items[0].vat_rate).toBe(25)
  })

  it('lands on the same row whether the provider states the credit as negative or positive', () => {
    const stated = map({ invoiceTypeCode: '381', signOfAmounts: -1 })
    const magnitude = map({ invoiceTypeCode: '381', signOfAmounts: 1 })
    expect(stated.invoice).toEqual(magnitude.invoice)
    expect(stated.items).toEqual(magnitude.items)
  })

  it('resolves the VAT rate on a credit note the provider states negatively', () => {
    // resolveInvoiceVat divides VAT by subtotal, which classifies only when
    // both are positive: a negatively stated credit note used to land at
    // vat_rate null even though the payload said 25 %.
    const { invoice, vatUnresolved } = map({ invoiceTypeCode: '381', signOfAmounts: -1 })
    expect(invoice.vat_rate).toBe(25)
    expect(invoice.vat_treatment).toBe('standard_25')
    expect(vatUnresolved).toBe(false)
  })

  it('forces the terminal status whatever lifecycle status the provider sends', () => {
    for (const status of ['draft', 'sent', 'booked', 'paid', 'overdue'] as InvoiceStatusCode[]) {
      const { invoice } = map({ invoiceTypeCode: '381', status, paid: true, balance: 0 })
      expect(invoice.status, `status=${status}`).toBe('credited')
      expect(STATUSES).toContain(invoice.status as string)
    }
  })

  it('collects nothing on a credit note', () => {
    const { invoice } = map({ invoiceTypeCode: '381', paid: true, balance: 0 })
    expect(invoice.paid_at).toBeNull()
    expect(invoice.paid_amount).toBe(0)
    expect(invoice.remaining_amount).toBe(0)
  })

  it('imports the credit note unlinked, and reports it as such', () => {
    // No provider DTO carries a reference to the credited invoice, so there is
    // nothing to match on: zero candidates, and the row is written without a
    // credited_invoice_id rather than paired by guesswork. The flag is what
    // the migration summary counts.
    const { invoice, creditNoteUnlinked } = map({ invoiceTypeCode: '381' })
    expect(creditNoteUnlinked).toBe(true)
    expect(invoice).not.toHaveProperty('credited_invoice_id')
  })

  it('writes the missing-reference disclosure into notes, durably', () => {
    // ML 17 kap 22-23 § wants a kreditfaktura to reference the invoice it
    // credits, and BFL 5 kap 6-7 § wants a verifikation to reference its
    // underlag. The wizard's count is an ephemeral result screen, so the gap
    // has to be legible on the record itself years later.
    const { invoice } = map({ invoiceTypeCode: '381' })
    expect(invoice.notes).toContain('Referens till ursprungsfakturan')
  })

  it('preserves the provider note alongside the disclosure', () => {
    const { invoice } = map({ invoiceTypeCode: '381', note: 'Kreditering enligt overenskommelse' })
    expect(invoice.notes).toContain('Kreditering enligt overenskommelse')
    expect(invoice.notes).toContain('Referens till ursprungsfakturan')
  })

  it('leaves an ordinary invoice note untouched', () => {
    const { invoice } = map({ note: 'Tack for din bestallning' })
    expect(invoice.notes).toBe('Tack for din bestallning')
  })

  it('rounds öre rather than carrying float drift', () => {
    const { invoice, items } = map({ invoiceTypeCode: '381', net: 33.33, vat: 8.3325, quantity: 3 })
    expect(invoice.subtotal).toBe(-33.33)
    expect(invoice.vat_amount).toBe(-8.33)
    expect(invoice.total).toBe(-41.66)
    expect(items[0].line_total).toBe(-33.33)
    expect(items[0].vat_amount).toBe(-8.33)
  })

  it('leaves an ordinary invoice untouched', () => {
    const { invoice, items, creditNoteUnlinked } = map({ status: 'sent', invoiceTypeCode: '380' })
    expect(invoice.status).toBe('sent')
    expect(invoice.subtotal).toBe(1000)
    expect(invoice.vat_amount).toBe(250)
    expect(invoice.total).toBe(1250)
    expect(invoice.remaining_amount).toBe(1250)
    expect(items[0].quantity).toBe(2)
    expect(items[0].line_total).toBe(1000)
    expect(items[0].vat_amount).toBe(250)
    expect(creditNoteUnlinked).toBe(false)
  })

  it('keeps a paid ordinary invoice settled', () => {
    const { invoice } = map({ status: 'paid', paid: true, balance: 0 })
    expect(invoice.status).toBe('paid')
    expect(invoice.paid_amount).toBe(1250)
    expect(invoice.remaining_amount).toBe(0)
    expect(invoice.paid_at).toBe('2026-03-10')
  })
})
