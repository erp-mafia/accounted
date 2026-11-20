import { describe, expect, it } from 'vitest'
import { parseUblJsonDocument } from '@/lib/invoices/peppol-inbound-ubl'
import { peppolDocumentToExtraction } from '@/lib/invoices/peppol-inbox-delivery'
import { READING_FIELD_NAMES, READING_TERMS } from '../types'
import { resolveDocumentReading, type ReadingDocumentRow, type ReadingInputs, type ReadingItemRow } from '../resolve'
import type { ArkivRecord } from '../assemble'
import {
  SELLER_ORG,
  SELLER_VAT,
  creditNoteExtraction,
  peppolCreditNoteJson,
  peppolInvoiceJson,
  receiptExtraction,
} from './fixtures'

const ITEM_ID = '11111111-1111-4111-8111-111111111111'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function item(overrides: Partial<ReadingItemRow> = {}): ReadingItemRow {
  return {
    id: ITEM_ID,
    document_id: DOC_ID,
    source: 'upload',
    extracted_data: null,
    extraction_skipped: false,
    kind_hint: null,
    channel_context: null,
    email_from: null,
    email_received_at: null,
    matched_supplier_id: null,
    ...overrides,
  }
}

function doc(overrides: Partial<ReadingDocumentRow> = {}): ReadingDocumentRow {
  return {
    id: DOC_ID,
    mime_type: 'image/jpeg',
    file_name: 'kvitto.jpg',
    upload_source: 'file_upload',
    doc_type: null,
    extracted_data: null,
    extraction_model: null,
    extracted_at: null,
    model_reading: null,
    ...overrides,
  }
}

const inputs = (overrides: Partial<ReadingInputs>): ReadingInputs => ({
  item: null,
  document: null,
  peppol: null,
  peppolToExtraction: peppolDocumentToExtraction,
  arkiv: null,
  supplier: null,
  ...overrides,
})

const MODEL = 'claude-sonnet-4-6'
const READ_AT = '2026-10-02T10:00:00.000Z'

function peppolItem(json: Record<string, unknown>, extracted?: Record<string, unknown>) {
  const parsed = parseUblJsonDocument(json)!
  const stored = extracted ?? (clone(peppolDocumentToExtraction(parsed)) as unknown as Record<string, unknown>)
  return {
    parsed,
    stored,
    item: item({
      source: 'peppol',
      extracted_data: stored,
      email_from: 'Exempel Leverantör AB',
      email_received_at: '2026-10-01T08:00:00.000Z',
      channel_context: {
        channel: 'peppol',
        peppol_provider: 'qvalia',
        peppol_document_id: 'pd-1',
        peppol_document_type: parsed.documentType,
        peppol_sender_endpoint: `0007:${SELLER_ORG}`,
        peppol_xml_document_id: 'xml-doc',
      },
    }),
    document: doc({ mime_type: 'application/pdf', file_name: 'faktura.pdf', upload_source: 'e_invoice', extraction_model: null }),
  }
}

describe('the EN 16931 vocabulary', () => {
  it('names a business term for every field', () => {
    for (const field of READING_FIELD_NAMES) expect(READING_TERMS[field].term).toMatch(/^B[TG]-\d+$/)
    expect(READING_TERMS.seller_legal_registration_identifier.term).toBe('BT-30')
    expect(READING_TERMS.amount_due_for_payment.term).toBe('BT-115')
    expect(READING_TERMS.preceding_invoice_reference.term).toBe('BT-25')
  })
})

