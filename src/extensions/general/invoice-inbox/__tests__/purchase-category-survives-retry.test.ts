/**
 * "Tolka om" (POST /items/:id/retry-extraction) replaces the reading with a
 * fresh one; a person's purchase category and corrected fields on the old
 * reading are final and ride along (lib/documents/person-corrections.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse, testRoutes } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

vi.mock('@/lib/documents/inbox-extraction/extract-invoice-fields', () => ({
  extractInvoiceFields: vi.fn(),
  fetchOwnCompanyIdentity: vi.fn().mockResolvedValue({ orgNumber: null, name: null }),
}))
vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})
const serviceDownloadMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ storage: { from: vi.fn(() => ({ download: serviceDownloadMock })) } }),
}))

vi.mock('@/lib/documents/reading-correction', () => ({
  mirrorCorrectedReadingToDocument: vi.fn().mockResolvedValue('mirrored'),
}))

import { extractInvoiceFields } from '@/lib/documents/inbox-extraction/extract-invoice-fields'
import { mirrorCorrectedReadingToDocument } from '@/lib/documents/reading-correction'

const retryRoute = testRoutes(invoiceInboxExtension).find(
  (r) => r.method === 'POST' && r.path === '/items/:id/retry-extraction',
)!

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

const FRESH = {
  supplier: { name: 'Acme AB', orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null },
  invoice: { invoiceNumber: 'F-1', invoiceDate: '2026-05-01', dueDate: null, paymentReference: null, currency: 'SEK' },
  lineItems: [],
  totals: { subtotal: 100, vatAmount: 25, total: 125 },
  vatBreakdown: [],
  confidence: 1,
}
const CHOICE = { code: 'expense.equipment.tools', source: 'person', set_at: '2026-10-15T09:00:00.000Z', set_via: 'dashboard' }

beforeEach(() => vi.clearAllMocks())

describe('POST /items/:id/retry-extraction and the purchase category', () => {
  it('writes the fresh reading with the person\'s choice carried over', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'item-1',
        document_id: 'doc-1',
        correlation_id: null,
        created_supplier_invoice_id: null,
        extracted_data: { totals: { total: 1 }, purchaseCategory: CHOICE },
      },
      error: null,
    })
    enqueue({ data: { is_sandbox: false }, error: null }) // sandbox check
    enqueue({ data: { storage_path: 'p.pdf', mime_type: 'application/pdf', file_name: 'f.pdf' }, error: null })
    enqueue({ data: null, error: null }) // supplier name lookup: no match
    enqueue({ data: null, error: null }) // inbox update
    serviceDownloadMock.mockResolvedValue({ data: new Blob([new Uint8Array([1])], { type: 'application/pdf' }), error: null })
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({ data: FRESH, rawText: 'mock' } as never)

    const res = await retryRoute.handler(
      createMockRequest('/items/item-1/retry-extraction', { method: 'POST', searchParams: { _id: 'item-1' } }),
      buildCtx(supabase),
    )
    const { status, body } = await parseJsonResponse<{ data: { extracted_data: Record<string, unknown> } }>(res)
    expect(status).toBe(200)
    expect(findCall('invoice_inbox_items', 'select')?.[0]).toContain('extracted_data')
    const written = (findCall('invoice_inbox_items', 'update')?.[0] as { extracted_data: Record<string, unknown> }).extracted_data
    expect(written).toMatchObject({ totals: { total: 125 }, purchaseCategory: CHOICE })
    expect(body.data.extracted_data.purchaseCategory).toEqual(CHOICE)
  })

  it('keeps the fields a person corrected and mirrors them onto the document', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'item-1',
        document_id: 'doc-1',
        correlation_id: null,
        created_supplier_invoice_id: null,
        extracted_data: {
          ...FRESH,
          invoice: { ...FRESH.invoice, invoiceNumber: 'F-77' },
          totals: { subtotal: 100, vatAmount: 25, total: 120 },
          personFields: ['invoice.invoiceNumber', 'totals.total'],
        },
      },
      error: null,
    })
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: { storage_path: 'p.pdf', mime_type: 'application/pdf', file_name: 'f.pdf' }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    serviceDownloadMock.mockResolvedValue({ data: new Blob([new Uint8Array([1])], { type: 'application/pdf' }), error: null })
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({ data: FRESH, rawText: 'mock' } as never)

    const res = await retryRoute.handler(
      createMockRequest('/items/item-1/retry-extraction', { method: 'POST', searchParams: { _id: 'item-1' } }),
      buildCtx(supabase),
    )
    expect(res.status).toBe(200)
    const written = (findCall('invoice_inbox_items', 'update')?.[0] as { extracted_data: Record<string, unknown> }).extracted_data
    expect(written).toMatchObject({
      supplier: { name: 'Acme AB' },
      invoice: { invoiceNumber: 'F-77', invoiceDate: '2026-05-01' },
      totals: { total: 120 },
      totalSource: null,
      personFields: ['invoice.invoiceNumber', 'totals.total'],
    })
    expect(mirrorCorrectedReadingToDocument).toHaveBeenCalledWith({ documentId: 'doc-1', companyId: 'company-1', reading: written })
  })

  it('writes the fresh reading as it is when there was no choice', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'item-1', document_id: 'doc-1', correlation_id: null, created_supplier_invoice_id: null, extracted_data: null },
      error: null,
    })
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: { storage_path: 'p.pdf', mime_type: 'application/pdf', file_name: 'f.pdf' }, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    serviceDownloadMock.mockResolvedValue({ data: new Blob([new Uint8Array([1])], { type: 'application/pdf' }), error: null })
    vi.mocked(extractInvoiceFields).mockResolvedValueOnce({ data: FRESH, rawText: 'mock' } as never)

    await retryRoute.handler(
      createMockRequest('/items/item-1/retry-extraction', { method: 'POST', searchParams: { _id: 'item-1' } }),
      buildCtx(supabase),
    )
    const written = (findCall('invoice_inbox_items', 'update')?.[0] as { extracted_data: Record<string, unknown> }).extracted_data
    expect(written).not.toHaveProperty('purchaseCategory')
    expect(written).not.toHaveProperty('personFields')
    expect(mirrorCorrectedReadingToDocument).not.toHaveBeenCalled()
  })
})
