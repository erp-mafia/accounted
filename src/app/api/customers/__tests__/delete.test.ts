/**
 * DELETE /api/customers/[id] refuses while anything that needs the customer
 * points at it (crm#263).
 *
 * invoices.customer_id is ON DELETE SET NULL, so the database lets the delete
 * through and leaves the invoices without a buyer: a draft whose customer was
 * deleted could no longer be opened, sent or deleted in the UI. The route now
 * counts the dependents first and refuses with a code that says what to do.
 */
import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const mock = createTableMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { DELETE } from '../[id]/route'

const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const routeParams = { params: Promise.resolve({ id: CUSTOMER_ID }) }
const request = () => createMockRequest(`/api/customers/${CUSTOMER_ID}`, { method: 'DELETE' })

type ErrorBody = { error: { code: string; message: string; details?: { dependents?: Record<string, number> } } }

/** issued = left draft or numbered; drafts = unnumbered drafts. */
function dependents(counts: { issued?: number; drafts?: number; orders?: number; schedules?: number }) {
  mock.setTable('invoices', [{ count: counts.issued ?? 0 }, { count: counts.drafts ?? 0 }])
  mock.setTable('sales_orders', { count: counts.orders ?? 0 })
  mock.setTable('recurring_invoice_schedules', { count: counts.schedules ?? 0 })
}

describe('DELETE /api/customers/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated, before counting or deleting anything', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await DELETE(request(), routeParams)

    expect(response.status).toBe(401)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('refuses a customer with a draft invoice and tells the user to delete the draft first', async () => {
    dependents({ drafts: 1 })

    const response = await DELETE(request(), routeParams)
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('CUSTOMER_HAS_DRAFT_INVOICES')
    expect(body.error.message).toBe('Kunden har fakturautkast. Ta bort utkasten först, sedan kan kunden tas bort.')
    expect(body.error.details?.dependents).toMatchObject({ draft_invoices: 1, issued_invoices: 0 })
    expect(mock.findCall('customers', 'delete')).toBeUndefined()
  })

  it('refuses a customer with a sent invoice, which keeps the customer for good', async () => {
    dependents({ issued: 1, drafts: 2 })

    const response = await DELETE(request(), routeParams)
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('CUSTOMER_HAS_ISSUED_INVOICES')
    expect(body.error.message).toContain('sju år')
    expect(mock.findCall('customers', 'delete')).toBeUndefined()
  })

  it('refuses a customer with a sales order or a recurring invoice', async () => {
    dependents({ orders: 1 })
    let res = await parseJsonResponse<ErrorBody>(await DELETE(request(), routeParams))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CUSTOMER_HAS_SALES_ORDERS')

    dependents({ schedules: 1 })
    res = await parseJsonResponse<ErrorBody>(await DELETE(request(), routeParams))
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CUSTOMER_HAS_RECURRING_INVOICES')
    expect(mock.findCall('customers', 'delete')).toBeUndefined()
  })

  it('deletes a customer nothing points at', async () => {
    dependents({})
    mock.setTable('customers', { count: 1 })

    const response = await DELETE(request(), routeParams)
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(mock.findCall('customers', 'delete')).toEqual([{ count: 'exact' }])
    expect(mock.findCalls('customers', 'eq')).toEqual([
      ['id', CUSTOMER_ID],
      ['company_id', 'company-1'],
    ])
  })

  it('returns 404 when no customer of this company has the id', async () => {
    dependents({})
    mock.setTable('customers', { count: 0 })

    const response = await DELETE(request(), routeParams)
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('CUSTOMER_NOT_FOUND')
  })

  it('does not delete when the dependents cannot be counted', async () => {
    dependents({})
    mock.setTable('sales_orders', { error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    const response = await DELETE(request(), routeParams)

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(mock.findCall('customers', 'delete')).toBeUndefined()
  })
})