describe('a Peppol invoice', () => {
  it('reads every field from the UBL as Exakt, lines included', () => {
    const { parsed, item: row, document } = peppolItem(peppolInvoiceJson())
    const reading = resolveDocumentReading(inputs({ item: row, document, peppol: parsed }))
    expect(reading.notes).toEqual([])
    for (const field of Object.values(reading.fields)) expect(field).toMatchObject({ source: 'xml', evidence: 'exakt' })
    expect(reading.fields).toMatchObject({
      seller_name: { value: 'Exempel Leverantör AB' },
      seller_legal_registration_identifier: { value: SELLER_ORG },
      seller_vat_identifier: { value: SELLER_VAT },
      seller_country_code: { value: 'SE' },
      document_type: { value: 'supplier_invoice' },
      invoice_type_code: { value: '380' },
      invoice_number: { value: 'INV-1001' },
      invoice_issue_date: { value: '2026-10-01' },
      payment_due_date: { value: '2026-10-31' },
      invoice_currency_code: { value: 'SEK' },
      amount_due_for_payment: { value: 1250 },
      vat_breakdown: { value: [{ vat_category_rate: 25, vat_category_taxable_amount: 1000, vat_category_tax_amount: 250, vat_category_code: 'S' }] },
      remittance_information: { value: '1234567897' },
      payment_account_bankgiro: { value: '123-4567' },
      invoice_lines: {
        value: [
          {
            invoice_line_identifier: '1',
            item_name: 'Konsulttimme',
            invoiced_quantity: 2,
            item_net_price: 500,
            invoice_line_net_amount: 1000,
            invoiced_item_vat_category_code: 'S',
            invoiced_item_vat_rate: 25,
          },
        ],
      },
    })
    expect(reading.fields.preceding_invoice_reference).toBeUndefined()
    expect(reading.door).toEqual({ intake_source: 'peppol', sender: `0007:${SELLER_ORG}`, received_at: '2026-10-01T08:00:00.000Z' })
    expect(Object.keys(reading.fields)[0]).toBe('seller_name')
  })

  it("a person's correction outranks the XML; every other field stays Exakt", () => {
    const { parsed, stored, document } = peppolItem(peppolInvoiceJson())
    const invoice = stored.invoice as Record<string, unknown>
    invoice.dueDate = '2026-11-15'
    invoice.paymentReference = null
    const { item: row } = peppolItem(peppolInvoiceJson(), stored)
    const reading = resolveDocumentReading(inputs({ item: row, document, peppol: parsed }))
    expect(reading.fields.payment_due_date).toEqual({ value: '2026-11-15', source: 'person', evidence: 'ditt_val' })
    expect(reading.fields.remittance_information).toEqual({ value: null, source: 'person', evidence: 'ditt_val' })
    expect(reading.fields.invoice_issue_date).toEqual({ value: '2026-10-01', source: 'xml', evidence: 'exakt' })
  })

  it('is no correction when the stored reading predates a field the mapping now reads', () => {
    const { parsed, stored, document } = peppolItem(peppolInvoiceJson())
    const supplier = stored.supplier as Record<string, unknown>
    supplier.bankgiro = '1234567'
    delete supplier.iban
    delete supplier.bic
    const { item: row } = peppolItem(peppolInvoiceJson(), stored)
    const reading = resolveDocumentReading(inputs({ item: row, document, peppol: parsed }))
    // Hyphenless, the same giro: not a correction either.
    expect(reading.fields.payment_account_bankgiro).toMatchObject({ value: '123-4567', source: 'xml' })
    expect(Object.values(reading.fields).every((f) => f?.source === 'xml')).toBe(true)
  })

  it('falls back to the item reading, unverified, when the UBL cannot be found', () => {
    const { stored, item: row, document } = peppolItem(peppolInvoiceJson())
    delete (stored.supplier as Record<string, unknown>).orgNumber
    const reading = resolveDocumentReading(inputs({ item: row, document, peppol: null }))
    expect(reading.notes).toEqual(['structured_source_missing', 'origin_unknown'])
    expect(reading.fields.invoice_number).toMatchObject({ source: 'vision', evidence: 'trolig' })
    expect(reading.fields.invoice_lines).toBeUndefined()
    // Nothing read the organisationsnummer, so the door's sender endpoint stands in.
    expect(reading.fields.seller_legal_registration_identifier).toMatchObject({ value: SELLER_ORG, source: 'door' })
  })
})

