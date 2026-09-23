import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  makeInvoiceInboxItem,
  makeSupplier,
  makeCompanySettings,
} from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
}))

// Riksbanken backs the server-side rate lookup the convert route now performs.
// Spread the real module so nothing else importing from it breaks.
const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return { ...actual, fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args) }
})

// ── Helpers ──────────────────────────────────────────────────

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path
  )!
}

function buildCtx(supabase: unknown, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
    ...overrides,
  } as ExtensionContext
}

const SUPPLIER_UUID = '00000000-0000-4000-8000-000000000001'

const VALID_CONVERT_BODY = {
  supplier_id: SUPPLIER_UUID,
  supplier_invoice_number: 'F-2024-001',
  invoice_date: '2024-06-15',
  due_date: '2024-07-15',
  items: [
    { description: 'Konsulttjänster', amount: 10000, account_number: '6200', vat_rate: 0.25 },
  ],
}

// ── POST /items/:id/convert ──────────────────────────────────

describe('POST /items/:id/convert', () => {
  const route = findRoute('POST', '/items/:id/convert')

  it('returns 401 when no context', async () => {
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, undefined)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 404 when item not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'Not found' } })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 409 when item already linked to a supplier invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        status: 'received',
        created_supplier_invoice_id: 'existing-1',
      }),
    })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
  })

  it('returns 400 when required fields missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: { items: [] },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 when supplier not found in company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    enqueue({ data: null, error: { message: 'Not found' } })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 409 (not 500) when the supplier invoice number already exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    enqueue({ data: makeSupplier({ id: SUPPLIER_UUID }) })
    enqueue({ data: 42 })
    // Insert collides with idx_supplier_invoices_company_supplier_number.
    enqueue({
      data: null,
      error: {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "idx_supplier_invoices_company_supplier_number"',
      },
    })
    // Lookup of the existing (non-credited) invoice for the conflict payload.
    enqueue({
      data: { id: 'existing-1', supplier_invoice_number: 'F-2024-001', status: 'approved' },
    })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: Record<string, unknown> & { existing?: { id: string } } }
    }>(res)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_CREATE_DUPLICATE_INVOICE_NUMBER')
    expect(body.error.details?.existing?.id).toBe('existing-1')
    // Data minimisation: the raw request body must NOT be echoed back into the
    // error envelope: only the server-authoritative `existing` row.
    expect(body.error.details).not.toHaveProperty('supplierId')
    expect(body.error.details).not.toHaveProperty('supplierInvoiceNumber')
  })

  it('successfully converts inbox item to supplier invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inboxItem = makeInvoiceInboxItem({ status: 'received', document_id: 'doc-1' })
    const supplier = makeSupplier({ id: 'supplier-1' })
    const createdInvoice = {
      id: 'invoice-1',
      user_id: 'user-1',
      company_id: 'company-1',
      supplier_id: SUPPLIER_UUID,
      arrival_number: 42,
      supplier_invoice_number: 'F-2024-001',
      total: 12500,
      status: 'registered',
    }

    enqueue({ data: inboxItem })
    enqueue({ data: supplier })
    enqueue({ data: 42 })
    enqueue({ data: createdInvoice })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) })
    enqueue({ data: null, error: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse<{ data: { id: string; inbox_item_id: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('invoice-1')
    expect(body.data.inbox_item_id).toBe('item-1')
  })

  it('defaults the supplier invoice notes to the rendered WhatsApp channel context', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        status: 'received',
        document_id: 'doc-1',
        source: 'whatsapp',
        channel_context: { channel: 'whatsapp', user_note: 'Serverlicens för Q3' },
      }),
    })
    enqueue({ data: makeSupplier({ id: 'supplier-1' }) })
    enqueue({ data: 42 })
    enqueue({ data: { id: 'invoice-1', status: 'registered' } })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) })
    enqueue({ data: null, error: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY, // no notes field
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const insertArgs = findCall('supplier_invoices', 'insert')
    expect(insertArgs?.[0]).toMatchObject({ notes: 'Serverlicens för Q3' })
  })

  // Same rule as book-direct: an explicit '' is the caller clearing the field,
  // not "no opinion", so the chat context must not be written back in.
  it('honors an explicitly cleared notes field on convert', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        status: 'received',
        source: 'whatsapp',
        channel_context: { channel: 'whatsapp', user_note: 'Från chatten' },
      }),
    })
    enqueue({ data: makeSupplier({ id: 'supplier-1' }) })
    enqueue({ data: 42 })
    enqueue({ data: { id: 'invoice-1', status: 'registered' } })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) })
    enqueue({ data: null, error: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: { ...VALID_CONVERT_BODY, notes: '' },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const insertArgs = findCall('supplier_invoices', 'insert')
    expect(insertArgs?.[0]).toMatchObject({ notes: null })
  })

  // The convert form never shows the chat context, so an unreviewed photo
  // caption must not ride along onto the leverantörsfaktura either.
  it('never defaults an unreviewed caption onto the supplier invoice', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        status: 'received',
        source: 'whatsapp',
        channel_context: { channel: 'whatsapp', caption: 'lunch med Anna, hon bjöd tillbaka' },
      }),
    })
    enqueue({ data: makeSupplier({ id: 'supplier-1' }) })
    enqueue({ data: 42 })
    enqueue({ data: { id: 'invoice-1', status: 'registered' } })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) })
    enqueue({ data: null, error: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY, // no notes field
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const insertArgs = findCall('supplier_invoices', 'insert')
    expect(insertArgs?.[0]).toMatchObject({ notes: null })
  })

  it('keeps caller-supplied notes over the channel context on convert', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: makeInvoiceInboxItem({
        status: 'received',
        source: 'whatsapp',
        channel_context: { channel: 'whatsapp', user_note: 'Från chatten' },
      }),
    })
    enqueue({ data: makeSupplier({ id: 'supplier-1' }) })
    enqueue({ data: 42 })
    enqueue({ data: { id: 'invoice-1', status: 'registered' } })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) })
    enqueue({ data: null, error: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: { ...VALID_CONVERT_BODY, notes: 'Egen anteckning' },
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const insertArgs = findCall('supplier_invoices', 'insert')
    expect(insertArgs?.[0]).toMatchObject({ notes: 'Egen anteckning' })
  })

  it('emits supplier_invoice.registered and supplier_invoice.confirmed events', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    enqueue({ data: makeSupplier({ id: SUPPLIER_UUID }) })
    enqueue({ data: 42 })
    enqueue({ data: { id: 'invoice-1', status: 'registered' } })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) })
    enqueue({ data: null, error: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    await route.handler(request, ctx)

    const emitCalls = (ctx.emit as ReturnType<typeof vi.fn>).mock.calls
    expect(emitCalls.length).toBe(2)
    expect(emitCalls[0][0].type).toBe('supplier_invoice.registered')
    expect(emitCalls[1][0].type).toBe('supplier_invoice.confirmed')
  })

  it('creates registration journal entry when accounting method is accrual', async () => {
    const { createSupplierInvoiceRegistrationEntry } = await import('@/lib/bookkeeping/supplier-invoice-entries')

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    enqueue({ data: makeSupplier({ id: SUPPLIER_UUID }) })
    enqueue({ data: 42 })
    enqueue({ data: { id: 'invoice-1', status: 'registered' } })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompanySettings({ accounting_method: 'accrual' }) })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse<{ data: { registration_journal_entry_id: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.registration_journal_entry_id).toBe('je-1')
    expect(createSupplierInvoiceRegistrationEntry).toHaveBeenCalled()
  })
})

