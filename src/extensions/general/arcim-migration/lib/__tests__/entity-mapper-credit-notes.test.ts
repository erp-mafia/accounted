import { describe, it, expect } from 'vitest'
import { mapSalesInvoice, mapSupplierInvoice } from '../entity-mapper'
import type { InvoiceStatusCode, PartyDto, SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'
import { mapFortnoxToSalesInvoice, mapFortnoxToSupplierInvoice } from '@/lib/providers/fortnox/mapper'
import { mapBrioxToSalesInvoice, mapBrioxToSupplierInvoice } from '@/lib/providers/briox/mapper'
import { mapBokioToSupplierInvoice } from '@/lib/providers/bokio/mapper'
import { mapBLToSupplierInvoice } from '@/lib/providers/bjornlunden/mapper'
import { mapVismaToSupplierInvoice } from '@/lib/providers/visma/mapper'
import { buildSupplierCreditNoteRow, supplierPayableEffectSek } from '@/lib/supplier-invoices/credit-note'

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
  creditedInvoiceRef?: SalesInvoiceDto['creditedInvoiceRef']
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
    creditedInvoiceRef: over.creditedInvoiceRef,
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

  it('forces the terminal status whatever issued lifecycle status the provider sends', () => {
    for (const status of ['sent', 'booked', 'paid', 'overdue', 'credited'] as InvoiceStatusCode[]) {
      const { invoice } = map({ invoiceTypeCode: '381', status, paid: true, balance: 0 })
      expect(invoice.status, `status=${status}`).toBe('credited')
      expect(STATUSES).toContain(invoice.status as string)
    }
  })

  it('keeps a credit note the source never issued a draft', () => {
    // Bokio's credit-note enum is draft | published. A draft has not reduced
    // anything yet: it lands the way an in-app credit note starts, as a draft
    // with reversed amounts, and does not mark the original credited.
    const { invoice } = map({ invoiceTypeCode: '381', status: 'draft' })
    expect(invoice.status).toBe('draft')
    expect(invoice.total).toBe(-1250)
    expect(invoice.paid_amount).toBe(0)
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

  it('carries the credited invoice the provider named, for the pairing pass', () => {
    // Bokio's invoiceRef names the credited invoice by its own id and number.
    // The mapper cannot turn that into an Accounted id (the original may be
    // inserted later in the run, or by an earlier run), so it hands the
    // reference on and reports the row unpaired as written.
    const ref = { id: 'a419cf69-db6f-4de9-992c-b1a60942a443', invoiceNumber: 'IN-2024-001' }
    const { invoice, creditNoteUnlinked, creditedInvoiceRef } = map({ invoiceTypeCode: '381', creditedInvoiceRef: ref })
    expect(creditedInvoiceRef).toEqual(ref)
    expect(creditNoteUnlinked).toBe(true)
    expect(invoice).not.toHaveProperty('credited_invoice_id')
  })

  it('names the credited invoice in notes when the provider sent its number', () => {
    // Whether or not the pairing pass finds that invoice here, the number
    // must be legible on the record (ML 17 kap 22-23 §).
    const { invoice } = map({
      invoiceTypeCode: '381',
      creditedInvoiceRef: { id: 'a419cf69-db6f-4de9-992c-b1a60942a443', invoiceNumber: 'IN-2024-001' },
    })
    expect(invoice.notes).toContain('Krediterar faktura IN-2024-001')
    expect(invoice.notes).not.toContain('Referens till ursprungsfakturan saknas')
  })

  it('does not carry a reference for an ordinary invoice', () => {
    const { creditedInvoiceRef } = map({ status: 'sent', creditedInvoiceRef: { invoiceNumber: 'stray' } })
    expect(creditedInvoiceRef).toBeNull()
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
    // The fixture names no payment date, so none is written: the issue date
    // is not a settlement date (#2719).
    expect(invoice.paid_at).toBeNull()
  })

  it('keeps a credit note the source voided cancelled', () => {
    // A makulerad kreditfaktura never reduced anything. Importing it as
    // 'credited' would let it count as an effective credit.
    const { invoice } = map({ invoiceTypeCode: '381', status: 'cancelled' })
    expect(invoice.status).toBe('cancelled')
    expect(invoice.total).toBe(-1250)
    expect(invoice.paid_amount).toBe(0)
  })
})

/**
 * #2789: what a provider's own credit note becomes, end to end through the
 * provider mapper and the importer. Before the fix a Fortnox kreditfaktura
 * landed as status 'paid' with paid_amount equal to its negative total, no
 * reference to the invoice it credits and no disclosure: 3 200 such rows
 * across 92 companies in production, none of them ever 'credited'.
 */
describe('mapSalesInvoice: a provider credit note end to end (#2789)', () => {
  // InvoiceFull as Fortnox serialises it: `Credit` is the string "true",
  // amounts are negative, the row carries the sign on the quantity and the
  // balance is settled against the debit invoice.
  const fortnoxCredit = {
    DocumentNumber: '1043', CustomerNumber: '12', CustomerName: 'Kund AB',
    InvoiceDate: '2026-03-10', DueDate: '2026-04-09', Currency: 'SEK',
    Credit: 'true', CreditInvoiceReference: '1038',
    Booked: true, Sent: true, Cancelled: false, VATIncluded: false,
    Net: -1000, TotalVAT: -250, Total: -1250, Balance: 0,
    InvoiceRows: [
      { RowId: 1, Description: 'Konsulttimmar', DeliveredQuantity: '-2.00', Price: 500, Total: -1000, VAT: 25, Unit: 'tim' },
    ],
  }

  const importRow = (dto: SalesInvoiceDto) => mapSalesInvoice(dto, 'user-1', 'company-1', 'customer-1')

  it('Fortnox: lands as a credited kreditfaktura that names the invoice it credits', () => {
    const { invoice, items, creditNoteUnlinked, creditedInvoiceRef } = importRow(mapFortnoxToSalesInvoice(fortnoxCredit))
    expect(invoice.status).toBe('credited')
    expect(invoice.total).toBe(-1250)
    expect(invoice.subtotal).toBe(-1000)
    expect(invoice.vat_amount).toBe(-250)
    expect(invoice.vat_rate).toBe(25)
    // Nothing is collected on a credit note: not a negative payment either.
    expect(invoice.paid_amount).toBe(0)
    expect(invoice.remaining_amount).toBe(0)
    expect(invoice.paid_at).toBeNull()
    expect(items[0]).toMatchObject({ quantity: -2, unit_price: 500, line_total: -1000, vat_amount: -250 })
    // ML 17 kap 22-23 §: the reference to the original, legible on the record.
    expect(invoice.notes).toContain('Krediterar faktura 1038')
    expect(creditedInvoiceRef).toEqual({ id: '1038', invoiceNumber: '1038' })
    expect(creditNoteUnlinked).toBe(true)
  })

  it('Fortnox: the list form, which carries no Credit flag, is still a credit note', () => {
    const { Credit: _credit, CreditInvoiceReference: _ref, InvoiceRows: _rows, Net: _net, TotalVAT: _vat, ...listForm } = fortnoxCredit
    const { invoice, creditedInvoiceRef } = importRow(mapFortnoxToSalesInvoice(listForm))
    expect(invoice.status).toBe('credited')
    expect(invoice.total).toBe(-1250)
    expect(invoice.paid_amount).toBe(0)
    expect(creditedInvoiceRef).toBeNull()
    expect(invoice.notes).toContain('Referens till ursprungsfakturan saknas')
  })

  it('Fortnox: the credited original stays an ordinary invoice with its positive amounts', () => {
    const original = { ...fortnoxCredit, DocumentNumber: '1038', Credit: 'false', CreditInvoiceReference: '1043',
      Net: 1000, TotalVAT: 250, Total: 1250, Balance: 0,
      InvoiceRows: [{ ...fortnoxCredit.InvoiceRows[0], DeliveredQuantity: '2.00', Total: 1000 }] }
    const { invoice, creditNoteUnlinked } = importRow(mapFortnoxToSalesInvoice(original))
    expect(invoice.total).toBe(1250)
    expect(invoice.status).toBe('paid')
    expect(creditNoteUnlinked).toBe(false)
  })

  it('Briox: a negative-total document lands as a credited kreditfaktura', () => {
    const { invoice, items, creditNoteUnlinked } = importRow(mapBrioxToSalesInvoice({
      id: 71, invoice_number: '2044', invoice_date: '2026-03-10', due_date: '2026-04-09',
      total_amount: '-1250.00', net_amount: '-1000.00', vat_amount: '-250.00', balance: '0.00', customer_name: 'Kund AB', booked: true,
      rows: [{ id: 1, description: 'Konsulttimmar', quantity: '-2', price: '500.00', total: '-1000.00', vat_rate: '25' }],
    }))
    expect(invoice.status).toBe('credited')
    expect(invoice.total).toBe(-1250)
    expect(invoice.paid_amount).toBe(0)
    expect(items[0]).toMatchObject({ quantity: -2, unit_price: 500, line_total: -1000, vat_amount: -250 })
    expect(creditNoteUnlinked).toBe(true)
  })

  it('keeps the relative sign of the rows on a credit note that also charges something', () => {
    // 65 of the Fortnox credit notes in production mix signs: goods credited,
    // a restocking fee charged. Their rows sum to the header as sent. Taking
    // the magnitude of every row would turn the fee into a second credit and
    // the rows would no longer add up to the header (-1100 against -900).
    const mixed = { ...fortnoxCredit, Net: -900, TotalVAT: -225, Total: -1125,
      InvoiceRows: [
        { RowId: 1, Description: 'Retur vara', DeliveredQuantity: '-2.00', Price: 500, Total: -1000, VAT: 25 },
        { RowId: 2, Description: 'Returavgift', DeliveredQuantity: '1.00', Price: 100, Total: 100, VAT: 25 },
      ] }
    const { invoice, items } = importRow(mapFortnoxToSalesInvoice(mixed))
    expect(invoice.subtotal).toBe(-900)
    expect(invoice.total).toBe(-1125)
    expect(items[0]).toMatchObject({ quantity: -2, unit_price: 500, line_total: -1000, vat_amount: -250 })
    expect(items[1]).toMatchObject({ quantity: 1, unit_price: 100, line_total: 100, vat_amount: 25 })
    const net = items.reduce((sum, item) => sum + Number(item.line_total), 0)
    expect(net).toBe(invoice.subtotal)
  })

  it('keeps the relative sign of the rows when the provider states the credit note in magnitudes', () => {
    // The same document as Bokio or the gateway would state it: credited rows
    // positive, the fee negative, the header a magnitude.
    const dto = makeDto({ invoiceTypeCode: '381', net: 900, vat: 225 })
    dto.lines = [
      { id: '1', description: 'Retur vara', quantity: 2, unitPrice: { value: 500, currencyCode: 'SEK' },
        lineExtensionAmount: { value: 1000, currencyCode: 'SEK' }, taxPercent: 25, taxAmount: { value: 250, currencyCode: 'SEK' } },
      { id: '2', description: 'Returavgift', quantity: -1, unitPrice: { value: 100, currencyCode: 'SEK' },
        lineExtensionAmount: { value: -100, currencyCode: 'SEK' }, taxPercent: 25, taxAmount: { value: -25, currencyCode: 'SEK' } },
    ]
    const { invoice, items } = importRow(dto)
    expect(invoice.subtotal).toBe(-900)
    expect(items[0]).toMatchObject({ quantity: -2, unit_price: 500, line_total: -1000, vat_amount: -250 })
    expect(items[1]).toMatchObject({ quantity: 1, unit_price: 100, line_total: 100, vat_amount: 25 })
  })
})

/**
 * The SUPPLIER kreditfaktura (#2838).
 *
 * supplier_invoices models a credit note the opposite way from invoices: the
 * amounts of the invoice it reverses, as MAGNITUDES, beside is_credit_note
 * (lib/supplier-invoices/credit-note.ts is what Kreditera writes). The
 * providers state a supplier credit note with negative amounts and the
 * importer passed them through, so no mapper could type one without storing
 * a flagged row that was negative twice over, and an untyped one landed as an
 * ordinary payable with a negative total. The migrated row must equal the
 * native one, so nothing downstream needs a special case.
 */
describe('mapSupplierInvoice: kreditfaktura', () => {
  function supplierDto(over: {
    invoiceTypeCode?: string
    signOfAmounts?: 1 | -1
    status?: InvoiceStatusCode
    paid?: boolean
    balance?: number
    lastPaymentDate?: string
    note?: string
    creditedInvoiceRef?: SupplierInvoiceDto['creditedInvoiceRef']
    lines?: SupplierInvoiceDto['lines']
  } = {}): SupplierInvoiceDto {
    const s = over.signOfAmounts ?? 1
    return {
      id: 'sinv-1', invoiceNumber: 'K-5531', issueDate: '2026-03-10', dueDate: '2026-04-09',
      invoiceTypeCode: over.invoiceTypeCode, currencyCode: 'SEK', status: over.status ?? 'credited',
      supplier: party, buyer: party,
      lines: over.lines ?? [{
        id: '1', description: 'Retur', quantity: 2 * s, unitPrice: { value: 500, currencyCode: 'SEK' },
        lineExtensionAmount: { value: 1000 * s, currencyCode: 'SEK' }, taxPercent: 25,
        taxAmount: { value: 250 * s, currencyCode: 'SEK' }, accountNumber: '4010',
      }],
      taxTotal: { taxAmount: { value: 250 * s, currencyCode: 'SEK' } },
      legalMonetaryTotal: { lineExtensionAmount: { value: 1000 * s, currencyCode: 'SEK' }, payableAmount: { value: 1250 * s, currencyCode: 'SEK' } },
      paymentStatus: { paid: over.paid ?? true, balance: { value: over.balance ?? 0, currencyCode: 'SEK' }, lastPaymentDate: over.lastPaymentDate },
      note: over.note,
      creditedInvoiceRef: over.creditedInvoiceRef,
    }
  }
  const mapSupplier = (dto: SupplierInvoiceDto) => mapSupplierInvoice(dto, 'user-1', 'company-1', 'supplier-1')

  it('stores the magnitudes beside is_credit_note, whatever sign the provider states', () => {
    const negative = mapSupplier(supplierDto({ invoiceTypeCode: '381', signOfAmounts: -1 }))
    const magnitude = mapSupplier(supplierDto({ invoiceTypeCode: '381', signOfAmounts: 1 }))
    expect(negative.invoice).toMatchObject({
      is_credit_note: true, status: 'credited', subtotal: 1000, vat_amount: 250, total: 1250,
      subtotal_sek: 1000, vat_amount_sek: 250, total_sek: 1250, vat_treatment: 'standard_25',
      paid_amount: 0, remaining_amount: 0, paid_at: null,
    })
    expect(negative.items).toEqual([expect.objectContaining({ quantity: 2, unit_price: 500, line_total: 1000, vat_rate: 0.25, vat_amount: 250 })])
    expect(magnitude.invoice).toEqual(negative.invoice)
    expect(magnitude.items).toEqual(negative.items)
  })

  it('equals the row Kreditera writes for the same document, column for column', () => {
    const original = mapSupplier(supplierDto({ status: 'booked', paid: false, balance: 1250 })).invoice
    const native = buildSupplierCreditNoteRow(
      { ...original, id: 'orig-1', supplier_invoice_number: 'K-5531' } as unknown as Parameters<typeof buildSupplierCreditNoteRow>[0],
      { userId: 'user-1', companyId: 'company-1', arrivalNumber: 7, date: '2026-03-10' },
    )
    const migrated = mapSupplier(supplierDto({ invoiceTypeCode: '381', signOfAmounts: -1 })).invoice
    for (const column of ['status', 'currency', 'exchange_rate', 'vat_treatment', 'reverse_charge', 'subtotal', 'subtotal_sek',
      'vat_amount', 'vat_amount_sek', 'total', 'total_sek', 'remaining_amount', 'is_credit_note'] as const) {
      expect(migrated[column], column).toEqual(native[column])
    }
  })

  it('collects nothing and owes nothing, even when the provider calls the credit note paid on a date', () => {
    const { invoice } = mapSupplier(supplierDto({ invoiceTypeCode: '381', signOfAmounts: -1, status: 'paid', paid: true, lastPaymentDate: '2026-03-12' }))
    expect(invoice).toMatchObject({ status: 'credited', paid_amount: 0, remaining_amount: 0, paid_at: null })
  })

  it('never lands in a state supplier_invoices_credit_note_not_payable refuses', () => {
    for (const status of ['draft', 'sent', 'booked', 'paid', 'overdue', 'cancelled', 'credited'] as InvoiceStatusCode[]) {
      const { invoice } = mapSupplier(supplierDto({ invoiceTypeCode: '381', signOfAmounts: -1, status }))
      expect(['registered', 'approved', 'overdue', 'paid', 'partially_paid'], `status=${status}`).not.toContain(invoice.status)
    }
  })

  it('flips accounting rows together: a balanced voucher reads as the invoice it reverses', () => {
    // Fortnox sends the document's ACCOUNTING rows, which net to zero: the
    // header decides the factor, and the 2440 row keeps the opposite sign of
    // the cost rows, exactly as on an ordinary migrated Fortnox invoice.
    const rows = [[2440, 1250], [4010, -1000], [2641, -250.00000000000003]].map(([account, total], i) => ({
      id: String(i + 1), lineExtensionAmount: { value: total, currencyCode: 'SEK' }, accountNumber: String(account),
    }))
    const { items } = mapSupplier(supplierDto({ invoiceTypeCode: '381', signOfAmounts: -1, lines: rows }))
    expect(items.map((item) => [item.account_number, item.line_total])).toEqual([['2440', -1250], ['4010', 1000], ['2641', 250]])
  })

  it('keeps the relative sign of the rows on a credit note that also charges something', () => {
    const line = (id: string, total: number) => ({ id, quantity: total < 0 ? -1 : 1, unitPrice: { value: Math.abs(total), currencyCode: 'SEK' },
      lineExtensionAmount: { value: total, currencyCode: 'SEK' }, taxPercent: 25, taxAmount: { value: total * 0.25, currencyCode: 'SEK' } })
    const { items, invoice } = mapSupplier({ ...supplierDto({ invoiceTypeCode: '381', signOfAmounts: -1 }), lines: [line('1', -1200), line('2', 200)] })
    expect(items.map((item) => [item.quantity, item.unit_price, item.line_total, item.vat_amount]))
      .toEqual([[1, 1200, 1200, 300], [-1, 200, -200, -50]])
    expect(items.reduce((sum, item) => sum + Number(item.line_total), 0)).toBe(invoice.subtotal)
  })

  it('names the credited invoice in notes and hands the reference to the pairing pass', () => {
    const named = mapSupplier(supplierDto({ invoiceTypeCode: '381', signOfAmounts: -1, note: 'Retur pall 4', creditedInvoiceRef: { id: '311', invoiceNumber: '311' } }))
    expect(named.creditedInvoiceRef).toEqual({ id: '311', invoiceNumber: '311' })
    expect(named.creditNoteUnlinked).toBe(true)
    expect(named.invoice.notes).toBe('Retur pall 4\n\nKreditfaktura importerad vid systembyte. Krediterar faktura 311 i källsystemet.')
    const unnamed = mapSupplier(supplierDto({ invoiceTypeCode: '381', signOfAmounts: -1 }))
    expect(unnamed.creditedInvoiceRef).toBeNull()
    expect(unnamed.invoice.notes).toContain('Referens till ursprungsfakturan saknas')
  })

  it('leaves an ordinary supplier invoice untouched, reference and all', () => {
    const { invoice, items, creditNoteUnlinked, creditedInvoiceRef } = mapSupplier(
      supplierDto({ status: 'booked', paid: false, balance: 1250, creditedInvoiceRef: { id: '9', invoiceNumber: '9' }, note: 'Hej' }))
    expect(invoice).toMatchObject({ is_credit_note: false, status: 'registered', total: 1250, remaining_amount: 1250, notes: 'Hej' })
    expect(items[0]).toMatchObject({ quantity: 2, line_total: 1000 })
    expect(creditNoteUnlinked).toBe(false)
    expect(creditedInvoiceRef).toBeNull()
  })

  it.each([
    ['fortnox', () => mapFortnoxToSupplierInvoice({ GivenNumber: '312', SupplierName: 'Leverantör AB', InvoiceDate: '2026-03-10', DueDate: '2026-04-09',
      Currency: 'SEK', Credit: true, CreditReference: 311, Booked: true, Total: -1250, VAT: -250, Balance: 0,
      SupplierInvoiceRows: [{ Account: 2440, Total: 1250 }, { Account: 4010, Total: -1000 }, { Account: 2641, Total: -250 }] })],
    ['visma', () => mapVismaToSupplierInvoice({ Id: 'v', InvoiceNumber: 'K-1', InvoiceDate: '2026-03-10', CurrencyCode: 'SEK', IsCreditInvoice: true,
      TotalAmount: -1250, VatAmount: -250, PaymentStatus: 6, Status: 1, SupplierName: 'Leverantör AB', Rows: [] })],
    ['bokio', () => mapBokioToSupplierInvoice({ id: 'b', invoiceNumber: 'K-1', invoiceDate: '2026-03-10', currency: 'SEK', totalAmount: -1250,
      totalTax: -250, remainingAmount: 0, supplierRef: { id: 's', name: 'Leverantör AB' }, lineItems: [] })],
    ['briox', () => mapBrioxToSupplierInvoice({ id: 81, invoice_number: 'K-1', invoice_date: '2026-03-10', total_amount: '-1250.00',
      net_amount: '-1000.00', vat_amount: '-250.00', balance: '0.00', supplier_name: 'Leverantör AB', booked: true })],
    ['bjornlunden', () => mapBLToSupplierInvoice({ entityId: 912, invoiceNumber: 'K-1', invoiceDate: '2026-03-10', currency: 'SEK',
      supplierName: 'Leverantör AB', amountInLocalCurrency: -1250, amountPaidInLocalCurrency: -1250, paid: true, status: [2] })],
  ])('%s: a wire-shaped supplier credit note lands as a native-shaped kreditfaktura', (_provider, build) => {
    const { invoice } = mapSupplier(build())
    expect(invoice).toMatchObject({ is_credit_note: true, status: 'credited', total: 1250, total_sek: 1250, paid_amount: 0, remaining_amount: 0, paid_at: null })
    expect(Number(invoice.subtotal)).toBeGreaterThanOrEqual(0)
    expect(Number(invoice.vat_amount)).toBeGreaterThanOrEqual(0)
  })
})

describe('supplierPayableEffectSek', () => {
  it('negates a credit note, whatever sign the row holds, and passes an invoice through', () => {
    expect(supplierPayableEffectSek(1250, true)).toBe(-1250)
    expect(supplierPayableEffectSek(-1250, true)).toBe(-1250)
    expect(supplierPayableEffectSek(1250, false)).toBe(1250)
    // A row from before #2838: the provider's negative total on an unflagged row.
    expect(supplierPayableEffectSek(-1250, false)).toBe(-1250)
    expect(Object.is(supplierPayableEffectSek(0, true), 0)).toBe(true)
    expect(supplierPayableEffectSek(null, true)).toBeNull()
    expect(supplierPayableEffectSek(undefined, false)).toBeNull()
  })
})
