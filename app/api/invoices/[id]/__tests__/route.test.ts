import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeCustomer,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { DELETE, PATCH } from '../route'

describe('DELETE /api/invoices/[id]', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(401)
    expect(body.error).toBe('Unauthorized')
  })

  it('returns 404 when invoice not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('rejects cancellation of a non-draft invoice with INVOICE_DELETE_NOT_DRAFT', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'sent', invoice_number: 'F-2026099', user_id: 'user-1' },
      error: null,
    })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_DELETE_NOT_DRAFT')
  })

  it('cancels a numbered draft, retaining the F-series number', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: 'F-2026001', user_id: 'user-1' },
      error: null,
    })
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{
      data: { cancelled: boolean; invoice_number: string | null }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.cancelled).toBe(true)
    expect(body.data.invoice_number).toBe('F-2026001')
  })

  it('hard deletes an un-numbered draft (saved via "Spara som utkast") and emits an audit event', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: null, user_id: 'user-1' },
      error: null,
    })
    // delete().select('id') returns the removed row
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ data: { deleted: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.deleted).toBe(true)
    // The hard delete leaves no journal trace, so an audit event must record it.
    expect(emitSpy).toHaveBeenCalledWith({
      type: 'invoice.draft_deleted',
      payload: { invoiceId: 'inv-1', companyId: 'company-1', userId: 'user-1' },
    })
  })

  it('returns 409 INVOICE_CANCEL_RACE when an un-numbered draft is finalized concurrently', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: null, user_id: 'user-1' },
      error: null,
    })
    // delete matched 0 rows: the draft was finalized (numbered) in the meantime.
    enqueue({ data: [], error: null })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_CANCEL_RACE')
  })

  it('returns 409 INVOICE_CANCEL_RACE when status flipped between fetch and update', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: 'F-2026001', user_id: 'user-1' },
      error: null,
    })
    // Update succeeds with no error but matches 0 rows because the .eq('status','draft')
    // guard rejected the row (concurrent send/cancel flipped status in the meantime).
    enqueue({ data: [], error: null })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_CANCEL_RACE')
  })

  it('returns 500 when the cancel update fails', async () => {
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: 'F-2026001', user_id: 'user-1' },
      error: null,
    })
    enqueue({ data: null, error: { message: 'cancel update failed' } })

    const response = await DELETE(
      createMockRequest('/api/invoices/inv-1', { method: 'DELETE' }),
      createMockRouteParams({ id: 'inv-1' })
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(500)
  })
})

describe('PATCH /api/invoices/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@test.se' } },
    })
  })

  it('rejects editing a credit-note draft', async () => {
    enqueue({
      data: {
        id: 'credit-1',
        status: 'draft',
        invoice_number: 'KR-F-2026001',
        journal_entry_id: null,
        is_self_billed: false,
        credited_invoice_id: '11111111-1111-4111-8111-111111111111',
      },
      error: null,
    })

    const response = await PATCH(
      createMockRequest('/api/invoices/credit-1', {
        method: 'PATCH',
        body: {
          customer_id: '22222222-2222-4222-8222-222222222222',
          invoice_date: '2026-07-14',
          due_date: '2026-07-14',
          currency: 'SEK',
          items: [
            {
              description: 'Kredit',
              quantity: 1,
              unit: 'st',
              unit_price: 100,
            },
          ],
        },
      }),
      createMockRouteParams({ id: 'credit-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
  })

  it('refuses an article id that belongs to another company before writing anything (issue #2059)', async () => {
    // The FK on invoice_items.article_id proves the article exists, not that
    // it is this company's; the cookie route relies on the builder's scoped
    // select for that (RLS never sees FK validation).
    const FOREIGN_ARTICLE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    enqueue({
      data: {
        id: 'inv-1',
        status: 'draft',
        invoice_number: null,
        journal_entry_id: null,
        is_self_billed: false,
        credited_invoice_id: null,
        document_type: 'invoice',
        quote_status: null,
        deduction_personnummer_encrypted: null,
        deduction_personnummer_last4: null,
      },
      error: null,
    }) // invoices: the draft being edited
    enqueue({ data: makeCustomer({ id: '22222222-2222-4222-8222-222222222222', customer_type: 'swedish_business' }), error: null }) // customers
    enqueue({ data: { vat_registered: true }, error: null }) // company_settings (builder VAT gate)
    enqueue({ data: [], error: null }) // articles: no company-scoped hit

    const response = await PATCH(
      createMockRequest('/api/invoices/inv-1', {
        method: 'PATCH',
        body: {
          customer_id: '22222222-2222-4222-8222-222222222222',
          invoice_date: '2026-07-14',
          due_date: '2026-08-13',
          currency: 'SEK',
          items: [
            {
              description: 'Konsult',
              quantity: 1,
              unit: 'tim',
              unit_price: 1000,
              vat_rate: 25,
              article_id: FOREIGN_ARTICLE,
            },
          ],
        },
      }),
      createMockRouteParams({ id: 'inv-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; details?: { invalidArticleIds?: string[] } } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_CREATE_ARTICLE_INVALID')
    expect(findCall('articles', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('invoices', 'update')).toBeUndefined()
    expect(findCall('invoice_items', 'insert')).toBeUndefined()
  })
})
