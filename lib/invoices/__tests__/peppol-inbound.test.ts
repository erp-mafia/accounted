import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { sha256Hex } from '@/lib/invoices/peppol-delivery'
import {
  PEPPOL_INBOUND_AWAITING_OWNER,
  PEPPOL_INBOUND_AWAITING_XML,
  PEPPOL_INBOUND_RECIPIENT_MISSING,
  PEPPOL_INBOUND_UNARCHIVABLE_PREFIX,
  PEPPOL_INBOUND_UNREADABLE,
  PEPPOL_INBOUND_XML_UNAVAILABLE,
  PeppolInboundArchiveError,
  archiveInboundPeppolMessage,
  orderInboundMessagesOldestFirst,
  processInboundPeppolRow,
  reprocessInboundPeppolDocuments,
  resolvePeppolRecipientCompany,
  syncInboundPeppolDocuments,
  xmlMissCount,
  xmlMissMarker,
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
const NOW = new Date('2026-09-10T12:00:00.000Z')

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

function inserts(): Record<string, unknown>[] {
  return calls
    .filter((c) => c.table === 'peppol_inbound_documents' && c.method === 'insert')
    .map((c) => c.args[0] as Record<string, unknown>)
}

describe('xml miss markers', () => {
  it('round-trip the miss count and are never mistaken for other errors', () => {
    expect(xmlMissMarker(1)).toBe('xml unavailable upstream (miss 1/3)')
    expect(xmlMissCount(xmlMissMarker(2))).toBe(2)
    expect(xmlMissCount(null)).toBe(0)
    expect(xmlMissCount('awaiting xml')).toBe(0)
    expect(xmlMissCount(PEPPOL_INBOUND_XML_UNAVAILABLE)).toBe(0)
  })
})

describe('orderInboundMessagesOldestFirst', () => {
  it('sorts by receivedAt ascending, keeps listing order within a second, and puts unknown timestamps last', () => {
    const at = (id: string, receivedAt: string | null): PeppolInboundMessage => ({ ...message, providerDocumentId: id, receivedAt })
    const ordered = orderInboundMessagesOldestFirst([
      at('newest', '2026-09-10T10:00:02.000Z'),
      at('unknown', null),
      at('same-a', '2026-09-10T10:00:01.000Z'),
      at('garbage', 'not a date'),
      at('oldest', '2026-09-10T10:00:00.000Z'),
      at('same-b', '2026-09-10T10:00:01.000Z'),
    ])
    expect(ordered.map((m) => m.providerDocumentId)).toEqual(['oldest', 'same-a', 'same-b', 'newest', 'unknown', 'garbage'])
  })
})

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
    expect(inserts()[0]).toMatchObject({
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
    expect(inserts()[0].xml_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledWith(message.providerDocumentId, 'Invoice')
  })

  it('returns the stored row for a message seen before without re-fetching XML it already holds', async () => {
    const transport = makeTransport()
    enqueue({ data: row({ status: 'converted', company_id: 'company-1' }), error: null })
    const result = await archiveInboundPeppolMessage({ service, transport, message, log })
    expect(result.created).toBe(false)
    expect(result.row.status).toBe('converted')
    expect(transport.fetchInboundDocumentXml).not.toHaveBeenCalled()
    expect(inserts()).toHaveLength(0)
  })

  it('fetches and stores the XML for a message seen before whose archive lacks it, once the row has rested', async () => {
    const transport = makeTransport()
    enqueue({ data: row({ xml_payload: null, xml_sha256: null, processed_at: '2026-09-10T11:00:00.000Z' }), error: null })
    enqueue({ data: row({ xml_payload: FETCHED_XML, xml_sha256: sha256Hex(FETCHED_XML) }), error: null })
    const result = await archiveInboundPeppolMessage({ service, transport, message, log, now: NOW })
    expect(result.created).toBe(false)
    expect(result.row.xml_payload).toBe(FETCHED_XML)
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledWith(message.providerDocumentId, 'Invoice')
    expect(updates()[0]).toEqual({ xml_payload: FETCHED_XML, xml_sha256: sha256Hex(FETCHED_XML), last_error: null, processed_at: NOW.toISOString() })
    expect(inserts()).toHaveLength(0)
  })

  it('does not re-fetch a JSON-only row inside the backoff, so a re-listed window costs nothing', async () => {
    const transport = makeTransport()
    enqueue({ data: row({ xml_payload: null, xml_sha256: null, processed_at: '2026-09-10T11:45:00.000Z' }), error: null })
    const result = await archiveInboundPeppolMessage({ service, transport, message, log, now: NOW })
    expect(result.row.xml_payload).toBeNull()
    expect(transport.fetchInboundDocumentXml).not.toHaveBeenCalled()
    expect(updates()).toHaveLength(0)
  })

  it('archives the JSON even when the XML fetch fails, so nothing is lost', async () => {
    const transport = makeTransport({ fetchInboundDocumentXml: vi.fn().mockRejectedValue(new Error('timeout')) })
    enqueue({ data: null, error: null })
    enqueue({ data: row({ xml_payload: null, xml_sha256: null }), error: null })
    const result = await archiveInboundPeppolMessage({ service, transport, message, log })
    expect(result.created).toBe(true)
    expect(inserts()[0].xml_payload).toBeNull()
    expect(inserts()[0].ubl_json).toBe(QVALIA_MESSAGE)
  })

  it('tells a deterministic insert failure (CHECK violation) apart from a transient one', async () => {
    const transport = makeTransport()
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: { code: '23514', message: 'new row violates check constraint "peppol_inbound_documents_sender_scheme_check"' } })
    await expect(archiveInboundPeppolMessage({ service, transport, message, log })).rejects.toSatisfy(
      (err: unknown) => err instanceof PeppolInboundArchiveError && err.deterministic && err.code === '23514',
    )
    reset()
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })
    await expect(archiveInboundPeppolMessage({ service, transport, message, log })).rejects.toSatisfy(
      (err: unknown) => err instanceof PeppolInboundArchiveError && !err.deterministic,
    )
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
    expect(updates()[0]).toMatchObject({ company_id: 'company-1', status: 'routed', last_error: null })
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

  it('carries the XML miss counter through routing and holding instead of overwriting it', async () => {
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: null, xmlDocumentId: null, holdReason: PEPPOL_INBOUND_AWAITING_XML })
    const missed = row({ xml_payload: null, xml_sha256: null, last_error: xmlMissMarker(2) })
    enqueue(registration())
    enqueue({ data: { ...missed, company_id: 'company-1', status: 'routed' }, error: null })
    enqueue({ data: { ...missed, company_id: 'company-1', status: 'routed' }, error: null })
    const result = await processInboundPeppolRow({ service, row: missed, document, deliver, log })
    expect(result.outcome).toBe('routed')
    expect(updates()[0]).toMatchObject({ company_id: 'company-1', status: 'routed', last_error: xmlMissMarker(2) })
    expect(updates()[1]).toMatchObject({ status: 'routed', last_error: xmlMissMarker(2) })
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

  it('is terminal for a document that cannot be read as UBL: no retry can change the payload', async () => {
    const deliver = vi.fn()
    enqueue({ data: row({ status: 'failed', last_error: PEPPOL_INBOUND_UNREADABLE }), error: null })
    const result = await processInboundPeppolRow({ service, row: row({ ubl_json: {} }), document: null, deliver, log })
    expect(result.outcome).toBe('terminal')
    expect(updates()[0]).toMatchObject({ status: 'failed', last_error: PEPPOL_INBOUND_UNREADABLE })
    expect(deliver).not.toHaveBeenCalled()
  })

  it('is terminal for a document that names no recipient endpoint', async () => {
    const deliver = vi.fn()
    enqueue({ data: row({ status: 'unrouted', last_error: PEPPOL_INBOUND_RECIPIENT_MISSING }), error: null })
    const result = await processInboundPeppolRow({
      service, row: row({ recipient_scheme: null, recipient_identifier: null }), document, deliver, log,
    })
    expect(result.outcome).toBe('terminal')
    expect(updates()[0]).toMatchObject({ status: 'unrouted', last_error: PEPPOL_INBOUND_RECIPIENT_MISSING })
    expect(calls.some((c) => c.table === 'peppol_registrations')).toBe(false)
  })

  it('skips rows that are already converted, ignored or terminal', async () => {
    const deliver = vi.fn()
    for (const overrides of [
      { company_id: 'company-1', status: 'converted' as const },
      { company_id: 'company-1', status: 'ignored' as const },
      { status: 'unrouted' as const, last_error: PEPPOL_INBOUND_XML_UNAVAILABLE },
      { status: 'failed' as const, last_error: PEPPOL_INBOUND_UNREADABLE },
    ]) {
      const result = await processInboundPeppolRow({ service, row: row(overrides), document, deliver, log })
      expect(result.outcome).toBe('skipped')
    }
    expect(calls).toHaveLength(0)
    expect(deliver).not.toHaveBeenCalled()
  })
})

