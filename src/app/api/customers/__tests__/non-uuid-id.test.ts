/**
 * /api/customers/[id] answers 404 for an id that is not a UUID.
 *
 * There is no /customers/new page: the browser on that URL opened the
 * customer card with id "new", which fetched /api/customers/new, and Postgres
 * refused the uuid parse with a 500. No customer can have such an id, so it
 * is a 404 before any query, on every method of the route.
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

import { DELETE, GET, PATCH } from '../[id]/route'

type ErrorBody = { error: { code: string; message: string } }

const params = (id: string) => ({ params: Promise.resolve({ id }) })

const NON_UUIDS = ['new', 'undefined', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc-x']

describe('/api/customers/[id] with an id that is not a UUID', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('still returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest('/api/customers/new'), params('new'))

    expect(response.status).toBe(401)
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it.each(NON_UUIDS)('GET %s answers 404 CUSTOMER_NOT_FOUND without querying', async (id) => {
    const response = await GET(createMockRequest(`/api/customers/${id}`), params(id))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('CUSTOMER_NOT_FOUND')
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it.each(NON_UUIDS)('PATCH %s answers 404 CUSTOMER_NOT_FOUND without querying', async (id) => {
    const response = await PATCH(
      createMockRequest(`/api/customers/${id}`, { method: 'PATCH', body: { name: 'Kund AB' } }),
      params(id),
    )
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('CUSTOMER_NOT_FOUND')
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it.each(NON_UUIDS)('DELETE %s answers 404 CUSTOMER_NOT_FOUND without counting or deleting', async (id) => {
    const response = await DELETE(createMockRequest(`/api/customers/${id}`, { method: 'DELETE' }), params(id))
    const { status, body } = await parseJsonResponse<ErrorBody>(response)

    expect(status).toBe(404)
    expect(body.error.code).toBe('CUSTOMER_NOT_FOUND')
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('a UUID id still reaches the query', async () => {
    mock.setTable('customers', { data: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Kund AB' } })
    mock.setTable('invoices', { data: [] })

    const response = await GET(
      createMockRequest('/api/customers/cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      params('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    )

    expect(response.status).toBe(200)
    expect(mock.supabase.from).toHaveBeenCalledWith('customers')
  })
})
