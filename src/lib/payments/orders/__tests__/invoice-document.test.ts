import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  checkAgainstDocument,
  invoiceDocumentFacts,
  loadInvoiceDocumentFacts,
  referenceLabel,
  statedPayeeLabel,
  withInvoiceDocument,
} from '../invoice-document'

const DOC = '5b1f4b8e-8f0e-4d3a-9b7c-2a1e6f0c9d11'

describe('statedPayeeLabel', () => {
  it('labels the account the document states the way the paid account is labelled', () => {
    expect(statedPayeeLabel({ payee_bankgiro: '5050-1055' })).toBe('BG 5050-1055')
    expect(statedPayeeLabel({ payee_plusgiro: '123456-7' })).toBe('PG 123456-7')
    expect(statedPayeeLabel({ payee_clearing: '8327-9', payee_account: '123 456 789' })).toBe('83279 123456789')
    expect(statedPayeeLabel({ payee_iban: 'se45 5000 0000 0583 9825 7466' })).toBe('SE4550000000058398257466')
  })

  it('reads the giro before the bank account, as the payment rules do', () => {
    expect(statedPayeeLabel({ payee_bankgiro: '5402-0102', payee_clearing: '3300', payee_account: '1234567' })).toBe('BG 5402-0102')
  })

  it('answers null when the document states no account', () => {
    expect(statedPayeeLabel({})).toBeNull()
    expect(statedPayeeLabel({ payee_bankgiro: '  ', payee_iban: null })).toBeNull()
  })
})

describe('referenceLabel', () => {
  it('calls a reference of digits an OCR and leaves text as written', () => {
    expect(referenceLabel('4400 1122 33')).toBe('OCR 4400112233')
    expect(referenceLabel('F-2026-17')).toBe('F-2026-17')
  })
})

describe('invoiceDocumentFacts', () => {
  it('reads the document, the stated account and reference, the total and the due date', () => {
    expect(
      invoiceDocumentFacts({
        document_id: DOC,
        payee_bankgiro: '5050-1055',
        payment_reference: ' 4400112233 ',
        total: '737.50',
        currency: 'SEK',
        due_date: '2026-10-20',
        document: { mime_type: 'application/pdf', file_name: 'faktura.pdf' },
      }),
    ).toEqual({
      document_id: DOC,
      mime_type: 'application/pdf',
      file_name: 'faktura.pdf',
      payee: 'BG 5050-1055',
      reference: '4400112233',
      amount: 737.5,
      currency: 'SEK',
      due_date: '2026-10-20',
    })
  })

  it('answers nulls for an invoice without a document or stated details', () => {
    expect(invoiceDocumentFacts({ payment_reference: '', total: null })).toEqual({
      document_id: null,
      mime_type: null,
      file_name: null,
      payee: null,
      reference: null,
      amount: null,
      currency: null,
      due_date: null,
    })
  })
})

describe('checkAgainstDocument', () => {
  const facts = { payee: 'BG 5050-1055', reference: '4400 1122 33' }

  it('same: the payment pays the stated account and reference, however they are spaced', () => {
    expect(checkAgainstDocument({ payee: 'BG 5050-1055', reference: '4400112233' }, facts)).toEqual({ payee: 'same', reference: 'same' })
    expect(checkAgainstDocument({ payee: 'bg 50501055', reference: '4400-1122-33' }, facts)).toEqual({ payee: 'same', reference: 'same' })
  })

  it('differs: another account (the card over the invoice) or another reference (an OCR that failed its check)', () => {
    expect(checkAgainstDocument({ payee: 'BG 5402-0102', reference: 'F-17' }, facts)).toEqual({ payee: 'differs', reference: 'differs' })
    // A plusgiro with the same digits is still another account.
    expect(checkAgainstDocument({ payee: 'PG 5050105-5', reference: '4400112233' }, { payee: 'BG 5050-1055', reference: null }).payee).toBe('differs')
    expect(checkAgainstDocument({ payee: null, reference: undefined }, facts)).toEqual({ payee: 'differs', reference: 'differs' })
  })

  it('missing: the document states nothing to compare with', () => {
    expect(checkAgainstDocument({ payee: 'BG 5050-1055', reference: 'F-17' }, { payee: null, reference: null })).toEqual({ payee: 'missing', reference: 'missing' })
    expect(checkAgainstDocument({ payee: 'BG 5050-1055', reference: 'F-17' }, { payee: ' - ', reference: '' })).toEqual({ payee: 'missing', reference: 'missing' })
  })
})

describe('withInvoiceDocument', () => {
  const line = {
    supplier_invoice_id: 'a',
    payee: { type: 'bankgiro', label: 'BG 5050-1055', source: 'supplier' },
    reference: { type: 'ocr', value: '4400112233' },
  }

  it('adds the document and the comparison to a line, leaving the line itself as it was', () => {
    const documents = new Map([['a', invoiceDocumentFacts({ document_id: DOC, payee_bankgiro: '5402-0102', payment_reference: '4400112233' })]])
    const result = withInvoiceDocument(line, documents)
    expect(result).toMatchObject(line)
    expect(result.document).toMatchObject({ document_id: DOC, payee: 'BG 5402-0102', checks: { payee: 'differs', reference: 'same' } })
  })

  it('leaves a line whose invoice was not read untouched', () => {
    expect(withInvoiceDocument(line, new Map())).toBe(line)
  })
})

describe('loadInvoiceDocumentFacts', () => {
  it('reads the invoices of the company only, with the document row', async () => {
    const db = createTableMockSupabase({
      supplier_invoices: { data: [{ id: 'a', document_id: DOC, payee_bankgiro: null, payment_reference: '4400112233', total: 100, currency: 'SEK', due_date: '2026-10-20', document: { mime_type: 'image/png', file_name: 'scan.png' } }] },
    })
    const facts = await loadInvoiceDocumentFacts(db.supabase as never, 'company-1', ['a'])
    expect(facts.get('a')).toMatchObject({ document_id: DOC, mime_type: 'image/png', reference: '4400112233', amount: 100 })
    expect(db.findCall('supplier_invoices', 'eq')).toEqual(['company_id', 'company-1'])
    expect(db.findCall('supplier_invoices', 'in')).toEqual(['id', ['a']])
    const [columns] = db.findCall('supplier_invoices', 'select') as [string]
    // The document embed names its relationship (check:guards ambiguous-embed).
    expect(columns).toContain('document:document_attachments!supplier_invoices_document_id_fkey(mime_type, file_name)')
  })

  it('asks nothing for no invoices and throws a failed read', async () => {
    const db = createTableMockSupabase({ supplier_invoices: { data: null, error: { message: 'boom' } } })
    expect((await loadInvoiceDocumentFacts(db.supabase as never, 'company-1', [])).size).toBe(0)
    expect(db.findCall('supplier_invoices', 'select')).toBeUndefined()
    await expect(loadInvoiceDocumentFacts(db.supabase as never, 'company-1', ['a'])).rejects.toMatchObject({ message: 'boom' })
  })
})
