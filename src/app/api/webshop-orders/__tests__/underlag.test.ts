import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

// Rendering and archiving behaviour lives in
// lib/webshop-orders/__tests__/order-underlag.test.ts; the retry's lookup in
// ensure-order-underlag.test.ts. Here: what each door answers.
const mockRender = vi.fn()
const mockArchive = vi.fn()
vi.mock('@/lib/webshop-orders/order-underlag', () => ({
  ORDER_UNDERLAG_FILENAME_PREFIX: 'Orderunderlag',
  renderWebshopOrderUnderlagPdf: (...args: unknown[]) => mockRender(...args),
  archiveWebshopOrderUnderlag: (...args: unknown[]) => mockArchive(...args),
}))

import { GET, POST } from '../[id]/underlag/route'

function makeOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    company_id: 'company-1',
    row_type: 'order',
    order_number: '1001',
    order_date: '2026-08-01',
    paid_date: '2026-08-01',
    currency: 'SEK',
    total: 500,
    total_tax: 100,
    total_sek: 500,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
    line_items: [],
    journal_entry_id: null,
    ...overrides,
  }
}

function getUnderlag(id = 'order-1') {
  const request = createMockRequest(`/api/webshop-orders/${id}/underlag`)
  return GET(request, createMockRouteParams({ id }))
}

function postUnderlag(id = 'order-1') {
  const request = createMockRequest(`/api/webshop-orders/${id}/underlag`, { method: 'POST' })
  return POST(request, createMockRouteParams({ id }))
}

const unauthenticated = () =>
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase: mockSupabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })

describe('GET /api/webshop-orders/[id]/underlag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase })
    mockRender.mockResolvedValue({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      filename: 'Orderunderlag_1001_2026-08-01.pdf',
    })
  })

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await getUnderlag()
    expect(res.status).toBe(401)
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('returns 404 when the company has no such order', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await getUnderlag())
    expect(status).toBe(404)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
    expect(findCalls('webshop_orders', 'eq')).toEqual(
      expect.arrayContaining([['id', 'order-1'], ['company_id', 'company-1']]),
    )
  })

  it('refuses a non-SEK order without a SEK conversion, like booking does', async () => {
    enqueue({ data: makeOrderRow({ currency: 'EUR', total_sek: null, exchange_rate: null }) })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await getUnderlag())
    expect(status).toBe(422)
    expect(body.error.code).toBe('WEBSHOP_ORDER_FX_UNRESOLVED')
    expect(mockRender).not.toHaveBeenCalled()
  })

  it('renders the PDF inline without storing anything', async () => {
    enqueue({ data: makeOrderRow() })
    const res = await getUnderlag()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline;/)
    expect(res.headers.get('Content-Disposition')).toContain('Orderunderlag_1001_2026-08-01.pdf')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(body)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d])
    expect(mockRender).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', order: expect.objectContaining({ id: 'order-1' }) }),
    )
    expect(mockArchive).not.toHaveBeenCalled()
    expect(findCalls('webshop_orders', 'update')).toEqual([])
  })

  it('answers a structured error when rendering fails', async () => {
    enqueue({ data: makeOrderRow() })
    mockRender.mockRejectedValueOnce(new Error('render broke'))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await getUnderlag())
    expect(status).toBe(500)
    expect(body.error.code).toBe('WEBSHOP_ORDER_UNDERLAG_FAILED')
  })
})

describe('POST /api/webshop-orders/[id]/underlag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    mockArchive.mockResolvedValue({ ok: true, documentId: 'doc-new' })
  })

  it('returns 401 when not authenticated', async () => {
    unauthenticated()
    const res = await postUnderlag()
    expect(res.status).toBe(401)
    expect(mockArchive).not.toHaveBeenCalled()
  })

  it('returns 403 for a viewer (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await postUnderlag()
    expect(res.status).toBe(403)
    expect(mockArchive).not.toHaveBeenCalled()
  })

  it('returns 404 when the company has no such order', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await postUnderlag())
    expect(status).toBe(404)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
  })

  it('returns 409 when the order is not booked', async () => {
    enqueue({ data: makeOrderRow() })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await postUnderlag())
    expect(status).toBe(409)
    expect(body.error.code).toBe('WEBSHOP_ORDER_NOT_BOOKED')
    expect(mockArchive).not.toHaveBeenCalled()
  })

  it('archives the orderunderlag on the booked verifikat when it is missing', async () => {
    enqueue({ data: makeOrderRow({ journal_entry_id: 'je-1' }) })
    enqueue({ data: [] }) // no orderunderlag on the verifikat yet
    const { status, body } = await parseJsonResponse<{
      data: { journal_entry_id: string; document_id: string; already_attached: boolean }
    }>(await postUnderlag())
    expect(status).toBe(200)
    expect(body.data).toEqual({ journal_entry_id: 'je-1', document_id: 'doc-new', already_attached: false })
    expect(mockArchive).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1', journalEntryId: 'je-1' }),
    )
  })

  it('answers already_attached without filing a second copy', async () => {
    enqueue({ data: makeOrderRow({ journal_entry_id: 'je-1' }) })
    enqueue({ data: [{ id: 'doc-old' }] })
    const { status, body } = await parseJsonResponse<{
      data: { document_id: string; already_attached: boolean }
    }>(await postUnderlag())
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ document_id: 'doc-old', already_attached: true })
    expect(mockArchive).not.toHaveBeenCalled()
  })

  it('answers a retryable structured error when the archive fails again', async () => {
    enqueue({ data: makeOrderRow({ journal_entry_id: 'je-1' }) })
    enqueue({ data: [] })
    mockArchive.mockResolvedValue({ ok: false, documentId: null })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await postUnderlag())
    expect(status).toBe(500)
    expect(body.error.code).toBe('WEBSHOP_ORDER_UNDERLAG_FAILED')
  })
})