describe('a Peppol credit note', () => {
  it('names the credited invoice and books its amounts below zero', () => {
    const { parsed, item: row, document } = peppolItem(peppolCreditNoteJson())
    const reading = resolveDocumentReading(inputs({ item: row, document, peppol: parsed }))
    expect(reading.fields).toMatchObject({
      document_type: { value: 'credit_note', source: 'xml', evidence: 'exakt' },
      invoice_type_code: { value: '381', source: 'xml' },
      invoice_number: { value: 'CN-77' },
      preceding_invoice_reference: { value: 'INV-1001', source: 'xml', evidence: 'exakt' },
      amount_due_for_payment: { value: -1250 },
      vat_breakdown: { value: [{ vat_category_rate: 25, vat_category_taxable_amount: -1000, vat_category_tax_amount: -250, vat_category_code: 'S' }] },
    })
    expect(reading.fields.invoice_lines?.value?.[0]).toMatchObject({ invoice_line_net_amount: -1000, item_net_price: -500 })
  })
})

describe('a receipt read by vision', () => {
  const extraction = receiptExtraction()
  const document = doc({ extracted_data: extraction, extraction_model: MODEL, extracted_at: READ_AT })

  it('is the model reading, Trolig unless something agrees, and carries no lines', () => {
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: clone(extraction) }), document }))
    expect(reading.notes).toEqual([])
    expect(reading.fields.seller_name).toEqual({ value: 'Kafé Exempel', source: 'vision', evidence: 'trolig' })
    expect(reading.fields.document_type).toEqual({ value: 'receipt', source: 'vision', evidence: 'trolig' })
    expect(reading.fields.invoice_lines).toBeUndefined()
    expect(reading.fields.seller_country_code).toBeUndefined()
    // The two VAT rows add up to the total: that corroborates both.
    expect(reading.fields.amount_due_for_payment).toEqual({ value: 148, source: 'vision', evidence: 'stark', corroborated_by: ['vat_breakdown'] })
    expect(reading.fields.vat_breakdown).toMatchObject({ evidence: 'stark', corroborated_by: ['vat_breakdown'] })
    expect(reading.door).toEqual({ intake_source: 'upload', sender: null, received_at: null })
  })

  it('is Stark with page and quote where the Arkiv record read the same, and Trolig where it did not', () => {
    const arkiv: ArkivRecord = {
      schema_type: 'receipt',
      payload: {
        merchant_name: { value: 'KAFÉ EXEMPEL', normalized: 'KAFÉ EXEMPEL', page: 1, quote: 'KAFÉ EXEMPEL' },
        receipt_date: { value: '2 oktober 2026', normalized: '2026-10-02', page: 1, quote: '2 okt 2026 10:14' },
        receipt_number: { value: 'K-43', normalized: 'K-43', page: 1, quote: 'Kvitto K-43' },
      },
    }
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: clone(extraction) }), document, arkiv }))
    expect(reading.fields.seller_name).toEqual({
      value: 'Kafé Exempel',
      source: 'vision',
      evidence: 'stark',
      page: 1,
      quote: 'KAFÉ EXEMPEL',
      corroborated_by: ['second_reading'],
    })
    expect(reading.fields.invoice_issue_date).toMatchObject({ evidence: 'stark', page: 1, quote: '2 okt 2026 10:14' })
    expect(reading.fields.invoice_number).toEqual({ value: 'K-42', source: 'vision', evidence: 'trolig' })
  })

  it('never makes a total promoted from a prominent amount Stark', () => {
    const promoted = receiptExtraction({ totalSource: 'prominent' })
    const reading = resolveDocumentReading(
      inputs({ item: item({ extracted_data: clone(promoted) }), document: doc({ extracted_data: promoted, extraction_model: MODEL, extracted_at: READ_AT }) }),
    )
    expect(reading.fields.amount_due_for_payment).toEqual({ value: 148, source: 'vision', evidence: 'trolig' })
  })

  it('a mail body is read as text', () => {
    const reading = resolveDocumentReading(
      inputs({ item: item({ source: 'email', extracted_data: clone(extraction), email_from: 'kvitto@example.test' }), document: { ...document, mime_type: 'text/html' } }),
    )
    expect(reading.fields.seller_name?.source).toBe('text')
    expect(reading.door).toMatchObject({ intake_source: 'intake_email', sender: 'kvitto@example.test' })
  })
})

