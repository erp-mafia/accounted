/**
 * invoice.sent carries the invoice's payment reference (crm#1886), the same
 * two fields GET /invoices/{id} answers, and still goes out when they could
 * not be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { emitInvoiceSent } from '@/lib/invoices/invoice-sent-event'
import { minimisePayload } from '@/lib/webhooks/handler'
import type { Logger } from '@/lib/logger'
import { createTableMockSupabase, makeCompanySettings, makeInvoice, type TableMockResult } from '@/tests/helpers'

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }

/** A client that answers the reads of withPaymentReference by table. */
function client(byTable: Record<string, TableMockResult>) {
  const mock = createTableMockSupabase(byTable)
  return { supabase: mock.supabase as unknown as SupabaseClient, tables: mock.tables }
}

const issued = () =>
  makeInvoice({ id: 'inv-1', invoice_number: '1042', status: 'draft', document_type: 'invoice', currency: 'SEK', total: 1250 })

const sent = vi.fn(async (..._args: unknown[]) => undefined)

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  eventBus.on('invoice.sent', sent)
})

const FACTS = { id: 'inv-1', payment_details: null, autogiro_payer_number: null, customer: { language: 'sv' } }

describe('emitInvoiceSent', () => {
  it('emits the invoice at status sent with the reference its PDF prints', async () => {
    const { supabase, tables } = client({ invoices: { data: [FACTS] } })

    await emitInvoiceSent({
      supabase,
      companyId: 'co-1',
      userId: 'user-1',
      invoice: issued(),
      settings: makeCompanySettings({ bankgiro: '5050-1055' }),
      log,
    })

    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0][0]).toMatchObject({
      companyId: 'co-1',
      userId: 'user-1',
      invoice: {
        id: 'inv-1',
        invoice_number: '1042',
        status: 'sent',
        payment_reference: '10421',
        payment_reference_type: 'ocr',
      },
    })
    // The door's own settings row decides: the company is not read again.
    expect(tables()).toEqual(['invoices'])
  })

  it('reaches a webhook receiver: the outbound projection keeps both fields', async () => {
    const { supabase } = client({ invoices: { data: [FACTS] } })

    await emitInvoiceSent({
      supabase,
      companyId: 'co-1',
      userId: 'user-1',
      invoice: issued(),
      settings: makeCompanySettings(),
      log,
    })

    const outbound = minimisePayload(sent.mock.calls[0][0] as Record<string, unknown>)
    expect(outbound.invoice).toMatchObject({ payment_reference: '1042', payment_reference_type: 'invoice_number' })
  })

  it('says null for a document that asks for no payment, without reading anything', async () => {
    const { supabase, tables } = client({})

    await emitInvoiceSent({
      supabase,
      companyId: 'co-1',
      userId: 'user-1',
      invoice: makeInvoice({ id: 'pf-1', invoice_number: 'PF-1', document_type: 'proforma' }),
      settings: makeCompanySettings({ bankgiro: '5050-1055' }),
      log,
    })

    expect(tables()).toEqual([])
    expect(sent.mock.calls[0][0]).toMatchObject({
      invoice: { id: 'pf-1', status: 'sent', payment_reference: null, payment_reference_type: null },
    })
  })

  it('still emits when the reference cannot be read, without the two fields', async () => {
    const { supabase } = client({ invoices: { error: { message: 'connection reset' } } })

    await emitInvoiceSent({
      supabase,
      companyId: 'co-1',
      userId: 'user-1',
      invoice: issued(),
      settings: makeCompanySettings({ bankgiro: '5050-1055' }),
      log,
    })

    expect(sent).toHaveBeenCalledTimes(1)
    const payload = sent.mock.calls[0][0] as { invoice: Record<string, unknown> }
    expect(payload.invoice).toMatchObject({ id: 'inv-1', status: 'sent' })
    // Absent, not null: null would say the invoice has no reference.
    expect(payload.invoice).not.toHaveProperty('payment_reference')
    expect(payload.invoice).not.toHaveProperty('payment_reference_type')
    expect(log.warn).toHaveBeenCalled()
  })
})
