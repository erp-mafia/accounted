import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { parseUblJsonDocument } from '@/lib/invoices/peppol-inbound-ubl'
import type { PeppolInboundRow } from '@/lib/invoices/peppol-inbound'

const uploadDocumentMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args),
}))
vi.mock('@/lib/suppliers/match-supplier', () => ({ matchSupplierId: vi.fn().mockResolvedValue(null) }))

import { deliverPeppolDocumentToInbox, recordPeppolArrival } from '@/lib/invoices/peppol-inbox-delivery'

const QVALIA_MESSAGE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'qvalia-inbound-invoice.json'), 'utf8'),
) as Record<string, unknown>
const document = parseUblJsonDocument(QVALIA_MESSAGE)!
const XML = '<Invoice><cbc:ID>20267497</cbc:ID></Invoice>'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const XML_DOC = '20000000-0000-4000-8000-000000000001'
const PDF_DOC = '20000000-0000-4000-8000-000000000002'
const ITEM = '10000000-0000-4000-8000-000000000001'
const XML_PATH = `documents/${COMPANY}/user-reg/1_peppol-faktura-20267497.xml`

function row(overrides: Partial<PeppolInboundRow> = {}): PeppolInboundRow {
  return {
    id: 'peppol-row-1',
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
    company_id: COMPANY,
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

const arrivals: TableMockResolver = (calls) => {
  const upsert = calls.find((c) => c.method === 'upsert')
  if (upsert) return { data: [{ ...(upsert.args[0] as Record<string, unknown>), created_at: '2026-08-21T13:56:00Z' }] }
  return { data: null }
}

function db(overrides: Record<string, unknown> = {}) {
  const mock = createTableMockSupabase({
    // First read: no inbox item yet; the insert then answers with the new id.
    invoice_inbox_items: [{ data: null }, { data: { id: ITEM } }],
    peppol_registrations: { data: { user_id: 'user-reg' } },
    document_attachments: {
      data: { storage_path: XML_PATH, sha256_hash: 'b'.repeat(64), mime_type: 'application/xml', file_size_bytes: 812 },
    },
    arrivals,
    arrival_outputs: { data: null },
    ...overrides,
  } as never)
  return { ...mock, client: mock.supabase as unknown as SupabaseClient }
}

beforeEach(() => {
  vi.clearAllMocks()
  uploadDocumentMock.mockImplementation(async (_s: unknown, _u: unknown, _c: unknown, file: { name: string }) => ({
    id: file.name.endsWith('.pdf') ? PDF_DOC : XML_DOC,
  }))
})

describe('Peppol arrivals', () => {
  it('records the e-invoice as an arrival pointing at the archived XML, and links the XML and the item', async () => {
    const { client, payloads } = db()
    const result = await deliverPeppolDocumentToInbox(client, { row: row(), companyId: COMPANY, document, xml: XML })
    expect(result).toEqual({ inboxItemId: ITEM, xmlDocumentId: XML_DOC })

    const [arrival] = payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({
      company_id: COMPANY,
      source: 'peppol',
      source_ref: 'a5845a11-4e5a-4700-bca3-e670a6cd8a79',
      received_at: '2026-08-21T13:55:00.000Z',
      sender: { name: 'Qvalia AB', org_number: '5567321707' },
      fetched_by: { type: 'system', label: 'peppol-inbound' },
      // The XML is stored once, as the document; the arrival points at it.
      original_path: XML_PATH,
      original_sha256: 'b'.repeat(64),
      original_mime: 'application/xml',
      original_size: 812,
    })
    expect(arrival!.source_meta).toMatchObject({ provider: 'qvalia', document_type: 'Invoice', xml_document_id: XML_DOC })
    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id, o.role])).toEqual([
      ['document', XML_DOC, 'xml'],
      ['inbox_item', ITEM, 'xml'],
    ])
  })

  it('links an embedded PDF as the rendering the inbox shows', async () => {
    const { client, payloads } = db()
    await recordPeppolArrival(client, {
      delivery: { row: row(), companyId: COMPANY, document, xml: XML },
      xmlDocumentId: XML_DOC,
      pdfDocumentId: PDF_DOC,
      inboxItemId: ITEM,
    })
    const outputs = payloads('arrival_outputs', 'upsert') as Array<Record<string, unknown>>
    expect(outputs.map((o) => [o.output_kind, o.output_id, o.role])).toEqual([
      ['document', XML_DOC, 'xml'],
      ['document', PDF_DOC, 'rendering'],
      ['inbox_item', ITEM, 'rendering'],
    ])
  })

  it('delivers the invoice even when the arrival cannot be recorded', async () => {
    const { client } = db({ arrivals: { data: null, error: { message: 'relation "arrivals" does not exist' } } })
    await expect(
      deliverPeppolDocumentToInbox(client, { row: row(), companyId: COMPANY, document, xml: XML }),
    ).resolves.toEqual({ inboxItemId: ITEM, xmlDocumentId: XML_DOC })
  })
})
