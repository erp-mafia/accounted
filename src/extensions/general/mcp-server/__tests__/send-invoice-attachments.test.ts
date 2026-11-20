/**
 * gnubok_send_invoice with attachment_document_ids (crm#1269): files of the
 * company archive emailed after the invoice PDF. Staging checks them (same
 * company, current version, count and size) and carries the ids to the
 * approval; nothing is attached before the approval runs the send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/email/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/service')>()),
  getEmailService: () => ({ isConfigured: () => true }),
}))

import { tools } from '../server'

const sendInvoice = tools.find((t) => t.name === 'gnubok_send_invoice')!

const INVOICE_ID = '33333333-3333-4333-8333-333333333333'
const DOCUMENT_ID = '44444444-4444-4444-8444-444444444444'

const DRAFT = {
  id: INVOICE_ID,
  invoice_number: 'F-007',
  status: 'draft',
  document_type: 'invoice',
  credited_invoice_id: null,
  journal_entry_id: null,
  total: 12500,
  total_sek: 12500,
  subtotal: 10000,
  vat_amount: 2500,
  currency: 'SEK',
  vat_treatment: 'standard_25',
  customer: { name: 'Testkund AB', email: 'ekonomi@example.com' },
}

function setup(documents: unknown[]) {
  return createTableMockSupabase({
    invoices: { data: DRAFT },
    invoice_items: { data: [] },
    invoice_attachments: { data: [] },
    document_attachments: { data: documents },
    company_settings: {
      data: { entity_type: 'enskild_firma', accounting_method: 'accrual', bookkeeping_locked_through: null },
    },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    pending_operations: { data: { id: 'op-1' } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_send_invoice: attachment_document_ids', () => {
  it('stages the ids with the file names in the preview, attaching nothing yet', async () => {
    const { supabase, findCall } = setup([
      {
        id: DOCUMENT_ID,
        file_name: 'tidrapport-juli.pdf',
        mime_type: 'application/pdf',
        file_size_bytes: 2048,
        created_at: '2026-10-16T10:00:00.000Z',
        is_current_version: true,
      },
    ])

    const result = (await sendInvoice.execute(
      { invoice_id: INVOICE_ID, attachment_document_ids: [DOCUMENT_ID] },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.attachments).toEqual(['tidrapport-juli.pdf'])
    const staged = findCall('pending_operations', 'insert')![0] as { params: Record<string, unknown> }
    expect(staged.params).toEqual({ invoice_id: INVOICE_ID, attachment_document_ids: [DOCUMENT_ID] })
    expect(findCall('invoice_attachments', 'insert')).toBeUndefined()
    // The document lookup is scoped to the calling company.
    expect(findCall('document_attachments', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('refuses a document of another company and stages nothing', async () => {
    // The company-scoped lookup finds nothing: a foreign id reads as missing.
    const { supabase, findCall } = setup([])

    await expect(
      sendInvoice.execute(
        { invoice_id: INVOICE_ID, attachment_document_ids: [DOCUMENT_ID] },
        'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
      ),
    ).rejects.toMatchObject({ code: 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('keeps the params unchanged when no attachments are asked for', async () => {
    const { supabase, findCall } = setup([])

    await sendInvoice.execute(
      { invoice_id: INVOICE_ID },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )

    const staged = findCall('pending_operations', 'insert')![0] as { params: Record<string, unknown> }
    expect(staged.params).toEqual({ invoice_id: INVOICE_ID })
  })
})
