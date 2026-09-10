import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { sha256Hex } from '@/lib/invoices/peppol-delivery'
import {
  PEPPOL_INBOUND_AWAITING_XML,
  PEPPOL_INBOUND_XML_UNAVAILABLE,
  archiveInboundPeppolMessage,
  processInboundPeppolRow,
  reprocessInboundPeppolDocuments,
  resolvePeppolRecipientCompany,
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

const FETCHED_XML = '<Invoice><cbc:ID>20267497</cbc:ID></Invoice>'

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
    fetchInboundDocumentXml: vi.fn().mockResolvedValue(FETCHED_XML),
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

const registration = (participantIdentifier = '5595386219') => ({
  data: [{ company_id: 'company-1', participant_identifier: participantIdentifier }],
  error: null,
})

function updates(): Record<string, unknown>[] {
  return calls
    .filter((c) => c.table === 'peppol_inbound_documents' && c.method === 'update')
    .map((c) => c.args[0] as Record<string, unknown>)
}

describe('resolvePeppolRecipientCompany', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('routes hyphenated and 16-prefixed EndpointIDs to the digits-only registration', async () => {
    for (const identifier of ['559538-6219', '165595386219', '16 559538-6219', '5595386219']) {
      reset()
      enqueue(registration('5595386219'))
      const companyId = await resolvePeppolRecipientCompany({ service, provider: 'qvalia', scheme: '0007', identifier })
      expect(companyId, identifier).toBe('company-1')
    }
  })

  it('matches a registration stored with formatting against a clean endpoint', async () => {
    enqueue(registration('559538-6219'))
    const companyId = await resolvePeppolRecipientCompany({ service, provider: 'qvalia', scheme: '0007', identifier: '5595386219' })
    expect(companyId).toBe('company-1')
    // The comparison happens in code, on the normalised form, never as a raw equality filter.
    const filters = calls.filter((c) => c.table === 'peppol_registrations' && c.method === 'eq').map((c) => c.args[0])
    expect(filters).toEqual(['provider', 'participant_scheme', 'status'])
  })

  it('returns null for another organisation and for an empty identifier without querying', async () => {
    enqueue(registration('5595386219'))
    expect(await resolvePeppolRecipientCompany({ service, provider: 'qvalia', scheme: '0007', identifier: '5567321707' })).toBeNull()
    reset()
    expect(await resolvePeppolRecipientCompany({ service, provider: 'qvalia', scheme: '0007', identifier: '--' })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

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
      xml_payload: FETCHED_XML,
      received_at: '2026-08-21T13:55:00.000Z',
    })
    expect(inserted.xml_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledWith(message.providerDocumentId, 'Invoice')
  })

  it('returns the stored row for a message seen before without re-fetching XML it already holds', async () => {
    const transport = makeTransport()
    enqueue({ data: row({ status: 'converted', company_id: 'company-1' }), error: null })
    const result = await archiveInboundPeppolMessage({ service, transport, message, log })
    expect(result.created).toBe(false)
    expect(result.row.status).toBe('converted')
    expect(transport.fetchInboundDocumentXml).not.toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'insert')).toBe(false)
  })

  it('fetches and stores the XML for a message seen before whose archive lacks it', async () => {
    const transport = makeTransport()
    enqueue({ data: row({ xml_payload: null, xml_sha256: null }), error: null })
    enqueue({ data: row({ xml_payload: FETCHED_XML, xml_sha256: sha256Hex(FETCHED_XML) }), error: null })
    const result = await archiveInboundPeppolMessage({ service, transport, message, log })
    expect(result.created).toBe(false)
    expect(result.row.xml_payload).toBe(FETCHED_XML)
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledWith(message.providerDocumentId, 'Invoice')
    expect(updates()[0]).toMatchObject({ xml_payload: FETCHED_XML, xml_sha256: sha256Hex(FETCHED_XML) })
    expect(updates()[0].processed_at).toEqual(expect.any(String))
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
    enqueue(registration())                                                        // registration lookup
    enqueue({ data: row({ company_id: 'company-1', status: 'routed' }), error: null }) // route update
    enqueue({ data: row({ company_id: 'company-1', status: 'converted', inbox_item_id: 'inbox-1' }), error: null })

    const result = await processInboundPeppolRow({ service, row: row(), document, deliver, log })

    expect(result.outcome).toBe('delivered')
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', document }))
    expect(updates()[0]).toMatchObject({ company_id: 'company-1', status: 'routed' })
    expect(updates()[1]).toMatchObject({ status: 'converted', inbox_item_id: 'inbox-1', xml_document_id: 'doc-xml-1' })
  })

  it('marks a document for an unregistered recipient as unrouted, and never delivers it', async () => {
    const deliver = vi.fn()
    enqueue({ data: [], error: null })                                            // no registration
    enqueue({ data: row({ status: 'unrouted' }), error: null })
    const result = await processInboundPeppolRow({ service, row: row(), document, deliver, log })
    expect(result.outcome).toBe('unrouted')
    expect(deliver).not.toHaveBeenCalled()
  })

  it('holds a delivery the deliverer declined: no inbox item, the row stays routed with the reason', async () => {
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: null, xmlDocumentId: null, holdReason: PEPPOL_INBOUND_AWAITING_XML })
    enqueue({ data: row({ company_id: 'company-1', status: 'routed', last_error: PEPPOL_INBOUND_AWAITING_XML }), error: null })
    const result = await processInboundPeppolRow({
      service, row: row({ company_id: 'company-1', status: 'routed', xml_payload: null, xml_sha256: null }), document, deliver, log,
    })
    expect(result.outcome).toBe('routed')
    expect(updates()).toHaveLength(1)
    expect(updates()[0]).toMatchObject({ status: 'routed', last_error: PEPPOL_INBOUND_AWAITING_XML })
    expect(updates()[0]).not.toHaveProperty('inbox_item_id')
  })

  it('records a failed delivery with the reason and leaves the row retryable', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('storage down'))
    enqueue({ data: row({ company_id: 'company-1', status: 'failed', last_error: 'storage down' }), error: null })
    const result = await processInboundPeppolRow({
      service, row: row({ company_id: 'company-1', status: 'routed' }), document, deliver, log,
    })
    expect(result.outcome).toBe('failed')
    expect(updates()[0]).toMatchObject({ status: 'failed', last_error: 'storage down', processed_at: expect.any(String) })
  })

  it('skips rows that are already converted, ignored or terminal', async () => {
    const deliver = vi.fn()
    for (const overrides of [
      { company_id: 'company-1', status: 'converted' as const },
      { company_id: 'company-1', status: 'ignored' as const },
      { status: 'unrouted' as const, last_error: PEPPOL_INBOUND_XML_UNAVAILABLE },
    ]) {
      const result = await processInboundPeppolRow({ service, row: row(overrides), document, deliver, log })
      expect(result.outcome).toBe('skipped')
    }
    expect(calls).toHaveLength(0)
    expect(deliver).not.toHaveBeenCalled()
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
    enqueue({ data: { received_at: '2026-08-20T10:00:00.000Z' }, error: null })   // invoice cursor
    enqueue({ data: null, error: null })                                          // no existing archive row
    enqueue({ data: row(), error: null })                                         // insert
    enqueue(registration())                                                       // registration
    enqueue({ data: row({ company_id: 'company-1', status: 'routed' }), error: null })
    enqueue({ data: row({ company_id: 'company-1', status: 'converted' }), error: null })
    enqueue({ data: null, error: null })                                          // credit note cursor: nothing archived

    const summary = await syncInboundPeppolDocuments({ service, transport, deliver, log })

    expect(transport.listInboundDocuments).toHaveBeenCalledTimes(2)
    expect(summary).toMatchObject({ listed: 1, archived: 1, duplicates: 0, delivered: 1, failed: 0, unrouted: 0 })
    expect(summary.errors).toEqual([])
  })

  it('passes the newest archived received_at per document type as the listing cursor', async () => {
    const transport = makeTransport({ listInboundDocuments: vi.fn().mockResolvedValue([]) })
    enqueue({ data: { received_at: '2026-08-20T10:00:00.000Z' }, error: null })   // invoice cursor
    enqueue({ data: null, error: null })                                          // credit note cursor
    await syncInboundPeppolDocuments({ service, transport, deliver: null, log })
    const listCalls = (transport.listInboundDocuments as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(listCalls[0]).toEqual({ documentType: 'Invoice', limit: 50, receivedAfter: '2026-08-20T10:00:00.000Z' })
    expect(listCalls[1]).toEqual({ documentType: 'CreditNote', limit: 50 })
    const cursorReads = calls.filter((c) => c.table === 'peppol_inbound_documents' && c.method === 'order')
    expect(cursorReads.map((c) => c.args)).toEqual([
      ['received_at', { ascending: false }],
      ['received_at', { ascending: false }],
    ])
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

describe('reprocessInboundPeppolDocuments', () => {
  const now = new Date('2026-09-10T12:00:00.000Z')
  const stamped = (overrides: Partial<PeppolInboundRow>) => row({ ...overrides, processed_at: now.toISOString() })

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('selects pending rows of this provider outside the backoff, terminal rows excluded, least recently processed first', async () => {
    const transport = makeTransport()
    enqueue({ data: [], error: null })
    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver: null, log, now })
    expect(result).toEqual({ candidates: 0, xmlFetched: 0, routed: 0, delivered: 0, terminal: 0, errors: [] })
    const query = calls.filter((c) => c.table === 'peppol_inbound_documents')
    expect(query.find((c) => c.method === 'eq')?.args).toEqual(['provider', 'qvalia'])
    expect(query.find((c) => c.method === 'in')?.args).toEqual(['status', ['received', 'routed', 'unrouted', 'failed']])
    expect(query.filter((c) => c.method === 'or').map((c) => c.args[0])).toEqual([
      'processed_at.is.null,processed_at.lt.2026-09-10T11:30:00.000Z',
      'last_error.is.null,last_error.not.like.terminal:*',
    ])
    expect(query.find((c) => c.method === 'order')?.args).toEqual(['processed_at', { ascending: true, nullsFirst: true }])
    expect(query.find((c) => c.method === 'limit')?.args).toEqual([25])
  })

  it('skips a terminal row without touching it', async () => {
    const transport = makeTransport()
    enqueue({ data: [row({ status: 'unrouted', xml_payload: null, xml_sha256: null, last_error: PEPPOL_INBOUND_XML_UNAVAILABLE })], error: null })
    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver: null, log, now })
    expect(result).toMatchObject({ candidates: 1, terminal: 1, xmlFetched: 0, errors: [] })
    expect(updates()).toHaveLength(0)
    expect(transport.fetchInboundDocumentXml).not.toHaveBeenCalled()
  })

  it('fetches the missing XML, stores payload and hash, and then files the held document', async () => {
    const transport = makeTransport()
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: 'inbox-1', xmlDocumentId: 'doc-xml-1' })
    const held = row({ company_id: 'company-1', status: 'routed', xml_payload: null, xml_sha256: null, last_error: PEPPOL_INBOUND_AWAITING_XML, processed_at: '2026-09-10T10:00:00.000Z' })
    enqueue({ data: [held], error: null })                                        // candidates
    enqueue({ data: stamped(held), error: null })                                 // processed_at stamp
    enqueue({ data: stamped({ ...held, xml_payload: FETCHED_XML, xml_sha256: sha256Hex(FETCHED_XML) }), error: null }) // xml stored
    enqueue({ data: stamped({ ...held, xml_payload: FETCHED_XML, status: 'converted', inbox_item_id: 'inbox-1' }), error: null })

    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })

    expect(result).toEqual({ candidates: 1, xmlFetched: 1, routed: 0, delivered: 1, terminal: 0, errors: [] })
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledWith(held.provider_document_id, 'Invoice')
    expect(updates()[0]).toEqual({ processed_at: now.toISOString() })
    expect(updates()[1]).toEqual({ xml_payload: FETCHED_XML, xml_sha256: sha256Hex(FETCHED_XML), processed_at: now.toISOString() })
    expect(updates()[2]).toMatchObject({ status: 'converted', inbox_item_id: 'inbox-1', xml_document_id: 'doc-xml-1', last_error: null })
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', xml: FETCHED_XML }))
  })

  it('records a null XML answer as terminal once and never asks for it again', async () => {
    const transport = makeTransport({ fetchInboundDocumentXml: vi.fn().mockResolvedValue(null) })
    const deliver = vi.fn()
    const pending = row({ status: 'received', xml_payload: null, xml_sha256: null })
    enqueue({ data: [pending], error: null })
    enqueue({ data: stamped(pending), error: null })
    const terminalRow = stamped({ ...pending, last_error: PEPPOL_INBOUND_XML_UNAVAILABLE })
    enqueue({ data: terminalRow, error: null })

    const first = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })
    expect(first).toMatchObject({ candidates: 1, terminal: 1, xmlFetched: 0, delivered: 0, errors: [] })
    expect(updates()[1]).toEqual({ last_error: PEPPOL_INBOUND_XML_UNAVAILABLE, processed_at: now.toISOString() })
    expect(deliver).not.toHaveBeenCalled()
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledTimes(1)

    // A later pass that still sees the row (defensive: the query excludes it) leaves it alone.
    reset()
    enqueue({ data: [terminalRow], error: null })
    const second = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })
    expect(second).toMatchObject({ candidates: 1, terminal: 1 })
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledTimes(1)
    expect(updates()).toHaveLength(0)
  })

  it('keeps a transport error retryable and still re-runs routing', async () => {
    const transport = makeTransport({ fetchInboundDocumentXml: vi.fn().mockRejectedValue(new Error('timeout')) })
    const pending = row({ status: 'unrouted', xml_payload: null, xml_sha256: null })
    enqueue({ data: [pending], error: null })
    enqueue({ data: stamped(pending), error: null })                              // stamp
    enqueue({ data: [], error: null })                                            // still no registration
    enqueue({ data: stamped({ ...pending, status: 'unrouted' }), error: null })   // unrouted update

    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver: vi.fn(), log, now })

    expect(result).toMatchObject({ candidates: 1, xmlFetched: 0, terminal: 0, routed: 0, delivered: 0 })
    expect(result.errors).toEqual([{ id: 'doc-1', providerDocumentId: pending.provider_document_id, reason: 'timeout' }])
    expect(updates().some((u) => typeof u.last_error === 'string' && u.last_error.startsWith('terminal:'))).toBe(false)
    expect(calls.some((c) => c.table === 'peppol_registrations')).toBe(true)
  })

  it('routes an unrouted document once its registration appears and delivers it', async () => {
    const transport = makeTransport()
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: 'inbox-2', xmlDocumentId: 'doc-xml-2' })
    const unrouted = row({ status: 'unrouted', recipient_identifier: '5595386219', processed_at: '2026-09-01T00:00:00.000Z' })
    enqueue({ data: [unrouted], error: null })
    enqueue({ data: stamped(unrouted), error: null })                             // stamp
    enqueue(registration('5595386219'))                                           // the company registered since
    enqueue({ data: stamped({ ...unrouted, company_id: 'company-1', status: 'routed' }), error: null })
    enqueue({ data: stamped({ ...unrouted, company_id: 'company-1', status: 'converted', inbox_item_id: 'inbox-2' }), error: null })

    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })

    expect(result).toEqual({ candidates: 1, xmlFetched: 0, routed: 1, delivered: 1, terminal: 0, errors: [] })
    expect(transport.fetchInboundDocumentXml).not.toHaveBeenCalled()
    expect(updates()[1]).toMatchObject({ company_id: 'company-1', status: 'routed' })
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', xml: '<Invoice/>' }))
  })

  it('reports a failed delivery as a retryable error carrying the row id', async () => {
    const transport = makeTransport()
    const deliver = vi.fn().mockRejectedValue(new Error('storage down'))
    const failed = row({ company_id: 'company-1', status: 'failed', last_error: 'storage down', processed_at: '2026-09-10T09:00:00.000Z' })
    enqueue({ data: [failed], error: null })
    enqueue({ data: stamped(failed), error: null })
    enqueue({ data: stamped({ ...failed, last_error: 'storage down' }), error: null })

    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })

    expect(result.errors).toEqual([{ id: 'doc-1', providerDocumentId: failed.provider_document_id, reason: 'storage down' }])
    expect(result.delivered).toBe(0)
  })

  it('bounds the pass by the limit and keeps going past a row that throws', async () => {
    const transport = makeTransport()
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: 'inbox-3', xmlDocumentId: null })
    const first = row({ id: 'doc-a', provider_document_id: 'pd-a', company_id: 'company-1', status: 'failed' })
    const second = row({ id: 'doc-b', provider_document_id: 'pd-b', company_id: 'company-1', status: 'failed' })
    enqueue({ data: [first, second], error: null })
    enqueue({ data: null, error: { message: 'connection reset' } })              // stamp of doc-a fails
    enqueue({ data: stamped(second), error: null })                               // stamp of doc-b
    enqueue({ data: stamped({ ...second, status: 'converted', inbox_item_id: 'inbox-3' }), error: null })

    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now, limit: 2 })

    expect(calls.find((c) => c.table === 'peppol_inbound_documents' && c.method === 'limit')?.args).toEqual([2])
    expect(result.candidates).toBe(2)
    expect(result.delivered).toBe(1)
    expect(result.errors).toEqual([{ id: 'doc-a', providerDocumentId: 'pd-a', reason: expect.stringContaining('connection reset') }])
  })
})
