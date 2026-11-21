/**
 * PUT /items/:id/purchase-category: a person says what an underlag bought.
 * Rules are lib/documents/inbox-purchase-category.ts (tested there); this
 * pins the door: the id, the body, the failures and the answer. Session auth
 * is the /api/extensions/ext dispatcher's (withRouteContext), not the route's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const route = invoiceInboxExtension.apiRoutes!.find(
  (r) => r.method === 'PUT' && r.path === '/items/:id/purchase-category',
)!
const detailRoute = invoiceInboxExtension.apiRoutes!.find((r) => r.method === 'GET' && r.path === '/items/:id')!

const ITEM = '22222222-2222-4222-8222-222222222222'

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

const put = (body: unknown, id: string | null = ITEM) =>
  createMockRequest(`/items/${id}/purchase-category`, {
    method: 'PUT',
    ...(id ? { searchParams: { _id: id } } : {}),
    body,
  })

const READING = { supplier: { name: null }, invoice: { currency: 'SEK' }, lineItems: [], totals: { total: 1 } }

beforeEach(() => vi.clearAllMocks())

describe('PUT /items/:id/purchase-category', () => {
  it('asks the dispatcher to refuse viewers', () => {
    expect('requireWrite' in route && route.requireWrite).toBe(true)
  })

  it('400 without an id', async () => {
    const mock = createQueuedMockSupabase()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route.handler(put({ code: 'expense.equipment.hardware' }, null), buildCtx(mock.supabase)),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('400 for a code outside the taxonomy, or no body, reading nothing', async () => {
    const mock = createQueuedMockSupabase()
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
      await route.handler(put({ code: 'computers' }), buildCtx(mock.supabase)),
    )
    expect(status).toBe(400)
    expect(body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Några uppgifter stämmer inte. Kontrollera fälten och försök igen.' })
    expect((await route.handler(put({}), buildCtx(mock.supabase))).status).toBe(400)
    expect(mock.calls).toHaveLength(0)
  })

  it('404 when the item is not the company\'s', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route.handler(put({ code: 'expense.equipment.hardware' }), buildCtx(mock.supabase)),
    )
    expect(status).toBe(404)
    expect(body.error.code).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('409 once the item is a supplier invoice', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: ITEM, extracted_data: READING, created_supplier_invoice_id: 'si-1', updated_at: 't' } })
    const res = await route.handler(put({ code: 'expense.equipment.hardware' }), buildCtx(mock.supabase))
    expect(res.status).toBe(409)
  })

  it('stores the choice as the dashboard\'s and answers it', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: ITEM, extracted_data: READING, created_supplier_invoice_id: null, updated_at: 't' } })
    mock.enqueue({ data: { id: ITEM } })
    const { status, body } = await parseJsonResponse<{ data: { purchase_category: unknown } }>(
      await route.handler(put({ code: 'expense.equipment.hardware' }), buildCtx(mock.supabase)),
    )
    expect(status).toBe(200)
    expect(body.data.purchase_category).toEqual({ code: 'expense.equipment.hardware', source: 'person', level: 'Ditt val', version: 'pc-2026-10' })
    const update = mock.findCall('invoice_inbox_items', 'update')?.[0] as { extracted_data: { purchaseCategory: unknown } }
    expect(update.extracted_data.purchaseCategory).toMatchObject({ code: 'expense.equipment.hardware', source: 'person', set_via: 'dashboard' })
  })

  it('400 for an every_time that is not a boolean, reading nothing', async () => {
    const mock = createQueuedMockSupabase()
    expect((await route.handler(put({ code: 'expense.equipment.hardware', every_time: 'ja' }), buildCtx(mock.supabase))).status).toBe(400)
    expect(mock.calls).toHaveLength(0)
  })

  it('409 INBOX_ITEM_NO_SUPPLIER for every_time on an item without a matched supplier', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: ITEM, extracted_data: READING, matched_supplier_id: null, created_supplier_invoice_id: null, updated_at: 't' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await route.handler(put({ code: 'expense.equipment.hardware', every_time: true }), buildCtx(mock.supabase)),
    )
    expect(status).toBe(409)
    expect(body.error.code).toBe('INBOX_ITEM_NO_SUPPLIER')
  })

  it('every_time makes the choice the matched supplier\'s instruction', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: ITEM, extracted_data: READING, matched_supplier_id: 'sup-1', created_supplier_invoice_id: null, updated_at: 't' } })
    mock.enqueue({ data: { id: 'sup-1' } })
    mock.enqueue({ data: { id: ITEM } })
    const res = await route.handler(put({ code: 'expense.equipment.hardware', every_time: true }), buildCtx(mock.supabase))
    expect(res.status).toBe(200)
    expect(mock.findCall('suppliers', 'update')?.[0]).toEqual({ default_purchase_category: 'expense.equipment.hardware' })
  })
})

describe('GET /items/:id', () => {
  it('carries purchase_category beside the item', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: {
        id: ITEM,
        document_id: null,
        matched_transaction_id: null,
        created_journal_entry_id: null,
        created_supplier_invoice_id: null,
        extraction_skipped: false,
        extracted_data: { ...READING, purchaseCategory: { code: 'expense.travel.hotel', source: 'person', set_at: 't' } },
      },
    })
    const res = await detailRoute.handler(
      createMockRequest(`/items/${ITEM}`, { searchParams: { _id: ITEM } }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<{ data: { purchase_category: unknown; purchase_category_alternatives: unknown } }>(res)
    expect(status).toBe(200)
    expect(body.data.purchase_category).toMatchObject({ code: 'expense.travel.hotel', level: 'Ditt val' })
    // Nothing in this reading points anywhere else.
    expect(body.data.purchase_category_alternatives).toEqual([])
  })

  it('carries the alternatives the evidence points to when the proposal is ambiguous', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: {
        id: ITEM,
        document_id: null,
        matched_transaction_id: null,
        created_journal_entry_id: null,
        created_supplier_invoice_id: null,
        extraction_skipped: false,
        extracted_data: { ...READING, documentKind: 'receipt', merchantCategory: 'restaurant' },
      },
    })
    const res = await detailRoute.handler(
      createMockRequest(`/items/${ITEM}`, { searchParams: { _id: ITEM } }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<{ data: { purchase_category: unknown; purchase_category_alternatives: unknown } }>(res)
    expect(status).toBe(200)
    expect(body.data.purchase_category).toBeNull()
    expect(body.data.purchase_category_alternatives).toEqual([
      { code: 'expense.representation.client', source: 'merchant_category' },
      { code: 'expense.representation.staff', source: 'merchant_category' },
      { code: 'expense.travel.meals', source: 'merchant_category' },
    ])
  })
})
