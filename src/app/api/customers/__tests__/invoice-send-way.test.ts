/**
 * Skickas som (customers.invoice_send_way) on the customer card's two verbs.
 *
 * One of the ways of the company's send order (peppol, kivra, billo, email),
 * or null for "follow the company's order". Anything else is a 400 before
 * the write; on PATCH null clears a stored way and an omitted field leaves it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const db = createTableMockSupabase()

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

import { POST } from '../route'
import { PATCH } from '../[id]/route'

const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const routeParams = { params: Promise.resolve({ id: CUSTOMER_ID }) }

function patch(body: Record<string, unknown>) {
  return PATCH(createMockRequest(`/api/customers/${CUSTOMER_ID}`, { method: 'PATCH', body }), routeParams)
}

function post(body: Record<string, unknown>) {
  return POST(
    createMockRequest('/api/customers', {
      method: 'POST',
      body: { name: 'Exempel AB', customer_type: 'swedish_business', ...body },
    }),
    { params: Promise.resolve({}) },
  )
}

const inserts = () => db.payloads('customers', 'insert') as Record<string, unknown>[]
const updates = () => db.payloads('customers', 'update') as Record<string, unknown>[]

describe('invoice_send_way on POST /api/customers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    db.reset()
    db.setTable('customers', { data: { id: CUSTOMER_ID, name: 'Exempel AB' } })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: db.supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: Response.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const { status } = await parseJsonResponse(await post({ invoice_send_way: 'peppol' }))

    expect(status).toBe(401)
    expect(inserts()).toHaveLength(0)
  })

  it('stores each way of the send order', async () => {
    for (const way of ['peppol', 'kivra', 'billo', 'email']) {
      const { status } = await parseJsonResponse(await post({ invoice_send_way: way }))
      expect(status).toBe(200)
      expect(inserts().at(-1)?.invoice_send_way).toBe(way)
    }
  })

  it('stores null, following the company order, when omitted or null', async () => {
    expect((await parseJsonResponse(await post({}))).status).toBe(200)
    expect(inserts().at(-1)?.invoice_send_way).toBeNull()

    expect((await parseJsonResponse(await post({ invoice_send_way: null }))).status).toBe(200)
    expect(inserts().at(-1)?.invoice_send_way).toBeNull()
  })

  it('rejects anything that is not a way with 400', async () => {
    for (const way of ['manual', 'post', 'Peppol', '']) {
      const { status } = await parseJsonResponse(await post({ invoice_send_way: way }))
      expect(status).toBe(400)
    }
    expect(inserts()).toHaveLength(0)
  })
})

describe('invoice_send_way on PATCH /api/customers/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    db.reset()
    db.setTable('customers', { data: { id: CUSTOMER_ID, customer_type: 'swedish_business', invoice_send_way: 'email' } })
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: db.supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 404 when the customer is not in the company', async () => {
    db.setTable('customers', { data: null, error: { code: 'PGRST116', message: 'not found' } })

    const { status } = await parseJsonResponse(await patch({ invoice_send_way: 'peppol' }))

    expect(status).toBe(404)
    expect(updates()).toHaveLength(0)
  })

  it('sets a way', async () => {
    const { status } = await parseJsonResponse(await patch({ invoice_send_way: 'peppol' }))

    expect(status).toBe(200)
    expect(updates()[0]).toMatchObject({ invoice_send_way: 'peppol' })
  })

  it('clears the way with null', async () => {
    const { status } = await parseJsonResponse(await patch({ invoice_send_way: null }))

    expect(status).toBe(200)
    expect(updates()[0]).toMatchObject({ invoice_send_way: null })
  })

  it('leaves the way untouched when the field is omitted', async () => {
    const { status } = await parseJsonResponse(await patch({ name: 'Nytt Namn AB' }))

    expect(status).toBe(200)
    expect(updates()[0]).not.toHaveProperty('invoice_send_way')
  })

  it('rejects anything that is not a way with 400', async () => {
    const { status } = await parseJsonResponse(await patch({ invoice_send_way: 'fax' }))

    expect(status).toBe(400)
    expect(updates()).toHaveLength(0)
  })
})
