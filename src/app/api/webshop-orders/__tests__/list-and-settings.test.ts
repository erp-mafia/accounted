import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } =
  createQueuedMockSupabase()

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

import { GET as listOrders } from '../route'
import { GET as getSettings, PUT as putSettings } from '../settings/route'

describe('GET /api/webshop-orders', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await listOrders(createMockRequest('/api/webshop-orders'))
    expect(response.status).toBe(401)
  })

  it('returns 400 on an invalid filter value', async () => {
    const response = await listOrders(
      createMockRequest('/api/webshop-orders?paid=maybe'),
    )
    expect(response.status).toBe(400)
  })

  it('lists rows with a deduped store facet', async () => {
    enqueue({
      data: [{ id: 'o1' }, { id: 'o2' }],
      count: 2,
    })
    enqueue({
      data: [
        { platform: 'woocommerce', store_scope: 'a.se', store_label: 'A' },
        { platform: 'woocommerce', store_scope: 'a.se', store_label: 'A' },
        { platform: 'woocommerce', store_scope: 'b.se', store_label: 'B' },
      ],
    })
    const { status, body } = await parseJsonResponse<{
      data: unknown[]
      count: number
      stores: Array<{ store_scope: string }>
    }>(await listOrders(createMockRequest('/api/webshop-orders?paid=paid&booked=unbooked')))

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.stores.map((s) => s.store_scope)).toEqual(['a.se', 'b.se'])
  })

  it('unbooked filter excludes manually marked rows (#1879)', async () => {
    enqueue({ data: [], count: 0 })
    enqueue({ data: [] })
    const response = await listOrders(
      createMockRequest('/api/webshop-orders?booked=unbooked'),
    )
    expect(response.status).toBe(200)
    const isFilters = findCalls('webshop_orders', 'is')
    expect(isFilters).toEqual(
      expect.arrayContaining([
        ['journal_entry_id', null],
        ['manually_booked_at', null],
      ]),
    )
  })

  it('booked filter includes manually marked rows (#1879)', async () => {
    enqueue({ data: [], count: 0 })
    enqueue({ data: [] })
    const response = await listOrders(
      createMockRequest('/api/webshop-orders?booked=booked'),
    )
    expect(response.status).toBe(200)
    const orFilters = findCalls('webshop_orders', 'or')
    expect(orFilters).toEqual(
      expect.arrayContaining([
        ['journal_entry_id.not.is.null,manually_booked_at.not.is.null'],
      ]),
    )
  })
})

describe('GET|PUT /api/webshop-orders/settings', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when not authenticated (GET and PUT)', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const getRes = await getSettings(createMockRequest('/api/webshop-orders/settings'))
    expect(getRes.status).toBe(401)
    const putRes = await putSettings(
      createMockRequest('/api/webshop-orders/settings', {
        method: 'PUT',
        body: {
          platform: 'woocommerce',
          store_scope: 'a.se',
          payment_method_account_map: {},
        },
      }),
    )
    expect(putRes.status).toBe(401)
  })

  it('PUT returns 403 for viewers (requireWrite)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const res = await putSettings(
      createMockRequest('/api/webshop-orders/settings', {
        method: 'PUT',
        body: {
          platform: 'woocommerce',
          store_scope: 'a.se',
          payment_method_account_map: {},
        },
      }),
    )
    expect(res.status).toBe(403)
  })

  it('GET returns the stored mappings', async () => {
    enqueue({
      data: [
        {
          platform: 'woocommerce',
          store_scope: 'a.se',
          payment_method_account_map: { swish: { mode: 'book', account: '1930' } },
        },
      ],
    })
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await getSettings(createMockRequest('/api/webshop-orders/settings?platform=woocommerce')),
    )
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
  })

  it('PUT rejects an invalid account number', async () => {
    const response = await putSettings(
      createMockRequest('/api/webshop-orders/settings', {
        method: 'PUT',
        body: {
          platform: 'woocommerce',
          store_scope: 'a.se',
          payment_method_account_map: { swish: { mode: 'book', account: 'not-an-account' } },
        },
      }),
    )
    expect(response.status).toBe(400)
  })

  it('PUT upserts on (company, platform, store_scope)', async () => {
    enqueue({
      data: {
        platform: 'woocommerce',
        store_scope: 'a.se',
        payment_method_account_map: { swish: { mode: 'book', account: '1930' } },
      },
    })
    const { status } = await parseJsonResponse(
      await putSettings(
        createMockRequest('/api/webshop-orders/settings', {
          method: 'PUT',
          body: {
            platform: 'woocommerce',
            store_scope: 'a.se',
            payment_method_account_map: {
              swish: { mode: 'book', account: '1930' },
              bacs: { mode: 'invoice' },
            },
          },
        }),
      ),
    )
    expect(status).toBe(200)
    const upsert = findCall('webshop_store_settings', 'upsert')
    expect(upsert).toBeDefined()
    expect((upsert![0] as Record<string, unknown>).company_id).toBe('company-1')
  })
})
