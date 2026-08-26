/**
 * Correcting one field by hand must not cost the rest of the extraction.
 *
 * PATCH /items/:id/fields used to rebuild extracted_data from a hand-written
 * list of six keys. Everything outside that list was destroyed on the first
 * inline edit: documentKind, merchantCategory, legibility, purchaseTime,
 * payment and suggestedTemplateId. Nothing surfaced the loss, and the
 * classification cannot be recovered afterwards without re-running extraction.
 *
 * These tests pin the merge itself rather than the six names, so a field added
 * to InvoiceExtractionResult later is covered without anyone remembering to
 * come back here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { InvoiceExtractionResult } from '@/types'

const fieldsRoute = invoiceInboxExtension.apiRoutes!.find(
  (r) => r.method === 'PATCH' && r.path === '/items/:id/fields',
)!

function buildCtx(supabase: unknown): ExtensionContext {
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
  } as unknown as ExtensionContext
}

function makeReq(body: unknown) {
  return createMockRequest('/items/item-1/fields', {
    method: 'PATCH',
    searchParams: { _id: 'item-1' },
    body,
  })
}

/** A row the extractor filled in completely, classification and all. */
function fullExtraction(): InvoiceExtractionResult {
  return {
    documentKind: 'receipt',
    merchantCategory: 'restaurant',
    legibility: 'good',
    purchaseTime: '2026-07-14T19:12:00Z',
    payment: { method: 'card', cardLast4: '3667' },
    suggestedTemplateId: 'tmpl-representation',
    pages: { total: 1, analyzed: 1 },
    supplier: {
      name: 'Restaurang Riddaren AB',
      orgNumber: '556812-9930',
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
    },
    invoice: {
      invoiceNumber: '8841',
      invoiceDate: '2026-07-14',
      dueDate: null,
      paymentReference: null,
      currency: 'SEK',
    },
    lineItems: [
      {
        description: 'Restaurangnota',
        quantity: 1,
        unitPrice: 2264.15,
        lineTotal: 2264.15,
        vatRate: 6,
        accountSuggestion: null,
      },
    ],
    totals: { subtotal: 2264.15, vatAmount: 135.85, total: 2400 },
    vatBreakdown: [{ rate: 6, base: 2264.15, amount: 135.85 }],
    confidence: 0.91,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('PATCH /items/:id/fields', () => {
  it('keeps every field the edit did not mention', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: 'item-1', extracted_data: fullExtraction(), created_supplier_invoice_id: null } })
    mock.enqueue({ data: { id: 'item-1', extracted_data: {} } })

    const ctx = buildCtx(mock.supabase)
    // The smallest possible edit: one character of the supplier name.
    const res = await fieldsRoute.handler(makeReq({ supplier: { name: 'Restaurang Riddaren' } }), ctx)
    expect(res.status).toBe(200)

    const update = mock.calls.find((c) => c.method === 'update')
    const merged = (update?.args?.[0] as { extracted_data: Record<string, unknown> }).extracted_data

    // The classification the whole right pane reads: document type, the
    // konteringskarta hint, and the provenance of the payment.
    expect(merged.documentKind).toBe('receipt')
    expect(merged.suggestedTemplateId).toBe('tmpl-representation')
    expect(merged.merchantCategory).toBe('restaurant')
    expect(merged.legibility).toBe('good')
    expect(merged.purchaseTime).toBe('2026-07-14T19:12:00Z')
    expect(merged.payment).toEqual({ method: 'card', cardLast4: '3667' })
  })

  it('loses nothing that was on the row before the edit', async () => {
    // Pinned structurally: a field added to the extraction type tomorrow is
    // covered without anyone editing this file.
    const before = fullExtraction()
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: 'item-1', extracted_data: before, created_supplier_invoice_id: null } })
    mock.enqueue({ data: { id: 'item-1', extracted_data: {} } })

    const ctx = buildCtx(mock.supabase)
    await fieldsRoute.handler(makeReq({ totals: { total: 2500 } }), ctx)

    const update = mock.calls.find((c) => c.method === 'update')
    const merged = (update?.args?.[0] as { extracted_data: Record<string, unknown> }).extracted_data
    for (const key of Object.keys(before)) {
      expect(merged, `\`${key}\` was dropped by the merge`).toHaveProperty(key)
    }
  })

  it('still applies the edit it was given', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: 'item-1', extracted_data: fullExtraction(), created_supplier_invoice_id: null } })
    mock.enqueue({ data: { id: 'item-1', extracted_data: {} } })

    const ctx = buildCtx(mock.supabase)
    await fieldsRoute.handler(makeReq({ totals: { total: 2500 } }), ctx)

    const update = mock.calls.find((c) => c.method === 'update')
    const merged = (update?.args?.[0] as { extracted_data: InvoiceExtractionResult }).extracted_data
    expect(merged.totals?.total).toBe(2500)
    // A partial edit to one sub-object leaves its siblings intact.
    expect(merged.totals?.vatAmount).toBe(135.85)
    expect(merged.supplier?.name).toBe('Restaurang Riddaren AB')
  })

  it('refuses once the item became a supplier invoice', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: { id: 'item-1', extracted_data: fullExtraction(), created_supplier_invoice_id: 'si-1' },
    })
    const ctx = buildCtx(mock.supabase)
    const res = await fieldsRoute.handler(makeReq({ totals: { total: 2500 } }), ctx)
    expect(res.status).toBe(409)
    const { body } = await parseJsonResponse<{ error: string }>(res)
    expect(body.error).toContain('leverantörsfaktura')
  })
})
