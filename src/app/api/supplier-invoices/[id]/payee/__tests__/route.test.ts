import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))

const readInvoicePayee = vi.fn()
const decideSupplierPayee = vi.fn()
vi.mock('@/lib/payments/payee-alerts', () => ({
  readInvoicePayee: (...args: unknown[]) => readInvoicePayee(...args),
  decideSupplierPayee: (...args: unknown[]) => decideSupplierPayee(...args),
}))

import { GET, POST } from '../route'

const ID = '6f1c2a40-0000-4000-8000-000000000001'
const VIEW = {
  supplier_invoice_id: ID,
  supplier_id: 'sup-1',
  supplier_name: 'Derome Bygg AB',
  kind: 'changed',
  alert: 'changed',
  decision: null,
  hold: 'payee_unconfirmed',
  old_payee: 'BG 5050-1055',
  new_payee: 'BG 9020-0007',
  new_payee_key: 'bankgiro:90200007',
  last_decision: null,
  payable: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
})

const get = (id = ID) => GET(createMockRequest(`/api/supplier-invoices/${id}/payee`), createMockRouteParams({ id }))
const post = (body: unknown, id = ID) =>
  POST(createMockRequest(`/api/supplier-invoices/${id}/payee`, { method: 'POST', body }), createMockRouteParams({ id }))

describe('GET /api/supplier-invoices/:id/payee', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await get()).status).toBe(401)
    expect(readInvoicePayee).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown invoice, and for an id that is no uuid without asking the database', async () => {
    readInvoicePayee.mockResolvedValue({ ok: false, code: 'SI_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await get())
    expect(status).toBe(404)
    expect(body.error.code).toBe('SI_NOT_FOUND')
    readInvoicePayee.mockClear()
    expect((await get('not-a-uuid')).status).toBe(404)
    expect(readInvoicePayee).not.toHaveBeenCalled()
  })

  it('answers the view for the active company', async () => {
    readInvoicePayee.mockResolvedValue({ ok: true, view: VIEW })
    const { status, body } = await parseJsonResponse<{ data: typeof VIEW }>(await get())
    expect(status).toBe(200)
    expect(body.data).toEqual(VIEW)
    expect(readInvoicePayee).toHaveBeenCalledWith(mockSupabase, 'company-1', ID)
  })
})

describe('POST /api/supplier-invoices/:id/payee', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post({ decision: 'confirmed' })).status).toBe(401)
    expect(decideSupplierPayee).not.toHaveBeenCalled()
  })

  it('returns 400 for a decision it does not know', async () => {
    expect((await post({ decision: 'maybe' })).status).toBe(400)
    expect((await post({ decision: 'confirmed', update_supplier_card: 'yes' })).status).toBe(400)
    expect(decideSupplierPayee).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown invoice and 409 when there is nothing to decide', async () => {
    decideSupplierPayee.mockResolvedValueOnce({ ok: false, code: 'SI_NOT_FOUND' })
    expect((await post({ decision: 'confirmed' })).status).toBe(404)
    decideSupplierPayee.mockResolvedValueOnce({ ok: false, code: 'SUPPLIER_PAYEE_NOTHING_TO_DECIDE' })
    expect((await post({ decision: 'rejected' })).status).toBe(409)
  })

  it('refuses a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await post({ decision: 'confirmed' })).status).toBe(403)
    expect(decideSupplierPayee).not.toHaveBeenCalled()
  })

  it('records the person\'s decision', async () => {
    decideSupplierPayee.mockResolvedValue({
      ok: true,
      data: { supplier_invoice_id: ID, supplier_id: 'sup-1', decision: 'confirmed', payee: 'BG 9020-0007', supplier_card_updated: false },
    })
    const { status, body } = await parseJsonResponse<{ data: { decision: string } }>(
      await post({ decision: 'confirmed', update_supplier_card: false, note: 'ringde' }),
    )
    expect(status).toBe(200)
    expect(body.data.decision).toBe('confirmed')
    expect(decideSupplierPayee).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      { supplierInvoiceId: ID, decision: 'confirmed', updateSupplierCard: false, note: 'ringde' },
    )
  })
})
