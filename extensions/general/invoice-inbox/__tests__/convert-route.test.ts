import { describe, it, expect, vi } from 'vitest'
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
    // error envelope — only the server-authoritative `existing` row.
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
