/**
 * Offert (quote) surface on the MCP tools.
 *
 * A quote is document_type 'quote': numbered from its own OF-series at
 * approval (generate_quote_number, never generate_invoice_number), never
 * books, carries valid_until, and is decided with gnubok_set_quote_status.
 * gnubok_convert_invoice creates the faktura from an open or accepted quote.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const createInvoice = tools.find((t) => t.name === 'gnubok_create_invoice')!
const setQuoteStatus = tools.find((t) => t.name === 'gnubok_set_quote_status')!
const convertInvoice = tools.find((t) => t.name === 'gnubok_convert_invoice')!
const listInvoices = tools.find((t) => t.name === 'gnubok_list_invoices')!

const CUSTOMER = {
  id: 'cust-1',
  name: 'Testbrand AB',
  customer_type: 'swedish_business',
  vat_number_validated: false,
  default_payment_terms: 30,
}

const ITEMS = [{ description: 'Konsultation', quantity: 2, unit: 'tim', unit_price: 1000, vat_rate: 25 }]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_create_invoice: quotes', () => {
  it('declares document_type quote and valid_until on the input schema', () => {
    const props = (createInvoice.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
    expect(props.document_type.enum).toEqual(['invoice', 'quote'])
    expect(props.valid_until).toBeDefined()
  })

  it('requires valid_until for a quote', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      createInvoice.execute(
        { customer_id: 'cust-1', document_type: 'quote', items: ITEMS },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('refuses valid_until on a plain invoice', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      createInvoice.execute(
        { customer_id: 'cust-1', valid_until: '2026-12-31', items: ITEMS },
        'company-1',
        'user-1',
        supabase as never,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('stages a quote with due_date mirroring valid_until and no F-series preview', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: CUSTOMER, error: null }) // customers fetch
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
    enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
    enqueue({ data: { id: 'op-quote' }, error: null }) // pending_operations insert

    const result = (await createInvoice.execute(
      {
        customer_id: 'cust-1',
        document_type: 'quote',
        valid_until: '2026-12-31',
        invoice_date: '2026-09-02',
        items: ITEMS,
      },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; message: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview.document_type).toBe('quote')
    expect(result.preview.valid_until).toBe('2026-12-31')
    expect(result.preview.due_date).toBe('2026-12-31')
    expect(result.preview.total).toBe(2500)
    expect(String(result.preview.invoice_number)).not.toContain('F-PREVIEW')
    expect(result.preview.invoice_number).toBe('Offert OF-preview')

    // The staged params carry what the executor needs to allocate OF-nnn.
    const insertArgs = findCall('pending_operations', 'insert')
    expect(insertArgs).toBeDefined()
    const row = insertArgs![0] as { operation_type: string; title: string; params: Record<string, unknown> }
    expect(row.operation_type).toBe('create_invoice')
    expect(row.title).toContain('Ny offert')
    expect(row.params).toMatchObject({ document_type: 'quote', valid_until: '2026-12-31', due_date: '2026-12-31' })
  })
})

describe('gnubok_set_quote_status', () => {
  it('is a direct invoices:write tool with a strict schema', () => {
    expect(setQuoteStatus).toBeDefined()
    expect(setQuoteStatus.inputSchema.additionalProperties).toBe(false)
    expect(setQuoteStatus.annotations?.readOnlyHint).toBe(false)
  })

  it('records the decision and returns the effective status', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'q-1', document_type: 'quote', status: 'sent', quote_status: 'open', quote_decided_at: null }, error: null })
    enqueue({ data: null, error: null }) // converted_from_id lookup: nothing yet
    enqueue({
      data: {
        id: 'q-1',
        invoice_number: 'OF-003',
        document_type: 'quote',
        status: 'sent',
        quote_status: 'accepted',
        quote_decided_at: '2026-09-02T10:00:00.000Z',
        valid_until: '2099-12-31',
      },
      error: null,
    })

    const result = (await setQuoteStatus.execute(
      { invoice_id: 'q-1', status: 'accepted' },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(result).toMatchObject({
      invoice_id: 'q-1',
      invoice_number: 'OF-003',
      document_type: 'quote',
      quote_status: 'accepted',
      effective_quote_status: 'accepted',
      valid_until: '2099-12-31',
    })
    expect(findCall('invoices', 'update')?.[0]).toMatchObject({ quote_status: 'accepted' })
  })

  it('reports expired for an open quote past valid_until', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'q-1', document_type: 'quote', status: 'sent', quote_status: 'declined', quote_decided_at: 'x' }, error: null })
    enqueue({ data: null, error: null })
    enqueue({
      data: { id: 'q-1', invoice_number: 'OF-003', document_type: 'quote', status: 'sent', quote_status: 'open', quote_decided_at: null, valid_until: '2020-01-01' },
      error: null,
    })

    const result = (await setQuoteStatus.execute(
      { invoice_id: 'q-1', status: 'open' },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(result.quote_status).toBe('open')
    expect(result.effective_quote_status).toBe('expired')
  })

  it('refuses a document that is not a quote with INVOICE_NOT_A_QUOTE', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'i-1', document_type: 'invoice', status: 'sent', quote_status: null, quote_decided_at: null }, error: null })

    await expect(
      setQuoteStatus.execute({ invoice_id: 'i-1', status: 'accepted' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'INVOICE_NOT_A_QUOTE' })
    expect(findCall('invoices', 'update')).toBeUndefined()
  })

  it('locks the decision once the quote has been invoiced', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'q-1', document_type: 'quote', status: 'sent', quote_status: 'accepted', quote_decided_at: 'x' }, error: null })
    enqueue({ data: { id: 'inv-9' }, error: null }) // active converted invoice exists

    await expect(
      setQuoteStatus.execute({ invoice_id: 'q-1', status: 'declined' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'INVOICE_QUOTE_ALREADY_INVOICED' })
  })

  it('rejects an unknown status before touching the database', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      setQuoteStatus.execute({ invoice_id: 'q-1', status: 'expired' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('gnubok_convert_invoice: quotes', () => {
  it('fails on a declined quote with INVOICE_CONVERT_QUOTE_DECLINED', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'q-1', invoice_number: 'OF-003', document_type: 'quote', status: 'sent', quote_status: 'declined', total: 2500, currency: 'SEK', customer: { name: 'Testbrand AB' } },
      error: null,
    })

    await expect(
      convertInvoice.execute({ invoice_id: 'q-1' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'INVOICE_CONVERT_QUOTE_DECLINED' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('fails on an already-invoiced quote with INVOICE_QUOTE_ALREADY_INVOICED', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'q-1', invoice_number: 'OF-003', document_type: 'quote', status: 'sent', quote_status: 'accepted', total: 2500, currency: 'SEK', customer: { name: 'Testbrand AB' } },
      error: null,
    })
    enqueue({ data: { id: 'inv-9' }, error: null })

    await expect(
      convertInvoice.execute({ invoice_id: 'q-1' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'INVOICE_QUOTE_ALREADY_INVOICED' })
  })

  it('still refuses a regular invoice with INVOICE_CONVERT_NOT_CONVERTIBLE', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'i-1', invoice_number: '2026-0001', document_type: 'invoice', status: 'sent', quote_status: null, total: 2500, currency: 'SEK', customer: { name: 'Testbrand AB' } },
      error: null,
    })

    await expect(
      convertInvoice.execute({ invoice_id: 'i-1' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'INVOICE_CONVERT_NOT_CONVERTIBLE' })
  })

  it('stages the conversion of an open quote with an offert summary', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'q-1', invoice_number: 'OF-003', document_type: 'quote', status: 'sent', quote_status: 'open', total: 2500, currency: 'SEK', customer: { name: 'Testbrand AB' } },
      error: null,
    })
    enqueue({ data: null, error: null }) // converted_from_id lookup
    enqueue({ data: { id: 'op-convert' }, error: null }) // pending_operations insert

    const result = (await convertInvoice.execute(
      { invoice_id: 'q-1' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { staged: boolean; message: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    const row = findCall('pending_operations', 'insert')![0] as { title: string }
    expect(row.title).toContain('Konvertera offert')
    expect(row.title).toContain('OF-003')
    expect(result.preview.source_document_type).toBe('quote')
    expect(String(result.preview.will)).toContain('accepted')
  })
})

describe('gnubok_list_invoices: quote filters', () => {
  it('filters expired quotes as open past valid_until and exposes the derived status', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'q-1', invoice_number: 'OF-001', status: 'sent', document_type: 'quote', quote_status: 'open', valid_until: '2020-01-01', total: 100, currency: 'SEK', customers: { name: 'Testbrand AB' } },
      ],
      error: null,
      count: 1,
    })

    const result = (await listInvoices.execute(
      { quote_status: 'expired' },
      'company-1',
      'user-1',
      supabase as never,
    )) as { invoices: Array<Record<string, unknown>> }

    expect(result.invoices[0]).toMatchObject({ document_type: 'quote', valid_until: '2020-01-01', quote_status: 'expired' })
    const eqCalls = findCalls('invoices', 'eq')
    expect(eqCalls).toContainEqual(['document_type', 'quote'])
    expect(eqCalls).toContainEqual(['quote_status', 'open'])
    expect(findCalls('invoices', 'lt')[0]?.[0]).toBe('valid_until')
  })

  it('returns quote_status null for a regular invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [{ id: 'i-1', invoice_number: '2026-0001', status: 'sent', document_type: 'invoice', quote_status: null, valid_until: null, total: 100, currency: 'SEK', customers: null }],
      error: null,
      count: 1,
    })

    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as {
      invoices: Array<Record<string, unknown>>
    }

    expect(result.invoices[0].quote_status).toBeNull()
    expect(result.invoices[0].valid_until).toBeNull()
  })
})
