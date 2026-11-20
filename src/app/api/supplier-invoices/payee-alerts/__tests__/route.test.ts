import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const listSupplierPayeeAlerts = vi.fn()
vi.mock('@/lib/payments/payee-alerts', () => ({ listSupplierPayeeAlerts: (...args: unknown[]) => listSupplierPayeeAlerts(...args) }))

import { GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
})

describe('GET /api/supplier-invoices/payee-alerts', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await GET(createMockRequest('/api/supplier-invoices/payee-alerts'), { params: Promise.resolve({}) })).status).toBe(401)
    expect(listSupplierPayeeAlerts).not.toHaveBeenCalled()
  })

  it('answers the markers only: invoice, alert and hold, never the accounts', async () => {
    listSupplierPayeeAlerts.mockResolvedValue([
      { supplier_invoice_id: 'inv-1', supplier_id: 'sup-1', alert: 'changed', hold: 'payee_unconfirmed', decision: null, old_payee: 'BG 5050-1055', new_payee: 'BG 9020-0007' },
    ])
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(await GET(createMockRequest('/api/supplier-invoices/payee-alerts'), { params: Promise.resolve({}) }))
    expect(status).toBe(200)
    expect(body.data).toEqual([{ supplier_invoice_id: 'inv-1', alert: 'changed', hold: 'payee_unconfirmed' }])
    expect(listSupplierPayeeAlerts).toHaveBeenCalledWith(mockSupabase, 'company-1')
  })
})
