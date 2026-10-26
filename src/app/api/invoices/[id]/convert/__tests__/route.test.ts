import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual = await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return {
    ...actual,
    fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args),
  }
})

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'

describe('POST /api/invoices/[id]/convert', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  const baseProforma = {
    id: 'pf-1',
    document_type: 'proforma',
    status: 'draft',
    customer_id: 'customer-1',
    due_date: '2026-06-15',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 10000,
    subtotal_sek: null,
    vat_amount: 2500,
    vat_amount_sek: null,
    total: 12500,
    total_sek: null,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    moms_ruta: '10',
    reverse_charge_text: null,
    your_reference: null,
    our_reference: null,
    notes: null,
    items: [
      {
        sort_order: 0,
        description: 'Konsultation',
        quantity: 10,
        unit: 'tim',
        unit_price: 1000,
        line_total: 10000,
      },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 404 when proforma not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('returns 400 when invoice is not a proforma', async () => {
    enqueue({ data: { ...baseProforma, document_type: 'invoice' }, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('does NOT advance the F-series counter when items insert fails', async () => {
    // 1. fetch proforma
    enqueue({ data: baseProforma, error: null })
    // 2. insert real invoice with null number, succeeds
    enqueue({
      data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' },
      error: null,
    })
    // 3. insert items, FAILS
    enqueue({ data: null, error: { message: 'items insert failed' } })
    // 4. rollback delete of orphan row, succeeds
    enqueue({ data: null, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
    // Critical: counter must not have been touched.
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('rolls back the orphan invoice when proforma cancel fails', async () => {
    // 1. fetch proforma
    enqueue({ data: baseProforma, error: null })
    // 2. insert real invoice
    enqueue({
      data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' },
      error: null,
    })
    // 3. insert items
    enqueue({ data: null, error: null })
    // 4. cancel proforma, FAILS
    enqueue({ data: null, error: { message: 'cancel failed' } })
    // 5. rollback delete of orphan invoice
    enqueue({ data: null, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(body.error).toBe('Något gick fel. Försök igen.')
    // Counter must not have been touched and orphan invoice must have been
    // deleted (5 enqueued calls all consumed).
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('rolls back invoice + un-cancels proforma when number allocation fails', async () => {
    // 1. fetch proforma
    enqueue({ data: baseProforma, error: null })
    // 2. insert real invoice
    enqueue({
      data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' },
      error: null,
    })
    // 3. insert items
    enqueue({ data: null, error: null })
    // 4. cancel proforma, succeeds (compare-and-set returns the row)
    enqueue({ data: [{ id: 'pf-1' }], error: null })
    // 5. ensureInvoiceNumber → rpc THROWS
    enqueue({ data: null, error: { message: 'number allocation failed' } })
    // 6. un-cancel proforma (restore previous status)
    enqueue({ data: null, error: null })
    // 7. delete orphan invoice
    enqueue({ data: null, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
  })

  it('allocates the F-number after items + proforma cancel succeed', async () => {
    // 1. fetch proforma
    enqueue({ data: baseProforma, error: null })
    // 2. insert real invoice
    enqueue({
      data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' },
      error: null,
    })
    // 3. insert items
    enqueue({ data: null, error: null })
    // 4. cancel proforma (compare-and-set returns the row)
    enqueue({ data: [{ id: 'pf-1' }], error: null })
    // 5. ensureInvoiceNumber → rpc returns the assigned F-number
    enqueue({ data: 'F-2026005', error: null })
    // 6. fetch complete invoice
    enqueue({
      data: { id: 'inv-1', invoice_number: 'F-2026005', items: [] },
      error: null,
    })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status, body } = await parseJsonResponse<{ data: { invoice_number: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.invoice_number).toBe('F-2026005')
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'generate_invoice_number',
      expect.objectContaining({
        p_company_id: 'company-1',
        p_invoice_id: 'inv-1',
      })
    )
  })

  describe('quotes (offert)', () => {
    const baseQuote = {
      ...baseProforma,
      id: 'q-1',
      document_type: 'quote',
      status: 'sent',
      invoice_number: 'OF-003',
      valid_until: '2026-06-30',
      quote_status: 'open',
      quote_decided_at: null,
      customer: { default_payment_terms: 20 },
    }

    it('refuses a declined quote', async () => {
      enqueue({ data: { ...baseQuote, quote_status: 'declined' }, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/q-1/convert', { method: 'POST' }),
        createMockRouteParams({ id: 'q-1' })
      )
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('INVOICE_CONVERT_QUOTE_DECLINED')
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
    })

    it('refuses another conversion once the live invoices cover the quote', async () => {
      // 1. fetch quote
      enqueue({ data: baseQuote, error: null })
      // 2. the live invoices converted from the quote already bill all of it
      enqueue({ data: [{ id: 'inv-9', status: 'sent', subtotal: 10000, items: [] }], error: null })

      const response = await POST(
        createMockRequest('/api/invoices/q-1/convert', { method: 'POST' }),
        createMockRouteParams({ id: 'q-1' })
      )
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('INVOICE_QUOTE_ALREADY_INVOICED')
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
    })

    it('refuses while a live kundorder was created from the quote (invoice from the order instead)', async () => {
      // 1. fetch quote
      enqueue({ data: baseQuote, error: null })
      // 2. no converted invoice
      enqueue({ data: null, error: null })
      // 3. one live sales order with source_invoice_id = quote
      enqueue({ data: null, count: 1, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/q-1/convert', { method: 'POST' }),
        createMockRouteParams({ id: 'q-1' })
      )
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('INVOICE_QUOTE_ALREADY_ORDERED')
      expect(findCalls('sales_orders', 'eq')).toContainEqual(['source_invoice_id', 'q-1'])
      expect(findCall('invoices', 'insert')).toBeUndefined()
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
    })

    it('creates the invoice with a due date from the customer terms, marks the quote accepted and keeps it', async () => {
      // 1. fetch quote
      enqueue({ data: baseQuote, error: null })
      // 2. no existing conversion
      enqueue({ data: null, error: null })
      // 2b. no live sales order from the quote
      enqueue({ data: null, count: 0, error: null })
      // 3. insert invoice
      enqueue({ data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' }, error: null })
      // 4. insert items
      enqueue({ data: null, error: null })
      // 5. quote -> accepted (compare-and-set returns the row)
      enqueue({ data: [{ id: 'q-1' }], error: null })
      // 6. generate_invoice_number RPC
      enqueue({ data: 'F-042', error: null })
      // 7. refetch complete invoice
      enqueue({ data: { id: 'inv-1', invoice_number: 'F-042', document_type: 'invoice', items: [] }, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/q-1/convert', { method: 'POST' }),
        createMockRouteParams({ id: 'q-1' })
      )
      const { status, body } = await parseJsonResponse<{ data: { invoice_number: string } }>(response)

      expect(status).toBe(200)
      expect(body.data.invoice_number).toBe('F-042')

      const inserted = findCall('invoices', 'insert')?.[0] as Record<string, unknown>
      expect(inserted.document_type).toBe('invoice')
      expect(inserted.converted_from_id).toBe('q-1')
      expect(inserted.quote_status).toBeNull()
      expect(inserted.valid_until).toBeNull()
      expect(inserted.remaining_amount).toBe(12500)
      // invoice_date is today; due_date is today + the customer's 20 days, never the quote's valid_until.
      const today = todayIsoStockholm()
      expect(inserted.invoice_date).toBe(today)
      expect(inserted.due_date).toBe(addDaysIso(today, 20))

      const updates = findCalls('invoices', 'update').map((args) => args[0] as Record<string, unknown>)
      expect(updates.some((u) => u.quote_status === 'accepted')).toBe(true)
      expect(updates.some((u) => u.status === 'cancelled')).toBe(false)
    })

    // crm#1200: Er referens on the converted invoice.
    async function convertQuote(quote: Record<string, unknown>) {
      enqueue({ data: quote, error: null }) // fetch quote
      enqueue({ data: null, error: null }) // no existing conversion
      enqueue({ data: null, count: 0, error: null }) // no live sales order
      enqueue({ data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' }, error: null }) // insert invoice
      enqueue({ data: null, error: null }) // insert items
      enqueue({ data: [{ id: 'q-1' }], error: null }) // quote -> accepted
      enqueue({ data: 'F-042', error: null }) // generate_invoice_number
      enqueue({ data: { id: 'inv-1', invoice_number: 'F-042', document_type: 'invoice', items: [] }, error: null })
      const response = await POST(
        createMockRequest('/api/invoices/q-1/convert', { method: 'POST' }),
        createMockRouteParams({ id: 'q-1' })
      )
      expect(response.status).toBe(200)
      return findCall('invoices', 'insert')?.[0] as Record<string, unknown>
    }

    it("takes the customer card's Fakturareferens when the quote has no Er referens", async () => {
      const inserted = await convertQuote({
        ...baseQuote,
        your_reference: null,
        customer: { default_payment_terms: 20, invoice_reference: 'KST 4410' },
      })
      expect(inserted.your_reference).toBe('KST 4410')
      expect(findCall('invoices', 'select')?.[0]).toContain('invoice_reference')
    })

    it("keeps the quote's own Er referens over the customer card", async () => {
      const inserted = await convertQuote({
        ...baseQuote,
        your_reference: 'Anna Andersson',
        customer: { default_payment_terms: 20, invoice_reference: 'KST 4410' },
      })
      expect(inserted.your_reference).toBe('Anna Andersson')
    })

    it("takes the customer card's Märkning when the quote has none (crm#1477)", async () => {
      const inserted = await convertQuote({
        ...baseQuote,
        invoice_marking: null,
        customer: { default_payment_terms: 20, invoice_marking: '4500012345' },
      })
      expect(inserted.invoice_marking).toBe('4500012345')
      expect(findCall('invoices', 'select')?.[0]).toContain('invoice_marking')
    })

    it("keeps the quote's own Märkning over the customer card", async () => {
      const inserted = await convertQuote({
        ...baseQuote,
        invoice_marking: 'Projekt Norr',
        customer: { default_payment_terms: 20, invoice_marking: '4500012345' },
      })
      expect(inserted.invoice_marking).toBe('Projekt Norr')
    })

    // accounted#18: 23:30 UTC is already the next day in Stockholm, in summer
    // (UTC+2) and in winter (UTC+1). The invoice is dated that day and the
    // terms count from it.
    describe('dates on the Swedish day', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it.each([
        ['summer', '2026-07-01T23:30:00Z', '2026-07-02', '2026-07-22'],
        ['winter', '2026-01-15T23:30:00Z', '2026-01-16', '2026-02-05'],
      ])('%s: a quote converted at %s is dated %s and due %s', async (_season, instant, invoiceDate, dueDate) => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date(instant))
        enqueue({ data: baseQuote, error: null }) // fetch quote
        enqueue({ data: null, error: null }) // no existing conversion
        enqueue({ data: null, count: 0, error: null }) // no live sales order
        enqueue({ data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' }, error: null }) // insert invoice
        enqueue({ data: null, error: null }) // insert items
        enqueue({ data: [{ id: 'q-1' }], error: null }) // quote -> accepted
        enqueue({ data: 'F-042', error: null }) // generate_invoice_number
        enqueue({ data: { id: 'inv-1', invoice_number: 'F-042', document_type: 'invoice', items: [] }, error: null }) // refetch

        const response = await POST(
          createMockRequest('/api/invoices/q-1/convert', { method: 'POST' }),
          createMockRouteParams({ id: 'q-1' })
        )
        expect(response.status).toBe(200)
        const inserted = findCall('invoices', 'insert')?.[0] as Record<string, unknown>
        expect(inserted.invoice_date).toBe(invoiceDate)
        expect(inserted.due_date).toBe(dueDate)
      })
    })

    // crm#1084: the invoice prints what the accepted quote printed. The line
    // text (in the customer's language) and the article number travel from
    // the quote's own line; the article is never read again.
    it("carries each quote line's text and article number onto the invoice", async () => {
      const quoteLine = {
        sort_order: 0,
        description: 'Consulting hour',
        quantity: 10,
        unit: 'tim',
        unit_price: 1000,
        line_total: 10000,
        article_id: 'art-1',
        article_number: 'A-100',
      }
      const freeLine = { ...baseProforma.items[0], sort_order: 1 }
      enqueue({ data: { ...baseQuote, items: [quoteLine, freeLine] }, error: null })
      enqueue({ data: null, error: null })
      enqueue({ data: null, count: 0, error: null })
      enqueue({ data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' }, error: null })
      enqueue({ data: null, error: null })
      enqueue({ data: [{ id: 'q-1' }], error: null })
      enqueue({ data: 'F-043', error: null })
      enqueue({ data: { id: 'inv-1', invoice_number: 'F-043', document_type: 'invoice', items: [] }, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/q-1/convert', { method: 'POST' }),
        createMockRouteParams({ id: 'q-1' })
      )

      expect(response.status).toBe(200)
      const rows = findCall('invoice_items', 'insert')?.[0] as Array<Record<string, unknown>>
      expect(rows.map((r) => [r.description, r.article_id, r.article_number])).toEqual([
        ['Consulting hour', 'art-1', 'A-100'],
        ['Konsultation', null, null],
      ])
      expect(mockSupabase.from).not.toHaveBeenCalledWith('articles')
    })
  })

  describe('foreign-currency sources', () => {
    const eurQuote = {
      ...baseProforma,
      id: 'q-eur',
      document_type: 'quote',
      status: 'sent',
      invoice_number: 'OF-004',
      valid_until: '2026-08-31',
      quote_status: 'open',
      quote_decided_at: null,
      currency: 'EUR',
      exchange_rate: 11.1,
      exchange_rate_date: '2026-06-01',
      subtotal_sek: 111000,
      vat_amount_sek: 27750,
      total_sek: 138750,
      customer: { default_payment_terms: 30 },
    }

    it('books the converted invoice at the rate of the conversion day, not the quote day', async () => {
      mockFetchExchangeRate.mockResolvedValue({ rate: 11.45, date: '2026-07-28' })
      enqueue({ data: eurQuote, error: null }) // fetch quote
      enqueue({ data: null, error: null }) // no existing conversion
      enqueue({ data: null, count: 0, error: null }) // no live sales order
      enqueue({ data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' }, error: null })
      enqueue({ data: null, error: null }) // items
      enqueue({ data: [{ id: 'q-eur' }], error: null }) // quote -> accepted
      enqueue({ data: 'F-050', error: null }) // number
      enqueue({ data: { id: 'inv-1', invoice_number: 'F-050', document_type: 'invoice', items: [] }, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/q-eur/convert', { method: 'POST' }),
        createMockRouteParams({ id: 'q-eur' })
      )
      const { status } = await parseJsonResponse(response)

      expect(status).toBe(200)
      expect(mockFetchExchangeRate).toHaveBeenCalledWith('EUR', expect.any(Date), expect.anything())
      const inserted = findCall('invoices', 'insert')?.[0] as Record<string, unknown>
      expect(inserted.exchange_rate).toBe(11.45)
      expect(inserted.exchange_rate_date).toBe('2026-07-28')
      expect(inserted.subtotal_sek).toBeCloseTo(114500, 2)
      expect(inserted.vat_amount_sek).toBeCloseTo(28625, 2)
      expect(inserted.total_sek).toBeCloseTo(143125, 2)
    })

    it('fails closed before inserting anything when no rate can be fetched', async () => {
      mockFetchExchangeRate.mockResolvedValue(null)
      enqueue({ data: eurQuote, error: null })
      enqueue({ data: null, error: null })
      enqueue({ data: null, count: 0, error: null }) // no live sales order

      const response = await POST(
        createMockRequest('/api/invoices/q-eur/convert', { method: 'POST' }),
        createMockRouteParams({ id: 'q-eur' })
      )
      const { status } = await parseJsonResponse(response)

      expect(status).toBe(500)
      expect(findCall('invoices', 'insert')).toBeUndefined()
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
    })
  })

  it('maps the unique index the guard replaced (a deploy ahead of migration 20261015120000) to INVOICE_QUOTE_ALREADY_INVOICED', async () => {
    enqueue({ data: { ...baseProforma, id: 'q-1', document_type: 'quote', status: 'sent', quote_status: 'open', customer: { default_payment_terms: 30 } }, error: null })
    enqueue({ data: null, error: null }) // existence check passed (race)
    enqueue({ data: null, count: 0, error: null }) // no live sales order
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_invoices_one_live_conversion"' } })

    const response = await POST(
      createMockRequest('/api/invoices/q-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'q-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_QUOTE_ALREADY_INVOICED')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('maps the converted-source guard trigger (a kundorder went live meanwhile) to INVOICE_QUOTE_ALREADY_ORDERED', async () => {
    enqueue({ data: { ...baseProforma, id: 'q-1', document_type: 'quote', status: 'sent', quote_status: 'accepted', customer: { default_payment_terms: 30 } }, error: null })
    enqueue({ data: null, error: null }) // no converted invoice
    enqueue({ data: null, count: 0, error: null }) // no live order at pre-check time (race)
    enqueue({ data: null, error: { code: 'P0001', message: 'INVOICE_QUOTE_ALREADY_ORDERED: quote q-1 has a live kundorder' } })

    const response = await POST(
      createMockRequest('/api/invoices/q-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'q-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_QUOTE_ALREADY_ORDERED')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  describe('a quote in parts (crm#1196)', () => {
    const partQuote = {
      ...baseProforma,
      id: 'q-1',
      document_type: 'quote',
      status: 'sent',
      invoice_number: 'OF-012',
      valid_until: '2026-06-30',
      quote_status: 'accepted',
      quote_decided_at: '2026-06-01T10:00:00Z',
      subtotal: 25000,
      vat_amount: 6250,
      total: 31250,
      notes: 'Tack för förtroendet',
      customer: { default_payment_terms: 30, language: 'sv' },
      items: [
        {
          sort_order: 0,
          line_type: 'product',
          description: 'Webbprojekt, fast pris',
          quantity: 1,
          unit: 'st',
          unit_price: 25000,
          discount_percent: 0,
          line_total: 25000,
          vat_rate: 25,
          vat_amount: 6250,
          revenue_account: '3041',
          article_id: null,
          dimensions: {},
        },
      ],
    }

    function post(body?: unknown) {
      return POST(
        createMockRequest('/api/invoices/q-1/convert', { method: 'POST', body }),
        createMockRouteParams({ id: 'q-1' }),
      )
    }

    function enqueueHappyPath(conversions: unknown[]) {
      enqueue({ data: partQuote, error: null }) // fetch quote
      enqueue({ data: conversions, error: null }) // live conversions
      enqueue({ data: null, count: 0, error: null }) // no live sales order
      enqueue({ data: { id: 'inv-2', invoice_number: null, document_type: 'invoice' }, error: null }) // insert
      enqueue({ data: null, error: null }) // items
      enqueue({ data: [{ id: 'q-1' }], error: null }) // quote stays accepted
      enqueue({ data: 'F-007', error: null }) // number
      enqueue({ data: { id: 'inv-2', invoice_number: 'F-007', document_type: 'invoice', items: [] }, error: null })
    }

    it('rejects a body that is not JSON, or names both a percent and an amount, with 400', async () => {
      const bad = await POST(
        new Request('http://localhost:3000/api/invoices/q-1/convert', { method: 'POST', body: '{' }),
        createMockRouteParams({ id: 'q-1' }),
      )
      expect((await parseJsonResponse(bad)).status).toBe(400)

      for (const body of [{ percent: 50, amount: 100 }, { percent: 120 }, { amount: -5 }, { share: 50 }]) {
        const { status, body: res } = await parseJsonResponse<{ error: { code: string } }>(await post(body))
        expect(status).toBe(400)
        expect(res.error.code).toBe('VALIDATION_ERROR')
      }
      expect(findCall('invoices', 'select')).toBeUndefined()
    })

    it('refuses a part of a proforma: it converts in full', async () => {
      enqueue({ data: baseProforma, error: null })
      const response = await POST(
        createMockRequest('/api/invoices/pf-1/convert', { method: 'POST', body: { percent: 50 } }),
        createMockRouteParams({ id: 'pf-1' }),
      )
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
      expect(status).toBe(400)
      expect(body.error.code).toBe('INVOICE_CONVERT_PART_QUOTE_ONLY')
      expect(findCall('invoices', 'insert')).toBeUndefined()
    })

    it('bills 50 % of the quote: each line its share, VAT per line, a note naming the quote', async () => {
      enqueueHappyPath([])

      const { status, body } = await parseJsonResponse<{ data: { invoice_number: string } }>(await post({ percent: 50 }))

      expect(status).toBe(200)
      expect(body.data.invoice_number).toBe('F-007')
      const inserted = findCall('invoices', 'insert')?.[0] as Record<string, unknown>
      expect(inserted).toMatchObject({
        converted_from_id: 'q-1',
        subtotal: 12500,
        vat_amount: 3125,
        total: 15625,
        remaining_amount: 15625,
        subtotal_sek: 12500,
        total_sek: 15625,
      })
      expect(inserted.notes).toBe(
        'Delfakturering av offert OF-012: 12\u00a0500,00 av 25\u00a0000,00 SEK exkl. moms (50 %).\n\nTack för förtroendet',
      )
      const items = findCall('invoice_items', 'insert')?.[0] as Array<Record<string, unknown>>
      expect(items).toEqual([
        expect.objectContaining({
          invoice_id: 'inv-2',
          description: 'Webbprojekt, fast pris',
          quantity: 1,
          unit_price: 12500,
          line_total: 12500,
          vat_rate: 25,
          vat_amount: 3125,
          revenue_account: '3041',
        }),
      ])
    })

    it('bills what remains when called without a body after a part, and says what came before', async () => {
      enqueueHappyPath([
        {
          id: 'inv-1',
          status: 'sent',
          subtotal: 12500,
          items: [{ line_type: 'product', line_total: 12500, vat_rate: 25, revenue_account: '3041', article_id: null, dimensions: {} }],
        },
      ])

      const { status } = await parseJsonResponse(await post())

      expect(status).toBe(200)
      const inserted = findCall('invoices', 'insert')?.[0] as Record<string, unknown>
      expect(inserted).toMatchObject({ subtotal: 12500, vat_amount: 3125, total: 15625 })
      expect(String(inserted.notes)).toContain('Tidigare fakturerat: 12\u00a0500,00 SEK.')
    })

    it('refuses a part above what remains with 409 and the remaining amount', async () => {
      enqueue({ data: partQuote, error: null })
      enqueue({ data: [{ id: 'inv-1', status: 'sent', subtotal: 12500, items: [] }], error: null })

      const { status, body } = await parseJsonResponse<{ error: { code: string; details: Record<string, number> } }>(
        await post({ amount: 15000 }),
      )

      expect(status).toBe(409)
      expect(body.error.code).toBe('INVOICE_QUOTE_PART_OUT_OF_RANGE')
      expect(body.error.details).toMatchObject({ quote_subtotal: 25000, invoiced: 12500, remaining: 12500, requested: 15000 })
      expect(findCall('invoices', 'insert')).toBeUndefined()
    })

    it('maps the guard refusing a part that a concurrent conversion made too large', async () => {
      enqueue({ data: partQuote, error: null })
      enqueue({ data: [], error: null })
      enqueue({ data: null, count: 0, error: null })
      enqueue({
        data: null,
        error: { code: 'P0001', message: 'INVOICE_QUOTE_PART_OUT_OF_RANGE: invoice x would bill 12500 of quote q-1 with 0 left' },
      })

      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ percent: 50 }))

      expect(status).toBe(409)
      expect(body.error.code).toBe('INVOICE_QUOTE_PART_OUT_OF_RANGE')
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
    })
  })

  it('removes the orphan invoice and refuses when the proforma was cancelled concurrently (0-row compare-and-set)', async () => {
    // 1. fetch proforma
    enqueue({ data: baseProforma, error: null })
    // 2. insert real invoice
    enqueue({ data: { id: 'inv-1', invoice_number: null, document_type: 'invoice' }, error: null })
    // 3. insert items
    enqueue({ data: null, error: null })
    // 4. cancel proforma: a concurrent order conversion already cancelled it, 0 rows
    enqueue({ data: [], error: null })
    // 5. delete orphan invoice
    enqueue({ data: null, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/pf-1/convert', { method: 'POST' }),
      createMockRouteParams({ id: 'pf-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_CONVERT_SOURCE_CHANGED')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(findCalls('invoices', 'delete').length).toBe(1)
  })
})
