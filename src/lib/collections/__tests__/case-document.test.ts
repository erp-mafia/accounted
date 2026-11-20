import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLECTIONS_MAX_DOCUMENT_CHARS } from '@accounted/connect-contract'
import { createMemorySupabase, COMPANY_ID, ADMIN_ID } from './memory-supabase'

const storage = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }))
const uploads = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/lib/core/documents/document-service', () => ({
  downloadDocumentObject: vi.fn(async (_db: unknown, path: string) => {
    const bytes = storage.files.get(path)
    return bytes
      ? { blob: new Blob([Buffer.from(bytes)]), error: null, resolvedPath: path }
      : { blob: null, error: { message: 'not found' }, resolvedPath: null }
  }),
  uploadDocument: vi.fn(async (_db: unknown, _user: string, _company: string, file: { name: string }) => {
    uploads.count++
    return { id: `rendered-${uploads.count}`, file_name: file.name }
  }),
}))
vi.mock('@/lib/invoices/render-invoice-pdf', () => ({
  renderInvoicePdfBuffer: vi.fn(async () => ({ buffer: Buffer.from('%PDF rendered copy'), paymentQr: { kind: null }, pageCount: 1 })),
}))

import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { readArchivedDocument, resolveHandoverDocument } from '../case-document'

const sha = (bytes: Uint8Array | Buffer) => createHash('sha256').update(bytes).digest('hex')
const SENT = Buffer.from('%PDF the copy the customer got')

function world() {
  const db = createMemorySupabase()
  storage.files.clear()
  storage.files.set('company/sent.pdf', SENT)
  db.seed('document_attachments', [
    { id: 'doc-sent', company_id: COMPANY_ID, storage_path: 'company/sent.pdf', file_name: 'Faktura 1042.pdf', sha256_hash: sha(SENT) },
  ])
  db.seed('invoice_deliveries', [
    { id: 'd-old', company_id: COMPANY_ID, invoice_id: 'inv-1', status: 'sent', document_attachment_id: 'doc-old', sent_at: '2026-08-01T09:00:00Z' },
    { id: 'd-new', company_id: COMPANY_ID, invoice_id: 'inv-1', status: 'sent', document_attachment_id: 'doc-sent', sent_at: '2026-08-02T09:00:00Z' },
    { id: 'd-failed', company_id: COMPANY_ID, invoice_id: 'inv-1', status: 'failed', document_attachment_id: 'doc-x', sent_at: '2026-08-03T09:00:00Z' },
  ])
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  uploads.count = 0
})

describe('readArchivedDocument', () => {
  it('reads the archived bytes and checks them against the recorded hash', async () => {
    const db = world()
    const document = await readArchivedDocument(db.client, COMPANY_ID, 'doc-sent', sha(SENT))
    expect(document).toEqual({ documentId: 'doc-sent', filename: 'Faktura 1042.pdf', sha256: sha(SENT), base64: SENT.toString('base64') })
  })

  it('refuses bytes that no longer match what was recorded or sent', async () => {
    const db = world()
    storage.files.set('company/sent.pdf', Buffer.from('tampered'))
    await expect(readArchivedDocument(db.client, COMPANY_ID, 'doc-sent')).rejects.toMatchObject({ code: 'COLLECTION_DOCUMENT_CHANGED' })
    storage.files.set('company/sent.pdf', SENT)
    await expect(readArchivedDocument(db.client, COMPANY_ID, 'doc-sent', 'f'.repeat(64))).rejects.toMatchObject({ code: 'COLLECTION_DOCUMENT_CHANGED' })
  })

  it('answers unavailable for a missing row or object, and too large past the contract cap', async () => {
    const db = world()
    await expect(readArchivedDocument(db.client, COMPANY_ID, 'nope')).rejects.toMatchObject({ code: 'COLLECTION_DOCUMENT_UNAVAILABLE' })
    storage.files.delete('company/sent.pdf')
    await expect(readArchivedDocument(db.client, COMPANY_ID, 'doc-sent')).rejects.toMatchObject({ code: 'COLLECTION_DOCUMENT_UNAVAILABLE' })
    const big = Buffer.alloc(Math.ceil((COLLECTIONS_MAX_DOCUMENT_CHARS / 4) * 3) + 3, 1)
    storage.files.set('company/sent.pdf', big)
    db.rows('document_attachments')[0].sha256_hash = sha(big)
    await expect(readArchivedDocument(db.client, COMPANY_ID, 'doc-sent')).rejects.toMatchObject({ code: 'COLLECTION_DOCUMENT_TOO_LARGE' })
  })
})

describe('resolveHandoverDocument', () => {
  it('sends the copy of the latest successful send, byte for byte', async () => {
    const db = world()
    const document = await resolveHandoverDocument(db.client, { companyId: COMPANY_ID, invoiceId: 'inv-1', userId: ADMIN_ID })
    expect(document.documentId).toBe('doc-sent')
    expect(uploads.count).toBe(0)
  })

  it('renders and archives a copy once when the invoice has no archived send', async () => {
    const db = world()
    db.tables.set('invoice_deliveries', [])
    db.seed('invoices', [
      { id: 'inv-1', company_id: COMPANY_ID, currency: 'SEK', invoice_number: '1042', invoice_date: '2026-08-01', document_type: 'invoice', status: 'sent', customer: { name: 'Kund AB' }, items: [] },
    ])
    db.seed('company_settings', [{ company_id: COMPANY_ID, company_name: 'Test AB' }])
    const document = await resolveHandoverDocument(db.client, { companyId: COMPANY_ID, invoiceId: 'inv-1', userId: ADMIN_ID })
    expect(document).toMatchObject({ documentId: 'rendered-1', sha256: sha(Buffer.from('%PDF rendered copy')) })
    expect(uploads.count).toBe(1)
    // Rendered through the one entry point, as sent, from the stored company row.
    expect(renderInvoicePdfBuffer).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renderInvoicePdfBuffer).mock.calls[0][0]).toMatchObject({
      invoice: { id: 'inv-1', status: 'sent' },
      company: { company_name: 'Test AB' },
    })
  })
})
