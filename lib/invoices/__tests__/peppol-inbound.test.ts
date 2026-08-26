import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import {
  archiveInboundPeppolMessage,
  processInboundPeppolRow,
  syncInboundPeppolDocuments,
  type PeppolInboundRow,
} from '@/lib/invoices/peppol-inbound'
import { parseUblJsonDocument } from '@/lib/invoices/peppol-inbound-ubl'
import type { PeppolInboundMessage, PeppolTransport } from '@/lib/invoices/peppol-transport'

const QVALIA_MESSAGE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'qvalia-inbound-invoice.json'), 'utf8'),
) as Record<string, unknown>

const { supabase: mockService, enqueue, reset, calls } = createQueuedMockSupabase()
const service = mockService as unknown as SupabaseClient
const log = createLogger('test')

const message: PeppolInboundMessage = {
  provider: 'qvalia',
  providerDocumentId: 'a5845a11-4e5a-4700-bca3-e670a6cd8a79',
  documentType: 'Invoice',
  payload: QVALIA_MESSAGE,
  receivedAt: '2026-08-21T13:55:00.000Z',
}

function makeTransport(overrides: Partial<PeppolTransport> = {}): PeppolTransport {
  return {
    provider: 'qvalia',
    lookupRecipient: vi.fn(),
    submit: vi.fn(),
    verifyWebhook: vi.fn(),
    retrieveEvidence: vi.fn(),
    listInboundDocuments: vi.fn().mockImplementation(async ({ documentType }: { documentType: string }) =>
      documentType === 'Invoice' ? [message] : []),
    fetchInboundDocumentXml: vi.fn().mockResolvedValue('<Invoice><cbc:ID>20267497</cbc:ID></Invoice>'),
    ...overrides,
  }
}

function row(overrides: Partial<PeppolInboundRow> = {}): PeppolInboundRow {
  return {
    id: 'doc-1',
    provider: 'qvalia',
    provider_document_id: message.providerDocumentId,
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
    company_id: null,
    status: 'received',
    inbox_item_id: null,
    supplier_invoice_id: null,
    xml_document_id: null,
    xml_payload: '<Invoice/>',
    xml_sha256: 'a'.repeat(64),
    ubl_json: QVALIA_MESSAGE,
    summary: {},
    received_at: '2026-08-21T13:55:00.000Z',
    processed_at: null,
    last_error: null,
    ...overrides,
  }
}

describe('archiveInboundPeppolMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('archives a new message with the exact XML, parsed header fields and the JSON payload', async () => {
    const transport = makeTransport()
    enqueue({ data: null, error: null })                       // no existing row
    enqueue({ data: row({ status: 'received' }), error: null }) // insert
    const result = await archiveInboundPeppolMessage({ service, transport, message, log })

    expect(result.created).toBe(true)
    expect(result.document?.documentId).toBe('20267497')
    const inserted = calls.find((c) => c.method === 'insert')?.args[0] as Record<string, unknown>
    expect(inserted).toMatchObject({
      provider: 'qvalia',
      provider_document_id: message.providerDocumentId,
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
      status: 'received',
      xml_payload: '<Invoice><cbc:ID>20267497</cbc:ID></Invoice>',
      received_at: '2026-08-21T13:55:00.000Z',
    })
    expect(inserted.xml_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledWith(message.providerDocumentId, 'Invoice')
  })

  it('returns the stored row for a message seen before and never re-fetches', async () => {
    const transport = makeTransport()
    enqueue({ data: row({ status: 'converted', company_id: 'company-1' }), error: null })
    const result = await archiveInboundPeppolMessage({ service, transport, message, log })
    expect(result.created).toBe(false)
    expect(result.row.status).toBe('converted')
    expect(transport.fetchInboundDocumentXml).not.toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'insert')).toBe(false)
  })

  it('archives the JSON even when the XML fetch fails, so nothing is lost', async () => {
    const transport = makeTransport({ fetchInboundDocumentXml: vi.fn().mockRejectedValue(new Error('timeout')) })
    enqueue({ data: null, error: null })
    enqueue({ data: row({ xml_payload: null, xml_sha256: null }), error: null })
    const result = await archiveInboundPeppolMessage({ service, transport, message, log })
    expect(result.created).toBe(true)
    const inserted = calls.find((c) => c.method === 'insert')?.args[0] as Record<string, unknown>
    expect(inserted.xml_payload).toBeNull()
    expect(inserted.ubl_json).toBe(QVALIA_MESSAGE)
  })
})

