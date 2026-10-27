import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const mockDownloadDocumentObject = vi.fn()
const mockComputeSHA256 = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  downloadDocumentObject: (...args: unknown[]) => mockDownloadDocumentObject(...args),
  computeSHA256: (...args: unknown[]) => mockComputeSHA256(...args),
}))

import { loadArchivedInvoicePdf } from '../archived-invoice-pdf'

/**
 * The archived invoice PDF, read two ways: as the person's own session
 * ("Skicka igen") and as the service role for a named company member (the
 * reminder sender, where the session reader refuses a caller without
 * auth.uid()).
 */

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never
const DELIVERY = {
  id: 'delivery-1',
  channel: 'email',
  status: 'sent',
  document_attachment_id: 'doc-1',
  attachment_filename: 'Faktura-2026-0042.pdf',
  sent_at: '2026-10-01T08:00:00.000Z',
  created_at: '2026-10-01T07:59:58.000Z',
}
const DOCUMENT = { id: 'doc-1', file_name: 'stored.pdf', storage_path: 'company-1/doc-1.pdf', sha256_hash: 'sha-sent' }

function world() {
  return createTableMockSupabase({
    'rpc:list_invoice_delivery_summaries': { data: [DELIVERY] },
    'rpc:list_invoice_delivery_summaries_for_service': { data: [DELIVERY] },
    document_attachments: { data: DOCUMENT },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDownloadDocumentObject.mockResolvedValue({ blob: new Blob([new Uint8Array([37, 80, 68, 70])]) })
  mockComputeSHA256.mockResolvedValue('sha-sent')
})

describe('loadArchivedInvoicePdf', () => {
  it("reads the delivery history as the person's own session by default", async () => {
    const mock = world()
    const result = await loadArchivedInvoicePdf(mock.supabase as unknown as SupabaseClient, 'company-1', 'inv-1', log)

    expect(result).toMatchObject({ ok: true, value: { filename: 'Faktura-2026-0042.pdf', delivery: { id: 'delivery-1' } } })
    expect(mock.supabase.rpc).toHaveBeenCalledTimes(1)
    expect(mock.supabase.rpc).toHaveBeenCalledWith('list_invoice_delivery_summaries', { p_company_id: 'company-1', p_invoice_id: 'inv-1' })
  })

  it('reads it as the service role for the named member when asked', async () => {
    const mock = world()
    const result = await loadArchivedInvoicePdf(mock.supabase as unknown as SupabaseClient, 'company-1', 'inv-1', log, {
      serviceActorUserId: 'user-1',
    })

    expect(result).toMatchObject({ ok: true, value: { filename: 'Faktura-2026-0042.pdf' } })
    expect(mock.supabase.rpc).toHaveBeenCalledTimes(1)
    expect(mock.supabase.rpc).toHaveBeenCalledWith('list_invoice_delivery_summaries_for_service', {
      p_company_id: 'company-1',
      p_user_id: 'user-1',
      p_invoice_id: 'inv-1',
    })
  })

  it('answers unavailable when the reader refuses, and no copy when nothing was emailed', async () => {
    const refused = createTableMockSupabase({
      'rpc:list_invoice_delivery_summaries_for_service': { data: null, error: { code: '42501', message: 'invoice delivery reader is not a company member' } },
    })
    expect(
      await loadArchivedInvoicePdf(refused.supabase as unknown as SupabaseClient, 'company-1', 'inv-1', log, { serviceActorUserId: 'gone-1' }),
    ).toEqual({ ok: false, code: 'INVOICE_RESEND_ARCHIVE_UNAVAILABLE' })

    const none = createTableMockSupabase({ 'rpc:list_invoice_delivery_summaries_for_service': { data: [] } })
    expect(
      await loadArchivedInvoicePdf(none.supabase as unknown as SupabaseClient, 'company-1', 'inv-1', log, { serviceActorUserId: 'user-1' }),
    ).toEqual({ ok: false, code: 'INVOICE_RESEND_NO_ARCHIVED_COPY' })
  })

  it('refuses a file that does not match its stored checksum', async () => {
    mockComputeSHA256.mockResolvedValue('sha-other')
    const mock = world()
    expect(
      await loadArchivedInvoicePdf(mock.supabase as unknown as SupabaseClient, 'company-1', 'inv-1', log, { serviceActorUserId: 'user-1' }),
    ).toEqual({ ok: false, code: 'INVOICE_RESEND_ARCHIVE_UNAVAILABLE' })
  })
})