describe('a corrected reading', () => {
  const model = receiptExtraction()
  const corrected = clone(model) as unknown as Record<string, unknown>
  ;(corrected.supplier as Record<string, unknown>).name = 'Kafé Exempel Södermalm'
  ;(corrected.invoice as Record<string, unknown>).invoiceDate = '2026-10-03'
  ;(corrected.invoice as Record<string, unknown>).invoiceNumber = null
  corrected.documentKind = 'supplier_invoice'

  it("marks what the person changed as Ditt val against the kept model reading, the rest as the model's", () => {
    // The mirror wrote the correction onto the document and kept the model's reading.
    const document = doc({
      extracted_data: corrected,
      extraction_model: MODEL,
      extracted_at: READ_AT,
      model_reading: { extracted_data: model, extraction_model: MODEL, extracted_at: READ_AT },
    })
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: corrected }), document }))
    expect(reading.fields.seller_name).toEqual({ value: 'Kafé Exempel Södermalm', source: 'person', evidence: 'ditt_val' })
    expect(reading.fields.invoice_issue_date).toEqual({ value: '2026-10-03', source: 'person', evidence: 'ditt_val' })
    expect(reading.fields.invoice_number).toEqual({ value: null, source: 'person', evidence: 'ditt_val' })
    expect(reading.fields.document_type).toEqual({ value: 'supplier_invoice', source: 'person', evidence: 'ditt_val' })
    expect(reading.fields.seller_legal_registration_identifier).toMatchObject({ source: 'vision' })
    expect(reading.fields.amount_due_for_payment).toMatchObject({ source: 'vision', evidence: 'stark' })
  })

  it('reads the same from a correction made before the mirror existed (only the item holds it)', () => {
    const document = doc({ extracted_data: model, extraction_model: MODEL, extracted_at: READ_AT })
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: corrected }), document }))
    expect(reading.fields.seller_name?.source).toBe('person')
    expect(reading.fields.payment_due_date).toBeUndefined()
  })

  it("a person's value the Arkiv record also read keeps its page and quote", () => {
    const document = doc({ extracted_data: model, extraction_model: MODEL, extracted_at: READ_AT })
    const arkiv: ArkivRecord = { schema_type: 'receipt', payload: { receipt_date: { normalized: '2026-10-03', page: 2, quote: '3/10 2026' } } }
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: corrected }), document, arkiv }))
    expect(reading.fields.invoice_issue_date).toEqual({ value: '2026-10-03', source: 'person', evidence: 'ditt_val', page: 2, quote: '3/10 2026' })
  })

  it('a marked correction stays Ditt val after a new reading that agrees with it, and on an agent reading', () => {
    // "Tolka om" read the person's values too; personFields says who decided them.
    const reread = clone(corrected)
    reread.personFields = ['supplier.name', 'invoice.invoiceDate']
    const document = doc({ extracted_data: corrected, extraction_model: MODEL, extracted_at: READ_AT })
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: reread }), document }))
    expect(reading.fields.seller_name).toEqual({ value: 'Kafé Exempel Södermalm', source: 'person', evidence: 'ditt_val' })
    expect(reading.fields.invoice_issue_date).toMatchObject({ source: 'person', evidence: 'ditt_val' })
    expect(reading.fields.seller_legal_registration_identifier).toMatchObject({ source: 'vision' })

    const agent = { ...reread, confidence: 0.95 }
    const byAgent = resolveDocumentReading(inputs({ item: item({ extracted_data: agent }), document }))
    expect(byAgent.notes).toEqual(['agent_reading'])
    expect(byAgent.fields.seller_name).toMatchObject({ source: 'person', evidence: 'ditt_val' })
    expect(byAgent.fields.amount_due_for_payment).toMatchObject({ source: 'vision' })
  })

  it('a declared receipt still outranks a person who called it an invoice, by the inbox kind rule', () => {
    const document = doc({ extracted_data: model, extraction_model: MODEL, extracted_at: READ_AT })
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: corrected, kind_hint: 'receipt' }), document }))
    // The model read a receipt too: the declared kind is corroborated.
    expect(reading.fields.document_type).toEqual({ value: 'receipt', source: 'door', evidence: 'stark', corroborated_by: ['declared_kind'] })
  })
})

