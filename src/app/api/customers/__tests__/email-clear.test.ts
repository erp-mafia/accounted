/**
 * Clearing a customer's email on PATCH /api/customers/[id].
 *
 * The edit dialog marks email optional, so emptying the field is a clear. The
 * update schema used to accept only a valid address, and the form dropped the
 * empty value to avoid the 400: the save reported success and kept the old
 * address. Empty string and null now both clear the column to null.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const captured: { update: unknown[] } = { update: [] }
let queryResult: { data: unknown; error: unknown } = { data: null, error: null }

const buildChain = (): unknown =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(queryResult)
        }
        return (...args: unknown[]) => {
          if (prop === 'update') captured.update.push(args[0])
          return buildChain()
        }
      },
    },
  )

const supabase = {
  from: vi.fn(() => buildChain()),
  rpc: vi.fn(() => buildChain()),
}

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

import { PATCH } from '../[id]/route'

const routeParams = { params: Promise.resolve({ id: 'cust-1' }) }

function patch(body: Record<string, unknown>) {
  return PATCH(createMockRequest('/api/customers/cust-1', { method: 'PATCH', body }), routeParams)
}

describe('email on PATCH /api/customers/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    captured.update.length = 0
    queryResult = {
      data: { id: 'cust-1', customer_type: 'swedish_business', email: 'billing@example.test' },
      error: null,
    }
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await parseJsonResponse(await patch({ email: '' }))

    expect(status).toBe(401)
    expect(captured.update).toHaveLength(0)
  })

  it('returns 404 when the customer is not in the company', async () => {
    queryResult = { data: null, error: { code: 'PGRST116', message: 'not found' } }

    const { status } = await parseJsonResponse(await patch({ email: '' }))

    expect(status).toBe(404)
    expect(captured.update).toHaveLength(0)
  })

  it('clears the email when an empty string is sent', async () => {
    const { status } = await parseJsonResponse(await patch({ name: 'Test AB', email: '' }))

    expect(status).toBe(200)
    expect(captured.update[0]).toMatchObject({ email: null })
  })

  it('clears the email when a whitespace-only string is sent', async () => {
    const { status } = await parseJsonResponse(await patch({ email: '   ' }))

    expect(status).toBe(200)
    expect(captured.update[0]).toMatchObject({ email: null })
  })

  it('clears the email when null is sent', async () => {
    const { status } = await parseJsonResponse(await patch({ email: null }))

    expect(status).toBe(200)
    expect(captured.update[0]).toMatchObject({ email: null })
  })

  it('updates the email to a new address', async () => {
    const { status } = await parseJsonResponse(await patch({ email: 'invoices@example.test' }))

    expect(status).toBe(200)
    expect(captured.update[0]).toMatchObject({ email: 'invoices@example.test' })
  })

  it('leaves the email untouched when the field is omitted', async () => {
    const { status } = await parseJsonResponse(await patch({ name: 'New Name AB' }))

    expect(status).toBe(200)
    expect(captured.update[0]).not.toHaveProperty('email')
  })

  it('rejects a malformed email with 400', async () => {
    const { status } = await parseJsonResponse(await patch({ email: 'not-an-email' }))

    expect(status).toBe(400)
    expect(captured.update).toHaveLength(0)
  })
})
