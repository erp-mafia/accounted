import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
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

interface StoreRow {
  id: string
  company_id: string
  platform: string
  store_scope: string
  store_label: string | null
  row_type: 'order' | 'refund'
}

const storeRow = (store_scope: string, store_label: string, i: number): StoreRow => ({
  id: `o${i}`,
  company_id: 'company-1',
  platform: 'woocommerce',
  store_scope,
  store_label,
  row_type: 'order',
})

/**
 * webshop_orders the way PostgREST serves it: eq/gt filters, order, range and
 * limit, a count, and never more than 1,000 rows in one response.
 */
function postgrestLikeOrders(rows: StoreRow[]) {
  const from = (table: string) => {
    expect(table).toBe('webshop_orders')
    const eqs: Array<[keyof StoreRow, unknown]> = []
    const gts: Array<[keyof StoreRow, string]> = []
    let orderBy: keyof StoreRow | null = null
    let window: [number, number] = [0, 999]
    let limit = 1000
    let single = false
    const run = () => {
      let out = rows.filter((r) => eqs.every(([c, v]) => r[c] === v) && gts.every(([c, v]) => String(r[c]) > v))
      const count = out.length
      if (orderBy) {
        const col = orderBy
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0))
      }
      out = out.slice(window[0], Math.min(window[1] + 1, window[0] + limit, window[0] + 1000))
      return { data: single ? (out[0] ?? null) : out, error: null, count }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (c: keyof StoreRow, v: unknown) => (eqs.push([c, v]), chain),
      gt: (c: keyof StoreRow, v: string) => (gts.push([c, v]), chain),
      // The first order() wins; a column these rows lack (order_date) keeps seed order.
      order: (c: keyof StoreRow) => ((orderBy = orderBy ?? c), chain),
      range: (a: number, b: number) => ((window = [a, b]), chain),
      limit: (n: number) => ((limit = n), chain),
      maybeSingle: () => ((single = true), chain),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
    }
    return chain
  }
  return { from, auth: mockSupabase.auth } as never
}

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

  it('lists rows with the store facet, one entry per store', async () => {
    enqueue({
      data: [{ id: 'o1' }, { id: 'o2' }],
      count: 2,
    })
    const { status, body } = await parseJsonResponse<{
      data: unknown[]
      count: number
      stores: Array<{ store_scope: string }>
    }>(await listOrders(createMockRequest('/api/webshop-orders?paid=paid&booked=unbooked'), createMockRouteParams({})))

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    // The facet reads one row per store (maybeSingle), never a page of orders.
    expect(findCalls('webshop_orders', 'maybeSingle').length).toBeGreaterThan(0)
    expect(findCalls('webshop_orders', 'limit')).toEqual(findCalls('webshop_orders', 'limit').map(() => [1]))
  })

  it('lists a store whose orders all sit past the first 1,000 rows (accounted#17)', async () => {
    // 1,500 orders from one store, then one from a second. The old facet read
    // the store list off order rows with .limit(5000), which PostgREST answers
    // with 1,000 rows: the second store never reached the dropdown.
    const rows = [
      ...Array.from({ length: 1500 }, (_, i) => storeRow('a.se', 'A', i)),
      storeRow('b.se', 'B', 1500),
    ]
    requireAuthMock.mockResolvedValue({ user: mockUser, supabase: postgrestLikeOrders(rows) })

    const { status, body } = await parseJsonResponse<{
      count: number
      stores: Array<{ platform: string; store_scope: string; store_label: string | null }>
    }>(await listOrders(createMockRequest('/api/webshop-orders'), createMockRouteParams({})))

    expect(status).toBe(200)
    expect(body.count).toBe(1501)
    expect(body.stores).toEqual([
      { platform: 'woocommerce', store_scope: 'a.se', store_label: 'A' },
      { platform: 'woocommerce', store_scope: 'b.se', store_label: 'B' },
    ])
  })

  it('returns the error when the store facet read fails', async () => {
    enqueue({ data: [], count: 0 })
    enqueue({ data: null, error: { message: 'facet boom', code: 'XX000' } })
    const response = await listOrders(createMockRequest('/api/webshop-orders'), createMockRouteParams({}))
    expect(response.status).toBe(500)
  })

  it('unbooked filter excludes manually marked rows (#1879)', async () => {
    enqueue({ data: [], count: 0 })
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