describe('a credit note read by the model', () => {
  it('names the credited invoice as read, and the Arkiv record corroborates the positive printed amount', () => {
    const extraction = creditNoteExtraction()
    const document = doc({ mime_type: 'application/pdf', extracted_data: extraction, extraction_model: MODEL, extracted_at: READ_AT, doc_type: 'credit_note' })
    const arkiv: ArkivRecord = {
      schema_type: 'credit_note',
      payload: {
        total_amount: { value: '500,00 kr', normalized: 500, page: 1, quote: 'Att få tillbaka 500,00 kr' },
        invoice_reference: { value: 'INV-0900', normalized: 'INV-0900', page: 1, quote: 'Avser faktura INV-0900' },
      },
    }
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: clone(extraction) }), document, arkiv }))
    expect(reading.fields.document_type).toEqual({ value: 'credit_note', source: 'vision', evidence: 'stark', corroborated_by: ['second_reading'] })
    expect(reading.fields.preceding_invoice_reference).toMatchObject({ value: 'INV-0900', evidence: 'stark', quote: 'Avser faktura INV-0900' })
    expect(reading.fields.amount_due_for_payment).toMatchObject({
      value: -500,
      evidence: 'stark',
      page: 1,
      corroborated_by: ['second_reading', 'vat_breakdown'],
    })
    // The VAT number embeds the organisationsnummer: they corroborate each other.
    expect(reading.fields.seller_vat_identifier).toMatchObject({ evidence: 'stark', corroborated_by: ['vat_identifier'] })
    expect(reading.fields.seller_country_code).toMatchObject({ value: 'SE', source: 'vision' })
  })

  it("the matched supplier's card corroborates the seller and the bankgiro", () => {
    const extraction = creditNoteExtraction()
    const document = doc({ mime_type: 'application/pdf', extracted_data: extraction, extraction_model: MODEL, extracted_at: READ_AT })
    const supplier = { name: 'Exempel Leverantör AB', org_number: '550000-0001', vat_number: null, bankgiro: '1234567', plusgiro: null, iban: null }
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: clone(extraction), matched_supplier_id: 's-1' }), document, supplier }))
    expect(reading.fields.seller_name).toMatchObject({ evidence: 'stark', corroborated_by: ['supplier_register'] })
    expect(reading.fields.seller_legal_registration_identifier?.corroborated_by).toEqual(['supplier_register', 'vat_identifier'])
    expect(reading.fields.payment_account_bankgiro).toMatchObject({ value: '123-4567', evidence: 'stark', corroborated_by: ['supplier_register'] })
  })
})

