import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { parseUblJsonDocument } from '@/lib/invoices/peppol-inbound-ubl'
import type { PeppolInboundRow } from '@/lib/invoices/peppol-inbound'

const uploadDocumentMock = vi.fn()
const matchSupplierIdMock = vi.fn()

vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args),
}))
vi.mock('@/lib/suppliers/match-supplier', () => ({
  matchSupplierId: (...args: unknown[]) => matchSupplierIdMock(...args),
}))

import {
  deliverPeppolDocumentToInbox,
  peppolDocumentToExtraction,
} from '@/lib/invoices/peppol-inbox-delivery'

const QVALIA_MESSAGE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'qvalia-inbound-invoice.json'), 'utf8'),
) as Record<string, unknown>
const document = parseUblJsonDocument(QVALIA_MESSAGE)!
const XML = '<Invoice><cbc:ID>20267497</cbc:ID></Invoice>'

const { supabase: mockService, enqueue, reset, calls } = createQueuedMockSupabase()
const service = mockService as unknown as SupabaseClient

function row(overrides: Partial<PeppolInboundRow> = {}): PeppolInboundRow {
  return {
    id: 'doc-1',
    provider: 'qvalia',
    provider_document_id: 'a5845a11-4e5a-4700-bca3-e670a6cd8a79',
    document_type: 'Invoice',
    document_id: '20267497',
    issue_date: '2026-08-21',
    due_date: '2026-09-20',
    currency: 'SEK',
    payable_amount: 112,
    sender_scheme: '0007',
    sender_identifier: '5567321707',
    sender_name: 'Qvalia AB',
    recipient_scheme: '0007',
    recipient_identifier: '5595386219',
    company_id: 'company-1',
    status: 'routed',
    inbox_item_id: null,
    supplier_invoice_id: null,
    xml_document_id: null,
    xml_payload: XML,
    xml_sha256: 'a'.repeat(64),
    ubl_json: QVALIA_MESSAGE,
    summary: {},
    received_at: '2026-08-21T13:55:00.000Z',
    processed_at: null,
    last_error: null,
    ...overrides,
  }
}

describe('peppolDocumentToExtraction', () => {
  it('maps the Qvalia invoice onto the inbox extraction shape without a model', () => {
    const extracted = peppolDocumentToExtraction(document)
    expect(extracted).toMatchObject({
      documentKind: 'supplier_invoice',
      supplier: {
        name: 'Qvalia AB',
        orgNumber: '5567321707',
        vatNumber: 'SE556732170701',
        address: 'Wallingatan 33 3tr, 11124 Stockholm',
        bankgiro: null,
        plusgiro: null,
      },
      invoice: {
        invoiceNumber: '20267497',
        invoiceDate: '2026-08-21',
        dueDate: '2026-09-20',
        paymentReference: null,
        currency: 'SEK',
      },
      totals: { subtotal: 100, vatAmount: 12, total: 112, roundingAmount: null },
      vatBreakdown: [{ rate: 12, base: 100, amount: 12 }],
      confidence: 1,
    })
    expect(extracted.lineItems).toEqual([{
      description: 'New test item',
      quantity: 1,
      unitPrice: 100,
      lineTotal: 100,
      vatRate: 12,
      accountSuggestion: null,
    }])
  })

  it('formats Swedish giro numbers with a hyphen and negates credit notes', () => {
    const credit = {
      ...document,
      documentType: 'CreditNote' as const,
      paymentMeans: [{ ...document.paymentMeans[0], bankgiro: '9912346', paymentId: '123456789' }],
    }
    const extracted = peppolDocumentToExtraction(credit)
    expect(extracted.supplier.bankgiro).toBe('991-2346')
    expect(extracted.invoice.paymentReference).toBe('123456789')
    expect(extracted.totals.total).toBe(-112)
    expect(extracted.lineItems[0].lineTotal).toBe(-100)
    expect(extracted.vatBreakdown[0]).toEqual({ rate: 12, base: -100, amount: -12 })
  })
})

describe('deliverPeppolDocumentToInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    uploadDocumentMock.mockImplementation(async (_s: unknown, _u: unknown, _c: unknown, file: { name: string }) => ({
      id: file.name.endsWith('.pdf') ? 'doc-pdf' : 'doc-xml',
    }))
    matchSupplierIdMock.mockResolvedValue('supplier-9')
  })

  it('archives the exact XML, creates the inbox item with structured data and the Peppol channel context', async () => {
    enqueue({ data: null, error: null })                               // no existing inbox item
    enqueue({ data: { user_id: 'user-reg' }, error: null })            // registration owner
    enqueue({ data: { id: 'inbox-1' }, error: null })                  // inbox insert

    const result = await deliverPeppolDocumentToInbox(service, { row: row(), companyId: 'company-1', document, xml: XML })

    expect(result).toEqual({ inboxItemId: 'inbox-1', xmlDocumentId: 'doc-xml' })
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1)
    const [, userId, companyId, file, metadata] = uploadDocumentMock.mock.calls[0]
    expect(userId).toBe('user-reg')
    expect(companyId).toBe('company-1')
    expect(file).toMatchObject({ name: 'peppol-faktura-20267497.xml', type: 'application/xml' })
    expect(Buffer.from(file.buffer as ArrayBuffer).toString('utf8')).toBe(XML)
    expect(metadata).toEqual({ upload_source: 'e_invoice', dedupeByContent: true, extractionOwner: 'none' })
    expect(matchSupplierIdMock).toHaveBeenCalledWith(service, 'company-1', {
      orgNumber: '5567321707', vatNumber: 'SE556732170701', name: 'Qvalia AB',
    })

    const inserted = calls.find((c) => c.method === 'insert')?.args[0] as Record<string, unknown>
    expect(inserted).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-reg',
      document_id: 'doc-xml',
      source: 'peppol',
      status: 'received',
      extraction_skipped: false,
      matched_supplier_id: 'supplier-9',
      email_from: 'Qvalia AB',
      channel_context: {
        channel: 'peppol',
        peppol_provider: 'qvalia',
        peppol_document_id: 'a5845a11-4e5a-4700-bca3-e670a6cd8a79',
        peppol_document_type: 'Invoice',
        peppol_sender_endpoint: '0007:5567321707',
        peppol_xml_document_id: 'doc-xml',
      },
    })
    expect((inserted.extracted_data as { confidence: number }).confidence).toBe(1)
  })

  it('prefers an embedded PDF as the inbox document and falls back to the first owner', async () => {
    const withPdf = {
      ...document,
      attachments: [{ id: 'a1', description: null, filename: 'faktura.pdf', mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.4').toString('base64'), externalUri: null }],
    }
    enqueue({ data: null, error: null })                               // no existing item
    enqueue({ data: null, error: null })                               // no registration user
    enqueue({ data: { user_id: 'user-owner' }, error: null })          // company owner
    enqueue({ data: { id: 'inbox-2' }, error: null })

    const result = await deliverPeppolDocumentToInbox(service, { row: row(), companyId: 'company-1', document: withPdf, xml: XML })
    expect(result).toEqual({ inboxItemId: 'inbox-2', xmlDocumentId: 'doc-xml' })
    expect(uploadDocumentMock).toHaveBeenCalledTimes(2)
    expect(uploadDocumentMock.mock.calls[1][3]).toMatchObject({ name: 'faktura.pdf', type: 'application/pdf' })
    const inserted = calls.find((c) => c.method === 'insert')?.args[0] as Record<string, unknown>
    expect(inserted).toMatchObject({ document_id: 'doc-pdf', user_id: 'user-owner' })
  })

  it('is idempotent: an existing inbox item for the provider document is returned, nothing re-archived', async () => {
    enqueue({ data: { id: 'inbox-1', document_id: 'doc-xml', channel_context: { channel: 'peppol', peppol_xml_document_id: 'doc-xml' } }, error: null })
    const result = await deliverPeppolDocumentToInbox(service, { row: row(), companyId: 'company-1', document, xml: XML })
    expect(result).toEqual({ inboxItemId: 'inbox-1', xmlDocumentId: 'doc-xml' })
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('resolves a concurrent insert race through the per-channel unique index', async () => {
    enqueue({ data: null, error: null })
    enqueue({ data: { user_id: 'user-reg' }, error: null })
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
    enqueue({ data: { id: 'inbox-raced' }, error: null })
    const result = await deliverPeppolDocumentToInbox(service, { row: row(), companyId: 'company-1', document, xml: XML })
    expect(result.inboxItemId).toBe('inbox-raced')
  })
})
