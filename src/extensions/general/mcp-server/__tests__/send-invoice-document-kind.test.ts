/**
 * gnubok_send_invoice stages the kind of document it delivers, so the
 * approval dialog names it: sending a quote read "skickas fakturan till
 * kunden", and the approver could not tell an offert from an invoice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/email/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/service')>()),
  getEmailService: () => ({ isConfigured: () => true }),
}))

import { tools } from '../server'
import { sentDocumentKind } from '../invoice-stage-preview'

const sendInvoice = tools.find((t) => t.name === 'gnubok_send_invoice')!

const INVOICE_ID = '33333333-3333-4333-8333-333333333333'
const ORIGINAL_ID = '55555555-5555-4555-8555-555555555555'

const DOCUMENT = {
  id: INVOICE_ID,
  invoice_number: 'OF-003',
  status: 'draft',
  document_type: 'quote',
  credited_invoice_id: null,
  journal_entry_id: null,
  total: 12500,
  total_sek: 12500,
  subtotal: 10000,
  vat_amount: 2500,
  currency: 'SEK',
  vat_treatment: 'standard_25',
  customer: { name: 'Testkund AB', email: 'ekonomi@example.com', address_line1: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm', country: 'SE' },
}

function setup(invoice: Record<string, unknown>) {
  return createTableMockSupabase({
    invoices: { data: invoice },
    invoice_items: { data: [] },
    invoice_attachments: { data: [] },
    document_attachments: { data: [] },
    company_settings: {
      data: {
        entity_type: 'enskild_firma',
        accounting_method: 'accrual',
        bookkeeping_locked_through: null,
        company_name: 'Test AB',
        address_line1: 'Testgatan 1',
        postal_code: '111 22',
        city: 'Stockholm',
      },
    },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    pending_operations: { data: { id: 'op-1' } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_send_invoice: the document it delivers', () => {
  it('stages a quote as a quote', async () => {
    const { supabase, findCall } = setup(DOCUMENT)

    const result = (await sendInvoice.execute(
      { invoice_id: INVOICE_ID },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.document_kind).toBe('quote')
    const staged = findCall('pending_operations', 'insert')![0] as { preview_data: Record<string, unknown> }
    expect(staged.preview_data.document_kind).toBe('quote')
  })

  it('stages an invoice as an invoice', async () => {
    const { supabase } = setup({ ...DOCUMENT, invoice_number: 'F-007', document_type: 'invoice' })

    const result = (await sendInvoice.execute(
      { invoice_id: INVOICE_ID },
      'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
    )) as { preview: Record<string, unknown> }

    expect(result.preview.document_kind).toBe('invoice')
  })
})

describe('sentDocumentKind', () => {
  it('reads the document type, and a credit note by the one rule that says what a credit note is', () => {
    expect(sentDocumentKind({ document_type: 'quote', credited_invoice_id: null, total: 100 })).toBe('quote')
    expect(sentDocumentKind({ document_type: 'proforma', credited_invoice_id: null, total: 100 })).toBe('proforma')
    expect(sentDocumentKind({ document_type: 'invoice', credited_invoice_id: ORIGINAL_ID, total: -100 })).toBe('credit_note')
    expect(sentDocumentKind({ document_type: 'invoice', credited_invoice_id: null, total: -100 })).toBe('credit_note')
    expect(sentDocumentKind({ document_type: 'invoice', credited_invoice_id: null, total: 100 })).toBe('invoice')
    expect(sentDocumentKind({ document_type: null, credited_invoice_id: null, total: 100 })).toBe('invoice')
  })
})
