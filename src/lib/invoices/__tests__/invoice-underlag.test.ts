import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  MAX_UNDERLAG_PER_INVOICE,
  attachInvoiceUnderlag,
  detachInvoiceUnderlag,
  listInvoiceUnderlag,
} from '../invoice-underlag'

const COMPANY = 'company-1'
const INVOICE = '33333333-3333-4333-8333-333333333333'
const DOC_A = '11111111-1111-4111-8111-111111111111'
const DOC_B = '22222222-2222-4222-8222-222222222222'
const MISSING_TABLE = { code: 'PGRST205', message: "Could not find the table 'public.invoice_underlag' in the schema cache" }

function underlagRow(documentId: string, fileName: string, voucher?: { series: string; number: number }) {
  return {
    document_id: documentId,
    created_at: '2026-11-06T10:00:00.000Z',
    document: {
      file_name: fileName,
      mime_type: 'application/pdf',
      file_size_bytes: 2048,
      journal_entry_id: voucher ? 'je-1' : null,
      created_at: '2026-10-02T08:00:00.000Z',
      journal_entry: voucher ? { voucher_series: voucher.series, voucher_number: voucher.number } : null,
    },
  }
}

describe('invoice underlag', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let ctx: { supabase: SupabaseClient; companyId: string }

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    ctx = { supabase: mock.supabase as unknown as SupabaseClient, companyId: COMPANY }
  })

  describe('listInvoiceUnderlag', () => {
    it('answers 404 for an invoice outside the company', async () => {
      mock.enqueue({ data: null })

      expect(await listInvoiceUnderlag(ctx, INVOICE)).toEqual({ ok: false, code: 'INVOICE_NOT_FOUND' })
    })

    it('lists each document with its own verifikat, never changed by the link', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: [underlagRow(DOC_A, 'dahl-88412.pdf', { series: 'b', number: 14 }), underlagRow(DOC_B, 'tidrapport.pdf')] })

      const outcome = await listInvoiceUnderlag(ctx, INVOICE)

      expect(outcome).toEqual({
        ok: true,
        data: {
          invoice_id: INVOICE,
          underlag: [
            {
              document_id: DOC_A,
              file_name: 'dahl-88412.pdf',
              mime_type: 'application/pdf',
              file_size_bytes: 2048,
              journal_entry_id: 'je-1',
              voucher: 'B14',
              document_created_at: '2026-10-02T08:00:00.000Z',
              attached_at: '2026-11-06T10:00:00.000Z',
            },
            expect.objectContaining({ document_id: DOC_B, journal_entry_id: null, voucher: null }),
          ],
        },
      })
      const filters = mock.calls.filter((c) => c.table === 'invoice_underlag' && c.method === 'eq').map((c) => c.args)
      expect(filters).toContainEqual(['company_id', COMPANY])
      expect(filters).toContainEqual(['invoice_id', INVOICE])
      // A quote, proforma or delivery note is not an invoice the underlag can rest on.
      const invoiceFilters = mock.calls.filter((c) => c.table === 'invoices' && c.method === 'eq').map((c) => c.args)
      expect(invoiceFilters).toContainEqual(['company_id', COMPANY])
      expect(invoiceFilters).toContainEqual(['document_type', 'invoice'])
    })

    it('answers an empty list while the table is not deployed yet', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: null } })
      mock.enqueue({ data: null, error: MISSING_TABLE })

      expect(await listInvoiceUnderlag(ctx, INVOICE)).toEqual({ ok: true, data: { invoice_id: INVOICE, underlag: [] } })
    })
  })

  describe('attachInvoiceUnderlag', () => {
    it('answers 404 for an invoice outside the company and writes nothing', async () => {
      mock.enqueue({ data: null })

      const outcome = await attachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_ids: [DOC_A] }, { dryRun: false })

      expect(outcome).toEqual({ ok: false, code: 'INVOICE_NOT_FOUND' })
      expect(mock.findCall('invoice_underlag', 'insert')).toBeUndefined()
    })

    it('answers a document of another company exactly like a missing one, and links none of the set', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: [] }) // no underlag yet
      mock.enqueue({ data: [{ id: DOC_A, file_name: 'a.pdf', is_current_version: true }] }) // DOC_B not in this company

      const outcome = await attachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_ids: [DOC_A, DOC_B] }, { dryRun: false })

      expect(outcome).toEqual({
        ok: false,
        code: 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND',
        details: { document_ids: [DOC_B] },
      })
      expect(mock.findCall('document_attachments', 'eq')).toEqual(['company_id', COMPANY])
      expect(mock.findCall('invoice_underlag', 'insert')).toBeUndefined()
    })

    it('refuses a superseded version: the version that stands is linked instead', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: [] })
      mock.enqueue({ data: [{ id: DOC_A, file_name: 'a.pdf', is_current_version: false }] })

      const outcome = await attachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_ids: [DOC_A] }, { dryRun: false })

      expect(outcome).toMatchObject({ ok: false, code: 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND' })
    })

    it('holds an invoice to the per-invoice ceiling', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({
        data: Array.from({ length: MAX_UNDERLAG_PER_INVOICE }, (_, i) =>
          underlagRow(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `${i}.pdf`),
        ),
      })
      mock.enqueue({ data: [{ id: DOC_A, file_name: 'a.pdf', is_current_version: true }] })

      const outcome = await attachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_ids: [DOC_A] }, { dryRun: false })

      expect(outcome).toMatchObject({ ok: false, code: 'INVOICE_UNDERLAG_TOO_MANY' })
      expect(mock.findCall('invoice_underlag', 'insert')).toBeUndefined()
    })

    it('a dry run says what would be linked and writes nothing', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: [underlagRow(DOC_A, 'a.pdf')] })
      mock.enqueue({ data: [{ id: DOC_B, file_name: 'dahl.pdf', is_current_version: true }] })

      const outcome = await attachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_ids: [DOC_A, DOC_B] }, { dryRun: true })

      expect(outcome).toEqual({
        ok: true,
        dryRun: true,
        preview: {
          invoice_id: INVOICE,
          invoice_number: '1042',
          attach: [{ document_id: DOC_B, file_name: 'dahl.pdf' }],
          already_attached_document_ids: [DOC_A],
          underlag_count_after: 2,
        },
      })
      expect(mock.findCall('invoice_underlag', 'insert')).toBeUndefined()
    })

    it('links new documents in the order given and leaves linked ones alone', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: [underlagRow(DOC_A, 'a.pdf')] })
      mock.enqueue({ data: [{ id: DOC_B, file_name: 'b.pdf', is_current_version: true }] })
      mock.enqueue({ data: null }) // insert DOC_B
      mock.enqueue({ data: [underlagRow(DOC_A, 'a.pdf'), underlagRow(DOC_B, 'b.pdf')] })

      const outcome = await attachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_ids: [DOC_A, DOC_B, DOC_B] }, { dryRun: false })

      expect(outcome).toMatchObject({ ok: true, data: { invoice_id: INVOICE, attached_document_ids: [DOC_B] } })
      expect(mock.findCalls('invoice_underlag', 'insert')).toEqual([
        [{ company_id: COMPANY, invoice_id: INVOICE, document_id: DOC_B }],
      ])
      // The document's own row is only read: its verifikat link is never written.
      expect(mock.findCall('document_attachments', 'update')).toBeUndefined()
    })

    it('treats a concurrent link of the same document as done', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: null } })
      mock.enqueue({ data: [] })
      mock.enqueue({ data: [{ id: DOC_A, file_name: 'a.pdf', is_current_version: true }] })
      mock.enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })
      mock.enqueue({ data: [underlagRow(DOC_A, 'a.pdf')] })

      const outcome = await attachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_ids: [DOC_A] }, { dryRun: false })

      expect(outcome).toMatchObject({ ok: true, data: { underlag: [expect.objectContaining({ document_id: DOC_A })] } })
    })

    it('answers a retryable refusal while the table is not deployed yet', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: null, error: MISSING_TABLE })

      const outcome = await attachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_ids: [DOC_A] }, { dryRun: false })

      expect(outcome).toEqual({ ok: false, code: 'INVOICE_UNDERLAG_UNAVAILABLE' })
    })
  })

  describe('detachInvoiceUnderlag', () => {
    it('answers 404 for a document the invoice does not rest on', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: [underlagRow(DOC_A, 'a.pdf')] })

      const outcome = await detachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_id: DOC_B }, { dryRun: false })

      expect(outcome).toEqual({ ok: false, code: 'INVOICE_UNDERLAG_NOT_FOUND', details: { document_id: DOC_B } })
      expect(mock.findCall('invoice_underlag', 'delete')).toBeUndefined()
    })

    it('a dry run names the file and writes nothing', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: [underlagRow(DOC_A, 'a.pdf')] })

      const outcome = await detachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_id: DOC_A }, { dryRun: true })

      expect(outcome).toEqual({
        ok: true,
        dryRun: true,
        preview: { invoice_id: INVOICE, invoice_number: '1042', document_id: DOC_A, file_name: 'a.pdf' },
      })
      expect(mock.findCall('invoice_underlag', 'delete')).toBeUndefined()
    })

    it('removes only the link, company-scoped', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: [underlagRow(DOC_A, 'a.pdf')] })
      mock.enqueue({ data: [{ id: 'link-1' }] })

      const outcome = await detachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_id: DOC_A }, { dryRun: false })

      expect(outcome).toEqual({ ok: true, data: { invoice_id: INVOICE, document_id: DOC_A, detached: true } })
      expect(mock.findCall('invoice_underlag', 'delete')).toBeDefined()
      expect(mock.findCall('document_attachments', 'delete')).toBeUndefined()
    })

    it('answers 404 when a concurrent call removed it first', async () => {
      mock.enqueue({ data: { id: INVOICE, invoice_number: '1042' } })
      mock.enqueue({ data: [underlagRow(DOC_A, 'a.pdf')] })
      mock.enqueue({ data: [] })

      const outcome = await detachInvoiceUnderlag(ctx, { invoice_id: INVOICE, document_id: DOC_A }, { dryRun: false })

      expect(outcome).toMatchObject({ ok: false, code: 'INVOICE_UNDERLAG_NOT_FOUND' })
    })
  })
})
