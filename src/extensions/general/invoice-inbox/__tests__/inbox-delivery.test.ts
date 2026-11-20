/**
 * The invoice-inbox `fileInboxDelivery` service behind the v1 partner door
 * (POST /api/v1/companies/{id}/inbox-items). Runs the real shared pipeline
 * (uploadAndExtract) with the archive, the model and the history mocked, and
 * pins what a delivery files: an inbox row with source 'upload', the
 * partner's provenance in channel_context, the declared kind and sender, and
 * nothing booked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: vi.fn() }))
vi.mock('@/lib/documents/inbox-extraction/extract-invoice-fields', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/inbox-extraction/extract-invoice-fields')>()
  return {
    ...actual,
    extractInvoiceFields: vi.fn(async () => ({ data: actual.emptyResult(), rawText: null, model: null, skipped: null })),
    fetchOwnCompanyIdentity: vi.fn().mockResolvedValue(null),
  }
})
vi.mock('@/lib/documents/inbox-extraction/mirror-extraction', () => ({ mirrorExtractionToDocument: vi.fn() }))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn() }))
vi.mock('@/lib/ai', () => ({
  getAiStatus: () => ({ configured: true, capabilities: { pdfNative: true } }),
}))
vi.mock('@/lib/auth/api-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/api-keys')>()
  return { ...actual, createServiceClientNoCookies: vi.fn() }
})

import { uploadDocument } from '@/lib/core/documents/document-service'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { fileInboxDelivery } from '../lib/inbox-delivery'
import { partnerChannelContext } from '@/lib/intake/partner-delivery'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const DOC = '33333333-3333-4333-8333-333333333333'
const ITEM = '44444444-4444-4444-8444-444444444444'

const CONTEXT = partnerChannelContext({ keyLabel: 'Billo', externalRef: 'billo-123' })

function input() {
  return {
    userId: USER,
    companyId: COMPANY,
    file: { name: 'faktura.pdf', buffer: new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer, type: 'application/pdf' },
    kindHint: 'supplier_invoice' as const,
    senderName: 'Leverantören AB',
    subject: 'Faktura 1001',
    receivedAt: '2026-10-15T08:00:00.000Z',
    channelContext: CONTEXT,
  }
}

function db(itemLookup: unknown = null) {
  return createTableMockSupabase({
    // The duplicate-item lookup (deduplicated content only), then the insert.
    invoice_inbox_items: (calls) =>
      calls.some((c) => c.method === 'insert')
        ? { data: { id: ITEM, status: (calls.find((c) => c.method === 'insert')!.args[0] as { status: string }).status, matched_supplier_id: null, matched_transaction_id: null } }
        : { data: itemLookup },
    company_settings: { data: { is_sandbox: false } },
    suppliers: { data: null },
    document_attachments: { data: null },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(uploadDocument).mockResolvedValue({ id: DOC, mime_type: 'application/pdf' } as never)
})

describe('invoice-inbox fileInboxDelivery', () => {
  it('is the service the extension registers for core', () => {
    expect(invoiceInboxExtension.services?.fileInboxDelivery).toBe(fileInboxDelivery)
  })

  it('files a staged upload row with the partner provenance, kind and sender', async () => {
    vi.mocked(hasCapability).mockResolvedValue(true)
    const mock = db()
    vi.mocked(createServiceClientNoCookies).mockReturnValue(mock.supabase as never)

    const result = await fileInboxDelivery(mock.supabase as never, input())

    expect(result).toEqual({ document_id: DOC, inbox_item_id: ITEM, deduplicated: false })
    const [row] = mock.payloads('invoice_inbox_items', 'insert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({
      company_id: COMPANY,
      user_id: USER,
      source: 'upload',
      status: 'processing',
      document_id: DOC,
      kind_hint: 'supplier_invoice',
      email_from: 'Leverantören AB',
      email_subject: 'Faktura 1001',
      email_received_at: '2026-10-15T08:00:00.000Z',
      channel_context: {
        channel: 'partner_api',
        intake_source: 'partner_api',
        partner_key_label: 'Billo',
        external_ref: 'billo-123',
      },
    })
    // Filed, not booked: the row carries no supplier invoice and no verifikat.
    expect(row).not.toHaveProperty('created_supplier_invoice_id')
    expect(row).not.toHaveProperty('created_journal_entry_id')
    // Archived with content dedupe and the inbox owning extraction, like an upload.
    expect(vi.mocked(uploadDocument).mock.calls[0][4]).toMatchObject({
      upload_source: 'file_upload',
      dedupeByContent: true,
      extractionOwner: 'invoice-inbox',
    })
  })

  it('writes the same provenance on the synchronous path (no AI entitlement)', async () => {
    vi.mocked(hasCapability).mockResolvedValue(false)
    const mock = db()

    await fileInboxDelivery(mock.supabase as never, input())

    const [row] = mock.payloads('invoice_inbox_items', 'insert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({ source: 'upload', status: 'received', extraction_skipped: true, channel_context: CONTEXT })
  })

  it('returns the existing item for content already in the Inkorg and files nothing new', async () => {
    vi.mocked(hasCapability).mockResolvedValue(true)
    vi.mocked(uploadDocument).mockResolvedValue({ id: DOC, mime_type: 'application/pdf', deduplicated: true } as never)
    const mock = db([
      { id: ITEM, status: 'received', extracted_data: {}, matched_supplier_id: null, matched_transaction_id: null, kind_hint: 'supplier_invoice', created_supplier_invoice_id: null, created_journal_entry_id: null },
    ])

    const result = await fileInboxDelivery(mock.supabase as never, input())

    expect(result).toEqual({ document_id: DOC, inbox_item_id: ITEM, deduplicated: true })
    expect(mock.payloads('invoice_inbox_items', 'insert')).toEqual([])
  })

  it('books nothing: no supplier invoice, no verifikat', async () => {
    vi.mocked(hasCapability).mockResolvedValue(false)
    const mock = db()

    await fileInboxDelivery(mock.supabase as never, input())

    const touched = mock.tables()
    expect(touched).not.toContain('supplier_invoices')
    expect(touched).not.toContain('journal_entries')
    expect(touched).not.toContain('journal_entry_lines')
    expect(mock.supabase.rpc).not.toHaveBeenCalledWith('commit_journal_entry', expect.anything())
  })
})