describe('origins a correction cannot be measured against', () => {
  it('attributes everything to the model when the document keeps no model reading', () => {
    const extraction = receiptExtraction()
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: clone(extraction) }), document: doc() }))
    expect(reading.notes).toEqual(['origin_unknown'])
    expect(reading.fields.seller_name).toMatchObject({ source: 'vision', evidence: 'trolig' })
  })

  it("an item the model never read holds only a person's values, not the skeleton's default currency", () => {
    const typed = {
      supplier: { name: 'Hantverkare AB', orgNumber: null },
      invoice: { invoiceNumber: null, invoiceDate: '2026-10-04', currency: 'SEK' },
      totals: { total: 1999 },
      lineItems: [],
      vatBreakdown: [],
      confidence: 0,
    }
    const reading = resolveDocumentReading(
      inputs({ item: item({ extracted_data: typed, extraction_skipped: true }), document: doc({ extraction_model: 'skipped:ai_unconfigured' }) }),
    )
    expect(reading.notes).toEqual([])
    expect(reading.fields).toEqual({
      seller_name: { value: 'Hantverkare AB', source: 'person', evidence: 'ditt_val' },
      invoice_issue_date: { value: '2026-10-04', source: 'person', evidence: 'ditt_val' },
      amount_due_for_payment: { value: 1999, source: 'person', evidence: 'ditt_val' },
    })
  })

  it("an item the model never read takes its kind from what a person typed: negative amounts read as a credit", () => {
    const typed = { supplier: { name: 'Hantverkare AB' }, invoice: { currency: 'SEK' }, totals: { subtotal: -800, vatAmount: -200, total: -1000 }, confidence: 0 }
    const reading = resolveDocumentReading(
      inputs({ item: item({ extracted_data: typed, extraction_skipped: true }), document: doc({ extraction_model: 'skipped:ai_unconfigured' }) }),
    )
    expect(reading.fields.document_type).toEqual({ value: 'credit_note', source: 'person', evidence: 'ditt_val' })
  })

  it("an agent's reading is a machine reading, never Ditt val", () => {
    const agent = { ...receiptExtraction(), confidence: 0.95 }
    const document = doc({
      extracted_data: agent,
      extraction_model: MODEL,
      extracted_at: READ_AT,
      model_reading: { extracted_data: receiptExtraction({ totals: { subtotal: null, vatAmount: null, total: 150 } }), extraction_model: MODEL, extracted_at: READ_AT },
    })
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: agent }), document }))
    expect(reading.notes).toEqual(['agent_reading'])
    expect(Object.values(reading.fields).some((f) => f?.source === 'person')).toBe(false)
    expect(reading.fields.amount_due_for_payment?.value).toBe(148)
  })
})

describe('the declared kind', () => {
  it('a +lev tag decides the kind, Stark when the model read the same', () => {
    const extraction = receiptExtraction({ documentKind: 'supplier_invoice' })
    const document = doc({ extracted_data: extraction, extraction_model: MODEL, extracted_at: READ_AT })
    const reading = resolveDocumentReading(inputs({ item: item({ extracted_data: clone(extraction), kind_hint: 'supplier_invoice' }), document }))
    expect(reading.fields.document_type).toEqual({ value: 'supplier_invoice', source: 'door', evidence: 'stark', corroborated_by: ['declared_kind'] })
  })
})

describe('a document without an inbox item', () => {
  it('reads the document row alone and names its door', () => {
    const extraction = receiptExtraction()
    const reading = resolveDocumentReading(inputs({ document: doc({ extracted_data: extraction, extraction_model: MODEL, extracted_at: READ_AT, upload_source: 'whatsapp' }) }))
    expect(reading.inbox_item_id).toBeNull()
    expect(reading.document_id).toBe(DOC_ID)
    expect(reading.door.intake_source).toBe('whatsapp')
    expect(reading.fields.seller_name?.source).toBe('vision')
  })

  it('is empty, not a failure, when nothing was read', () => {
    const reading = resolveDocumentReading(inputs({}))
    expect(reading).toEqual({ document_id: null, inbox_item_id: null, fields: {}, door: { intake_source: null, sender: null, received_at: null }, notes: [] })
  })
})