describe('syncInboundPeppolDocuments', () => {
  const older: PeppolInboundMessage = { ...message, providerDocumentId: 'older', receivedAt: '2026-09-10T10:00:00.000Z' }
  const newer: PeppolInboundMessage = { ...message, providerDocumentId: 'newer', receivedAt: '2026-09-10T10:05:00.000Z' }
  const listing = (messages: PeppolInboundMessage[]) =>
    vi.fn().mockImplementation(async ({ documentType }: { documentType: string }) => (documentType === 'Invoice' ? messages : []))

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
    expect(summary).toEqual({
      listed: 1, archived: 1, duplicates: 0, routed: 0, unrouted: 0, delivered: 1, failed: 0,
      terminal: 0, terminalDocuments: [], errors: [],
    })
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

  it('archives oldest first and stops at an archive failure so the cursor never passes an unarchived document', async () => {
    const transport = makeTransport({ listInboundDocuments: listing([newer, older]) })
    enqueue({ data: null, error: null })                                          // invoice cursor
    enqueue({ data: null, error: null })                                          // older: no existing row
    enqueue({ data: null, error: { code: '08006', message: 'connection failure' } }) // older: insert fails transiently
    enqueue({ data: null, error: null })                                          // credit note cursor

    const summary = await syncInboundPeppolDocuments({ service, transport, deliver: null, log })

    expect(summary).toMatchObject({ listed: 2, archived: 0, failed: 1, terminal: 0 })
    expect(summary.errors).toEqual([{ providerDocumentId: 'older', reason: expect.stringContaining('connection failure') }])
    // The newer document was never attempted: it is re-listed next run.
    expect(inserts()).toHaveLength(1)
    expect(inserts()[0]).toMatchObject({ provider_document_id: 'older' })
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledTimes(1)
  })

  it('records a payload the archive can never hold as a terminal stub and moves on to the newer document', async () => {
    const transport = makeTransport({ listInboundDocuments: listing([older, newer]) })
    const stub = row({ id: 'stub-1', provider_document_id: 'older', ubl_json: {}, status: 'failed', last_error: `${PEPPOL_INBOUND_UNARCHIVABLE_PREFIX}check constraint` })
    enqueue({ data: null, error: null })                                          // invoice cursor
    enqueue({ data: null, error: null })                                          // older: no existing row
    enqueue({ data: null, error: { code: '23514', message: 'new row for relation "peppol_inbound_documents" violates check constraint "peppol_inbound_documents_sender_scheme_check"' } })
    enqueue({ data: stub, error: null })                                          // stub insert
    enqueue({ data: null, error: null })                                          // newer: no existing row
    enqueue({ data: row({ id: 'doc-2', provider_document_id: 'newer' }), error: null }) // newer insert
    enqueue({ data: [], error: null })                                            // newer: nobody registered
    enqueue({ data: row({ id: 'doc-2', provider_document_id: 'newer', status: 'unrouted' }), error: null })
    enqueue({ data: null, error: null })                                          // credit note cursor

    const summary = await syncInboundPeppolDocuments({ service, transport, deliver: null, log, now: NOW })

    expect(summary).toMatchObject({ listed: 2, archived: 1, failed: 0, unrouted: 1, terminal: 1, errors: [] })
    expect(summary.terminalDocuments).toEqual([{ id: 'stub-1', providerDocumentId: 'older', reason: stub.last_error }])
    const stubInsert = inserts()[1]
    expect(stubInsert).toMatchObject({
      provider: 'qvalia',
      provider_document_id: 'older',
      document_type: 'Invoice',
      status: 'failed',
      ubl_json: {},
      received_at: '2026-09-10T10:00:00.000Z',
      processed_at: NOW.toISOString(),
    })
    expect(stubInsert.last_error).toMatch(/^terminal: payload unarchivable: Failed to archive inbound Peppol document: new row/)
    expect((stubInsert.last_error as string).length).toBeLessThanOrEqual(PEPPOL_INBOUND_UNARCHIVABLE_PREFIX.length + 200)
    expect(inserts()[2]).toMatchObject({ provider_document_id: 'newer' })
  })

  it('archives a same-second batch completely, in listing order', async () => {
    const a: PeppolInboundMessage = { ...message, providerDocumentId: 'same-a', receivedAt: '2026-09-10T10:00:01.000Z' }
    const b: PeppolInboundMessage = { ...message, providerDocumentId: 'same-b', receivedAt: '2026-09-10T10:00:01.000Z' }
    const transport = makeTransport({ listInboundDocuments: listing([a, b]) })
    enqueue({ data: null, error: null })                                          // invoice cursor
    for (const id of ['same-a', 'same-b']) {
      enqueue({ data: null, error: null })                                        // no existing row
      enqueue({ data: row({ id, provider_document_id: id }), error: null })       // insert
      enqueue({ data: [], error: null })                                          // nobody registered
      enqueue({ data: row({ id, provider_document_id: id, status: 'unrouted' }), error: null })
    }
    enqueue({ data: null, error: null })                                          // credit note cursor
    const summary = await syncInboundPeppolDocuments({ service, transport, deliver: null, log })
    expect(summary).toMatchObject({ listed: 2, archived: 2, unrouted: 2, failed: 0, errors: [] })
    expect(inserts().map((i) => i.provider_document_id)).toEqual(['same-a', 'same-b'])
  })

  it('counts a document that is terminal on first sight and keeps going', async () => {
    const transport = makeTransport({ listInboundDocuments: listing([older]) })
    enqueue({ data: null, error: null })                                          // invoice cursor
    enqueue({ data: null, error: null })                                          // no existing row
    enqueue({ data: row({ provider_document_id: 'older', ubl_json: {} }), error: null }) // insert (unparsable payload)
    enqueue({ data: row({ provider_document_id: 'older', status: 'failed', last_error: PEPPOL_INBOUND_UNREADABLE }), error: null })
    enqueue({ data: null, error: null })                                          // credit note cursor
    const unreadable = { ...older, payload: {} }
    ;(transport.listInboundDocuments as ReturnType<typeof vi.fn>).mockImplementation(async ({ documentType }: { documentType: string }) =>
      documentType === 'Invoice' ? [unreadable] : [])
    const summary = await syncInboundPeppolDocuments({ service, transport, deliver: null, log })
    expect(summary).toMatchObject({ listed: 1, archived: 1, terminal: 1, failed: 0, errors: [] })
    expect(summary.terminalDocuments).toEqual([{ id: 'doc-1', providerDocumentId: 'older', reason: PEPPOL_INBOUND_UNREADABLE }])
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
  const now = NOW
  const stamped = (overrides: Partial<PeppolInboundRow>) => row({ ...overrides, processed_at: now.toISOString() })
  const empty = { candidates: 0, xmlFetched: 0, xmlMissed: 0, retried: 0, held: 0, routed: 0, delivered: 0, terminal: 0, terminalDocuments: [], errors: [] }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('selects pending rows of this provider outside the backoff, terminal rows excluded, least recently processed first', async () => {
    const transport = makeTransport()
    enqueue({ data: [], error: null })
    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver: null, log, now })
    expect(result).toEqual(empty)
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

  it('leaves an already terminal row alone and does not count it as newly terminal', async () => {
    const transport = makeTransport()
    enqueue({ data: [row({ status: 'unrouted', xml_payload: null, xml_sha256: null, last_error: PEPPOL_INBOUND_XML_UNAVAILABLE })], error: null })
    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver: null, log, now })
    expect(result).toEqual({ ...empty, candidates: 1 })
    expect(updates()).toHaveLength(0)
    expect(transport.fetchInboundDocumentXml).not.toHaveBeenCalled()
  })

  it('fetches the missing XML, stores payload and hash, clears the miss counter and files the held document', async () => {
    const transport = makeTransport()
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: 'inbox-1', xmlDocumentId: 'doc-xml-1' })
    const held = row({ company_id: 'company-1', status: 'routed', xml_payload: null, xml_sha256: null, last_error: xmlMissMarker(2), processed_at: '2026-09-10T10:00:00.000Z' })
    enqueue({ data: [held], error: null })                                        // candidates
    enqueue({ data: stamped(held), error: null })                                 // processed_at stamp
    enqueue({ data: stamped({ ...held, xml_payload: FETCHED_XML, xml_sha256: sha256Hex(FETCHED_XML), last_error: null }), error: null }) // xml stored
    enqueue({ data: stamped({ ...held, xml_payload: FETCHED_XML, status: 'converted', inbox_item_id: 'inbox-1' }), error: null })

    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })

    expect(result).toEqual({ ...empty, candidates: 1, xmlFetched: 1, delivered: 1 })
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledWith(held.provider_document_id, 'Invoice')
    expect(updates()[0]).toEqual({ processed_at: now.toISOString() })
    expect(updates()[1]).toEqual({ xml_payload: FETCHED_XML, xml_sha256: sha256Hex(FETCHED_XML), last_error: null, processed_at: now.toISOString() })
    expect(updates()[2]).toMatchObject({ status: 'converted', inbox_item_id: 'inbox-1', xml_document_id: 'doc-xml-1', last_error: null })
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', xml: FETCHED_XML }))
  })

  it('counts a null XML answer as a miss twice, keeps the row retryable, and goes terminal once on the third', async () => {
    const transport = makeTransport({ fetchInboundDocumentXml: vi.fn().mockResolvedValue(null) })
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: null, xmlDocumentId: null, holdReason: PEPPOL_INBOUND_AWAITING_XML })
    let pending = row({ company_id: 'company-1', status: 'routed', xml_payload: null, xml_sha256: null })

    for (const miss of [1, 2]) {
      reset()
      enqueue({ data: [pending], error: null })
      enqueue({ data: stamped(pending), error: null })                            // stamp
      const missed = stamped({ ...pending, last_error: xmlMissMarker(miss) })
      enqueue({ data: missed, error: null })                                      // miss recorded
      enqueue({ data: missed, error: null })                                      // hold keeps the counter
      const result = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })
      expect(result, `miss ${miss}`).toEqual({ ...empty, candidates: 1, xmlMissed: 1, held: 1 })
      expect(updates()[1]).toEqual({ last_error: xmlMissMarker(miss), processed_at: now.toISOString() })
      expect(updates()[2]).toMatchObject({ status: 'routed', last_error: xmlMissMarker(miss) })
      pending = missed
    }

    reset()
    enqueue({ data: [pending], error: null })
    enqueue({ data: stamped(pending), error: null })
    const terminalRow = stamped({ ...pending, last_error: PEPPOL_INBOUND_XML_UNAVAILABLE })
    enqueue({ data: terminalRow, error: null })
    const third = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })
    expect(third).toEqual({
      ...empty, candidates: 1, terminal: 1,
      terminalDocuments: [{ id: 'doc-1', providerDocumentId: pending.provider_document_id, reason: PEPPOL_INBOUND_XML_UNAVAILABLE }],
    })
    expect(updates()[1]).toEqual({ last_error: PEPPOL_INBOUND_XML_UNAVAILABLE, processed_at: now.toISOString() })
    expect(updates()).toHaveLength(2)
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledTimes(3)

    // A later pass that still sees the row (defensive: the query excludes it) leaves it alone.
    reset()
    enqueue({ data: [terminalRow], error: null })
    const fourth = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })
    expect(fourth).toEqual({ ...empty, candidates: 1 })
    expect(transport.fetchInboundDocumentXml).toHaveBeenCalledTimes(3)
    expect(updates()).toHaveLength(0)
  })

  it('counts a transport error as retried, not as an error, and still re-runs routing', async () => {
    const transport = makeTransport({ fetchInboundDocumentXml: vi.fn().mockRejectedValue(new Error('timeout')) })
    const pending = row({ status: 'unrouted', xml_payload: null, xml_sha256: null })
    enqueue({ data: [pending], error: null })
    enqueue({ data: stamped(pending), error: null })                              // stamp
    enqueue({ data: stamped(pending), error: null })                              // attempt stamp on error
    enqueue({ data: [], error: null })                                            // still no registration
    enqueue({ data: stamped({ ...pending, status: 'unrouted' }), error: null })   // unrouted update

    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver: vi.fn(), log, now })

    expect(result).toEqual({ ...empty, candidates: 1, retried: 1 })
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

    expect(result).toEqual({ ...empty, candidates: 1, routed: 1, delivered: 1 })
    expect(transport.fetchInboundDocumentXml).not.toHaveBeenCalled()
    expect(updates()[1]).toMatchObject({ company_id: 'company-1', status: 'routed' })
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', xml: '<Invoice/>' }))
  })

  it('counts a document held for a missing owner member without paging', async () => {
    const transport = makeTransport()
    const deliver = vi.fn().mockResolvedValue({ inboxItemId: null, xmlDocumentId: null, holdReason: PEPPOL_INBOUND_AWAITING_OWNER })
    const routed = row({ company_id: 'company-1', status: 'routed', processed_at: '2026-09-10T09:00:00.000Z' })
    enqueue({ data: [routed], error: null })
    enqueue({ data: stamped(routed), error: null })
    enqueue({ data: stamped({ ...routed, last_error: PEPPOL_INBOUND_AWAITING_OWNER }), error: null })
    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })
    expect(result).toEqual({ ...empty, candidates: 1, held: 1 })
    expect(updates()[1]).toMatchObject({ status: 'routed', last_error: PEPPOL_INBOUND_AWAITING_OWNER })
  })

  it('reports a failed delivery as an error carrying the row id, and a terminal parse as terminal', async () => {
    const transport = makeTransport()
    const deliver = vi.fn().mockRejectedValue(new Error('storage down'))
    const failed = row({ company_id: 'company-1', status: 'failed', last_error: 'storage down', processed_at: '2026-09-10T09:00:00.000Z' })
    const unreadable = row({ id: 'doc-9', provider_document_id: 'pd-9', ubl_json: {}, processed_at: '2026-09-10T09:30:00.000Z' })
    enqueue({ data: [failed, unreadable], error: null })
    enqueue({ data: stamped(failed), error: null })
    enqueue({ data: stamped({ ...failed, last_error: 'storage down' }), error: null })
    enqueue({ data: stamped(unreadable), error: null })
    enqueue({ data: stamped({ ...unreadable, status: 'failed', last_error: PEPPOL_INBOUND_UNREADABLE }), error: null })

    const result = await reprocessInboundPeppolDocuments({ service, transport, deliver, log, now })

    expect(result.errors).toEqual([{ id: 'doc-1', providerDocumentId: failed.provider_document_id, reason: 'storage down' }])
    expect(result.terminal).toBe(1)
    expect(result.terminalDocuments).toEqual([{ id: 'doc-9', providerDocumentId: 'pd-9', reason: PEPPOL_INBOUND_UNREADABLE }])
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
