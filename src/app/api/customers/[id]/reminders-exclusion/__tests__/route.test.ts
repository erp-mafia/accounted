import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, setTable, payloads, findCalls, reset } = createTableMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { PATCH } from '../route'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const patch = (body: unknown, id = CUSTOMER_ID) =>
  PATCH(createMockRequest(`/api/customers/${id}/reminders-exclusion`, { method: 'PATCH', body }), createMockRouteParams({ id }))

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('PATCH /api/customers/[id]/reminders-exclusion', () => {
  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await patch({ excluded: true })).status).toBe(401)
  })

  it('returns 400 for a bad id or body', async () => {
    expect((await patch({ excluded: true }, 'nope')).status).toBe(400)
    expect((await patch({ excluded: 'yes' })).status).toBe(400)
  })

  it("returns 404 for another company's customer", async () => {
    setTable('customers', { data: null })
    expect((await patch({ excluded: true })).status).toBe(404)
  })

  it('marks the customer, in the active company only', async () => {
    setTable('customers', { data: { id: CUSTOMER_ID, reminders_excluded: true } })
    const res = await patch({ excluded: true })
    expect((await parseJsonResponse(res)).body).toEqual({ data: { id: CUSTOMER_ID, reminders_excluded: true } })
    expect(payloads('customers', 'update')).toEqual([{ reminders_excluded: true }])
    expect(findCalls('customers', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['id', CUSTOMER_ID],
    ])
  })
})