// ── Exchange rate + SEK amounts on convert ───────────────────
// The queued Supabase mock is a bare Proxy, so the insert payload has to be
// recorded to be asserted: the route echoes back the enqueued fixture row.

type InsertRecord = { table: string; payload: Record<string, unknown> }

function wrapCapturing(chain: unknown, table: string, sink: InsertRecord[]): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const inner = (chain as Record<string | symbol, unknown>)[prop as string]
        if (prop === 'then') return inner
        return (...args: unknown[]) => {
          if (
            prop === 'insert' &&
            args[0] &&
            typeof args[0] === 'object' &&
            !Array.isArray(args[0])
          ) {
            sink.push({ table, payload: args[0] as Record<string, unknown> })
          }
          return wrapCapturing((inner as (...a: unknown[]) => unknown)(...args), table, sink)
        }
      },
    },
  )
}

describe('POST /items/:id/convert: exchange rate + SEK amounts', () => {
  const route = findRoute('POST', '/items/:id/convert')

  beforeEach(() => {
    mockFetchExchangeRate.mockReset()
  })

  /**
   * Queued mock with insert capture, wired for the convert happy path:
   * inbox item → supplier → arrival number → invoice insert → items insert →
   * company_settings → inbox-item update.
   */
  function setup() {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const captured: InsertRecord[] = []
    const baseFrom = supabase.from.getMockImplementation() as (...a: unknown[]) => unknown
    supabase.from.mockImplementation((table: string) =>
      wrapCapturing(baseFrom(table), table, captured),
    )
    return { supabase, enqueue, captured }
  }

  function enqueueHappyPath(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
    enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    enqueue({ data: makeSupplier({ id: SUPPLIER_UUID }) })
    enqueue({ data: 42 })
    enqueue({ data: { id: 'invoice-fx', status: 'registered' } })
    enqueue({ data: [], error: null })
    enqueue({ data: makeCompanySettings({ accounting_method: 'cash' }) })
    enqueue({ data: null, error: null })
  }

  function request(overrides: Record<string, unknown> = {}) {
    return createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: { ...VALID_CONVERT_BODY, ...overrides },
      searchParams: { _id: 'item-1' },
    })
  }

  const siInsert = (captured: InsertRecord[]) =>
    captured.find((c) => c.table === 'supplier_invoices')?.payload

  it('populates total_sek for a SEK invoice and never asks for a rate', async () => {
    const { supabase, enqueue, captured } = setup()
    enqueueHappyPath(enqueue)

    const res = await route.handler(request(), buildCtx(supabase))
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const payload = siInsert(captured)
    expect(payload).toBeDefined()
    // 10 000 + 25 % = 12 500. total_sek used to stay NULL because the writer
    // gated it on an exchange rate, which a SEK invoice never has.
    expect(payload!.subtotal_sek).toBe(10000)
    expect(payload!.vat_amount_sek).toBe(2500)
    expect(payload!.total_sek).toBe(12500)
    expect(payload!.total_sek).toBe(payload!.total)
    expect(payload!.exchange_rate).toBeNull()
    expect(payload!.exchange_rate_date).toBeNull()
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('honours a caller-supplied rate on a foreign invoice', async () => {
    const { supabase, enqueue, captured } = setup()
    enqueueHappyPath(enqueue)

    const res = await route.handler(
      request({ currency: 'EUR', exchange_rate: 11.5 }),
      buildCtx(supabase),
    )
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const payload = siInsert(captured)
    expect(payload!.currency).toBe('EUR')
    expect(payload!.exchange_rate).toBe(11.5)
    expect(payload!.total_sek).toBe(143750)
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  it('fetches the invoice-date rate when the extracted invoice carries none', async () => {
    const { supabase, enqueue, captured } = setup()
    enqueueHappyPath(enqueue)
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11.2, date: '2024-06-14' })

    const res = await route.handler(request({ currency: 'EUR' }), buildCtx(supabase))
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(mockFetchExchangeRate).toHaveBeenCalledTimes(1)
    const [currencyArg, dateArg, clientArg] = mockFetchExchangeRate.mock.calls[0]
    expect(currencyArg).toBe('EUR')
    expect((dateArg as Date).toISOString().slice(0, 10)).toBe('2024-06-15')
    // The supabase client must reach fetchExchangeRate or the shared
    // exchange_rates cache is never consulted.
    expect(clientArg).toBe(supabase)

    const payload = siInsert(captured)
    expect(payload!.exchange_rate).toBe(11.2)
    expect(payload!.exchange_rate_date).toBe('2024-06-14')
    expect(payload!.total_sek).toBe(140000)
  })

  it('refuses the conversion with SI_FX_RATE_MISSING when no rate can be resolved', async () => {
    const { supabase, enqueue, captured } = setup()
    enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    enqueue({ data: makeSupplier({ id: SUPPLIER_UUID }) })
    mockFetchExchangeRate.mockResolvedValue(null)

    const res = await route.handler(request({ currency: 'USD' }), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { currency?: string } }
    }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_FX_RATE_MISSING')
    expect(body.error.details?.currency).toBe('USD')
    // Nothing written, no ankomstnummer burned: the inbox item stays
    // convertible once a rate is available or typed in.
    expect(siInsert(captured)).toBeUndefined()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

// ── DELETE /items/:id ────────────────────────────────────────

describe('DELETE /items/:id', () => {
  const route = findRoute('DELETE', '/items/:id')

  it('returns 401 when no context', async () => {
    const request = createMockRequest('/items/item-1', {
      method: 'DELETE',
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, undefined)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 404 when item not found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1', {
      method: 'DELETE',
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(404)
  })

  it('returns 409 when item is linked to a supplier invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'item-1', created_supplier_invoice_id: 'inv-1' } })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1', {
      method: 'DELETE',
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(409)
  })

  it('deletes a free-standing inbox item', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'item-1', created_supplier_invoice_id: null } })
    enqueue({ data: null, error: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1', {
      method: 'DELETE',
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse<{ data: { deleted: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.deleted).toBe(true)
  })
})

describe('POST /items/:id/convert honours defer_invoice_booking (#967)', () => {
  const route = findRoute('POST', '/items/:id/convert')

  it('registers WITHOUT the registration JE when the company defers booking', async () => {
    const { createSupplierInvoiceRegistrationEntry } = await import('@/lib/bookkeeping/supplier-invoice-entries')
    vi.mocked(createSupplierInvoiceRegistrationEntry).mockClear()

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeInvoiceInboxItem({ status: 'received' }) })
    enqueue({ data: makeSupplier({ id: SUPPLIER_UUID }) })
    enqueue({ data: 42 })
    enqueue({ data: { id: 'invoice-1', status: 'registered' } })
    enqueue({ data: null, error: null })
    enqueue({ data: makeCompanySettings({ accounting_method: 'accrual', defer_invoice_booking: true }) })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })

    const ctx = buildCtx(supabase)
    const request = createMockRequest('/items/item-1/convert', {
      method: 'POST',
      body: VALID_CONVERT_BODY,
      searchParams: { _id: 'item-1' },
    })
    const res = await route.handler(request, ctx)
    const { status, body } = await parseJsonResponse<{ data: { registration_journal_entry_id: string | null } }>(res)

    expect(status).toBe(200)
    expect(body.data.registration_journal_entry_id).toBeNull()
    expect(createSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })
})