describe('processInboundPeppolRow', () => {
  const document = parseUblJsonDocument(QVALIA_MESSAGE)!

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('routes to the registered company and delivers to the inbox', async () => {
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: 'inbox-1', xmlDocumentId: 'doc-xml-1' })
    enqueue({ data: { company_id: 'company-1' }, error: null })                  // registration lookup
    enqueue({ data: row({ company_id: 'company-1', status: 'routed' }), error: null }) // route update
    enqueue({ data: row({ company_id: 'company-1', status: 'converted', inbox_item_id: 'inbox-1' }), error: null })

    const result = await processInboundPeppolRow({ service, row: row(), document, deliver, log })

    expect(result.outcome).toBe('delivered')
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', document }))
    const updates = calls.filter((c) => c.method === 'update').map((c) => c.args[0] as Record<string, unknown>)
    expect(updates[0]).toMatchObject({ company_id: 'company-1', status: 'routed' })
    expect(updates[1]).toMatchObject({ status: 'converted', inbox_item_id: 'inbox-1', xml_document_id: 'doc-xml-1' })
  })

  it('marks a document for an unregistered recipient as unrouted, and never delivers it', async () => {
    const deliver = vi.fn()
    enqueue({ data: null, error: null })                                          // no registration
    enqueue({ data: row({ status: 'unrouted' }), error: null })
    const result = await processInboundPeppolRow({ service, row: row(), document, deliver, log })
    expect(result.outcome).toBe('unrouted')
    expect(deliver).not.toHaveBeenCalled()
  })

  it('records a failed delivery with the reason and leaves the row retryable', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('storage down'))
    enqueue({ data: row({ company_id: 'company-1', status: 'failed', last_error: 'storage down' }), error: null })
    const result = await processInboundPeppolRow({
      service, row: row({ company_id: 'company-1', status: 'routed' }), document, deliver, log,
    })
    expect(result.outcome).toBe('failed')
    const update = calls.find((c) => c.method === 'update')?.args[0] as Record<string, unknown>
    expect(update).toMatchObject({ status: 'failed', last_error: 'storage down' })
  })

  it('skips rows that are already converted or ignored', async () => {
    const deliver = vi.fn()
    const result = await processInboundPeppolRow({
      service, row: row({ company_id: 'company-1', status: 'converted' }), document, deliver, log,
    })
    expect(result.outcome).toBe('skipped')
    expect(calls).toHaveLength(0)
  })
})

describe('syncInboundPeppolDocuments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('lists invoices and credit notes, archives, routes and delivers, and counts the outcome', async () => {
    const transport = makeTransport()
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: 'inbox-1', xmlDocumentId: null })
    enqueue({ data: null, error: null })                                          // no existing archive row
    enqueue({ data: row(), error: null })                                         // insert
    enqueue({ data: { company_id: 'company-1' }, error: null })                   // registration
    enqueue({ data: row({ company_id: 'company-1', status: 'routed' }), error: null })
    enqueue({ data: row({ company_id: 'company-1', status: 'converted' }), error: null })

    const summary = await syncInboundPeppolDocuments({ service, transport, deliver, log })

    expect(transport.listInboundDocuments).toHaveBeenCalledTimes(2)
    expect(summary).toMatchObject({ listed: 1, archived: 1, duplicates: 0, delivered: 1, failed: 0, unrouted: 0 })
    expect(summary.errors).toEqual([])
  })

  it('keeps going when the provider listing fails for one document type', async () => {
    const transport = makeTransport({
      listInboundDocuments: vi.fn()
        .mockRejectedValueOnce(new Error('Qvalia answered 503'))
        .mockResolvedValueOnce([]),
    })
    const summary = await syncInboundPeppolDocuments({ service, transport, deliver: null, log })
    expect(summary.errors).toEqual([{ providerDocumentId: 'list:Invoice', reason: 'Qvalia answered 503' }])
    expect(transport.listInboundDocuments).toHaveBeenCalledTimes(2)
  })

  it('is a no-op for a send-only transport', async () => {
    const transport = makeTransport({ listInboundDocuments: undefined })
    const summary = await syncInboundPeppolDocuments({ service, transport, deliver: null, log })
    expect(summary.listed).toBe(0)
  })
})
