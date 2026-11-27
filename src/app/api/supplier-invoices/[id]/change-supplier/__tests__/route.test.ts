/**
 * POST /api/supplier-invoices/[id]/change-supplier: the session door of Byt
 * leverantör. The rules are the service's (change-supplier.test.ts); here
 * only that the door authenticates, validates, scopes and answers them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: vi.fn().mockResolvedValue({ ok: true }) }))
const changeMock = vi.fn()
vi.mock('@/lib/supplier-invoices/change-supplier', () => ({
  changeSupplierInvoiceSupplier: (...args: unknown[]) => changeMock(...args),
}))

import { POST } from '../route'

const INVOICE = '3b4c5d6e-0000-4000-8000-000000000001'
const SUPPLIER = '7a8b9c0d-0000-4000-8000-000000000002'
const supabase = { from: vi.fn(), auth: { getUser: vi.fn() } }

const post = (body: unknown, id = INVOICE) =>
  POST(
    createMockRequest(`/api/supplier-invoices/${id}/change-supplier`, { method: 'POST', body }),
    createMockRouteParams({ id }),
  )

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('POST /api/supplier-invoices/[id]/change-supplier', () => {
  it('401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post({ supplier_id: SUPPLIER })).status).toBe(401)
    expect(changeMock).not.toHaveBeenCalled()
  })

  it('400 for a body without a supplier id', async () => {
    expect((await post({ supplier_id: 'acme' })).status).toBe(400)
    expect(changeMock).not.toHaveBeenCalled()
  })

  it('404 for an id that is no invoice id, before any read', async () => {
    const res = await post({ supplier_id: SUPPLIER }, 'not-a-uuid')
    expect(res.status).toBe(404)
    expect(changeMock).not.toHaveBeenCalled()
  })

  it('404 when the service finds no invoice in the company', async () => {
    changeMock.mockResolvedValue({ ok: false, code: 'SI_NOT_FOUND' })
    expect((await post({ supplier_id: SUPPLIER })).status).toBe(404)
  })

  it('moves the invoice in the active company as the person, and answers the result', async () => {
    const data = { supplier_invoice_id: INVOICE, supplier_id: SUPPLIER, previous_supplier_id: 'old', changed: true, corrected_journal_entry_id: 'je-1' }
    changeMock.mockResolvedValue({ ok: true, data })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(await post({ supplier_id: SUPPLIER }))
    expect(status).toBe(200)
    expect(body.data).toEqual(data)
    expect(changeMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), INVOICE, SUPPLIER)
  })

  it('answers a refusal with its status and code', async () => {
    changeMock.mockResolvedValue({ ok: false, code: 'SI_CHANGE_SUPPLIER_ATTESTED' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ supplier_id: SUPPLIER }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_CHANGE_SUPPLIER_ATTESTED')
  })
})
