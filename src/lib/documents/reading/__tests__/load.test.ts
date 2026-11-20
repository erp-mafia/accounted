import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { loadDocumentReading } from '../load'
import { peppolReader } from '@/lib/invoices/peppol-reading'
import type { ReadingItemRow } from '../resolve'
import { SELLER_ORG, peppolInvoiceJson, receiptExtraction } from './fixtures'

const COMPANY = 'company-1'
const ITEM_ID = '11111111-1111-4111-8111-111111111111'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

const asClient = (supabase: unknown) => supabase as SupabaseClient

function itemRow(overrides: Partial<ReadingItemRow> = {}): ReadingItemRow {
  return {
    id: ITEM_ID,
    document_id: DOC_ID,
    source: 'upload',
    extracted_data: receiptExtraction(),
    extraction_skipped: false,
    kind_hint: null,
    channel_context: null,
    email_from: null,
    email_received_at: null,
    matched_supplier_id: null,
    ...overrides,
  }
}

describe('loadDocumentReading', () => {
  it('reads the document with every column and the Arkiv record, both scoped to the company', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: DOC_ID, mime_type: 'image/png', extracted_data: receiptExtraction(), extraction_model: 'claude-sonnet-4-6', extracted_at: null }, error: null })
    enqueue({ data: { schema_type: 'receipt', payload: { merchant_name: { normalized: 'Kafé Exempel', page: 1, quote: 'Kafé Exempel' } } }, error: null })
    const reading = await loadDocumentReading(asClient(supabase), COMPANY, { item: itemRow() }, peppolReader)
    expect(findCall('document_attachments', 'select')?.[0]).toBe('*')
    expect(findCalls('document_attachments', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(findCalls('document_extractions', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', COMPANY],
        ['document_id', DOC_ID],
        ['is_current', true],
      ]),
    )
    // No Peppol item, no matched supplier: neither is read.
    expect(findCall('peppol_inbound_documents', 'select')).toBeUndefined()
    expect(findCall('suppliers', 'select')).toBeUndefined()
    expect(reading.fields.seller_name).toMatchObject({ source: 'vision', evidence: 'stark', page: 1 })
  })

  it("finds a Peppol item's UBL by the provider's document id and reads it as Exakt", async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const item = itemRow({
      source: 'peppol',
      extracted_data: null,
      channel_context: { channel: 'peppol', peppol_provider: 'qvalia', peppol_document_id: 'pd-1', peppol_sender_endpoint: `0007:${SELLER_ORG}` },
      matched_supplier_id: 'sup-1',
    })
    enqueue({ data: { id: DOC_ID, mime_type: 'application/pdf', upload_source: 'e_invoice' }, error: null })
    enqueue({ data: { ubl_json: peppolInvoiceJson() }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: { name: 'Exempel Leverantör AB', org_number: SELLER_ORG, vat_number: null, bankgiro: null, plusgiro: null, iban: null }, error: null })
    const reading = await loadDocumentReading(asClient(supabase), COMPANY, { item }, peppolReader)
    expect(findCalls('peppol_inbound_documents', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['provider', 'qvalia'],
      ['provider_document_id', 'pd-1'],
    ])
    expect(findCalls('suppliers', 'eq')).toEqual([
      ['id', 'sup-1'],
      ['company_id', COMPANY],
    ])
    expect(reading.fields.invoice_number).toEqual({ value: 'INV-1001', source: 'xml', evidence: 'exakt' })
    expect(reading.notes).toEqual([])
  })

  it('falls back to the back-link when the item names no provider document', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: DOC_ID }, error: null })
    enqueue({ data: null, error: null })
    await loadDocumentReading(asClient(supabase), COMPANY, { item: itemRow({ source: 'peppol' }) }, peppolReader)
    expect(findCalls('peppol_inbound_documents', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['inbox_item_id', ITEM_ID],
    ])
  })

  it('resolves a document to its newest inbox item', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: itemRow({ source: 'email', email_from: 'kvitto@example.test' }), error: null })
    enqueue({ data: { id: DOC_ID, mime_type: 'image/jpeg', upload_source: 'email' }, error: null })
    const reading = await loadDocumentReading(asClient(supabase), COMPANY, { documentId: DOC_ID }, peppolReader)
    expect(findCalls('invoice_inbox_items', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['document_id', DOC_ID],
    ])
    expect(findCall('invoice_inbox_items', 'order')).toEqual(['created_at', { ascending: false }])
    expect(reading.inbox_item_id).toBe(ITEM_ID)
    expect(reading.door).toMatchObject({ intake_source: 'intake_email', sender: 'kvitto@example.test' })
  })

  it('reads nothing past the item when it carries no document', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    const reading = await loadDocumentReading(asClient(supabase), COMPANY, { item: itemRow({ document_id: null }) }, peppolReader)
    expect(calls).toEqual([])
    expect(reading.document_id).toBeNull()
  })

  it('throws on a failed read instead of answering a partial reading', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(loadDocumentReading(asClient(supabase), COMPANY, { item: itemRow() }, peppolReader)).rejects.toThrow('document reading: document read failed: boom')
  })
})
