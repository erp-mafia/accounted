import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

// One document, one inbox item (crm#1413): the synchronous reading path of the
// inbox's own doors (upload, e-mail, WhatsApp) looks before it files.

vi.mock('@/lib/documents/inbox-extraction/extract-invoice-fields', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/inbox-extraction/extract-invoice-fields')>()
  return { ...actual, extractInvoiceFields: vi.fn(), fetchOwnCompanyIdentity: vi.fn().mockResolvedValue(undefined) }
})
vi.mock('@/lib/documents/inbox-extraction/mirror-extraction', () => ({ mirrorExtractionToDocument: vi.fn() }))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/operations/inbox-bank-match', () => ({ proposeBankMatchForInboxItem: vi.fn() }))
vi.mock('@/lib/suppliers/match-supplier', () => ({ matchSupplierId: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})
vi.mock('@/lib/ai', () => ({
  getAiStatus: () => ({ configured: true, pdfMode: 'native', capabilities: { pdfNative: true, imageInput: true } }),
}))

import { extractInvoiceFields, emptyResult } from '@/lib/documents/inbox-extraction/extract-invoice-fields'
import { processArchivedDocument } from '../lib/upload-and-extract'

const FILE = { name: 'kvitto.png', buffer: new ArrayBuffer(8), type: 'image/png' }
const QUEUED_ID = 'queued-by-arkiv'

const arkivRow = {
  id: QUEUED_ID,
  status: 'received',
  extracted_data: null,
  matched_supplier_id: null,
  matched_transaction_id: null,
  created_supplier_invoice_id: null,
  created_journal_entry_id: null,
  channel_context: { intake_source: 'intake_email' },
}

/** invoice_inbox_items answered by what each chain asked: the look, the takeover, an insert, the stamp. */
function inboxItems(queued: unknown[]): TableMockResolver {
  return (chain) => {
    const methods = chain.map((c) => c.method)
    if (methods.includes('insert')) return { data: { id: 'inserted', status: 'received', matched_supplier_id: null, matched_transaction_id: null } }
    if (methods.includes('update')) {
      const payload = chain.find((c) => c.method === 'update')?.args[0] as Record<string, unknown>
      if ('created_journal_entry_id' in payload) return { data: [{ id: 'stamped' }] }
      return { data: [{ id: QUEUED_ID, status: 'received', extracted_data: payload.extracted_data, matched_supplier_id: null, matched_transaction_id: null }] }
    }
    return { data: queued }
  }
}

describe('processArchivedDocument files one item per document (crm#1413)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(extractInvoiceFields).mockResolvedValue({ data: emptyResult(), rawText: 'ok' } as never)
  })

  it('takes over the item Arkiv queued while the reading ran, with the e-mail fields, and inserts nothing', async () => {
    const mock = createTableMockSupabase({ invoice_inbox_items: inboxItems([arkivRow]) })

    const result = await processArchivedDocument(
      mock.supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', mime_type: 'image/png' },
      FILE,
      'email',
      { from: 'sender@example.com', subject: 'Kvitto', kindHint: 'receipt', resendEmailId: 'em-1', resendAttachmentId: 'att-1' },
    )

    expect(result).toMatchObject({ document_id: 'doc-1', inbox_item_id: QUEUED_ID })
    expect(mock.findCalls('invoice_inbox_items', 'insert')).toHaveLength(0)
    expect(mock.findCall('invoice_inbox_items', 'update')?.[0]).toMatchObject({
      source: 'email',
      email_from: 'sender@example.com',
      email_subject: 'Kvitto',
      kind_hint: 'receipt',
      resend_email_id: 'em-1',
      resend_attachment_id: 'att-1',
      channel_context: null,
    })
  })

  it('files its own item when nothing is queued on the document', async () => {
    const mock = createTableMockSupabase({ invoice_inbox_items: inboxItems([]) })

    const result = await processArchivedDocument(
      mock.supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', mime_type: 'image/png' },
      FILE,
      'upload',
    )

    expect(result).toMatchObject({ inbox_item_id: 'inserted' })
    expect(mock.findCall('invoice_inbox_items', 'insert')?.[0]).toMatchObject({ document_id: 'doc-1', source: 'upload' })
    expect(mock.findCalls('invoice_inbox_items', 'update')).toHaveLength(0)
  })

  it('books an item filed for a deduplicated document a verifikat already holds at birth', async () => {
    // The same bytes again, onto a document already on an imported verifikat
    // and with no item of its own: filed open, it waited in Behöver dig while
    // the worklist badge and the MCP list counted it handled.
    const mock = createTableMockSupabase({
      invoice_inbox_items: inboxItems([]),
      document_attachments: { data: { journal_entry_id: 'je-imported', doc_type: null, admission_state: 'admitted' } },
    })

    await processArchivedDocument(
      mock.supabase as never,
      'user-1',
      'company-1',
      { id: 'doc-1', mime_type: 'image/png', deduplicated: true },
      FILE,
      'email',
      { from: 'sender@example.com' },
    )

    const stamp = mock.findCalls('invoice_inbox_items', 'update').find(([payload]) => 'created_journal_entry_id' in (payload as object))
    expect(stamp?.[0]).toEqual({ created_journal_entry_id: 'je-imported' })
  })
})
