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

const mockEnsurePresetAccounts = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/webshop-orders/ensure-accounts', () => ({
  ensureCountryPresetAccounts: (...args: unknown[]) => mockEnsurePresetAccounts(...args),
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

  it('booked filter includes manually marked rows (#1879) but not voided ones', async () => {
    enqueue({ data: [], count: 0 })
    const response = await listOrders(
      createMockRequest('/api/webshop-orders?booked=booked'),
    )
    expect(response.status).toBe(200)
    const orFilters = findCalls('webshop_orders', 'or')
    expect(orFilters).toEqual(
      expect.arrayContaining([
        ['journal_entry_id.not.is.null,and(manually_booked_at.not.is.null,manually_voided.is.false)'],
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

  describe('country_account_rules (crm#1032)', () => {
    const SHOP = 'minbutik.myshopify.com'
    const OSS_RULES = [
      { country: 'EU', vat_rate: null, mode: 'accounts', revenue_account: '3106', vat_account: '2670' },
      { country: 'NON_EU', vat_rate: 0, mode: 'accounts', revenue_account: '3105', vat_account: null },
    ]
    const chartRow = (
      account_number: string,
      account_name: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      account_number,
      account_name,
      account_class: Number(account_number.charAt(0)),
      is_active: true,
      default_vat_rate: null,
      default_vat_treatment: null,
      vat_box: null,
      ...overrides,
    })
    const put = (body: Record<string, unknown>) =>
      putSettings(createMockRequest('/api/webshop-orders/settings', { method: 'PUT', body }))

    it('stores the OSS preset and adds the preset accounts the chart lacks', async () => {
      enqueue({ data: [] }) // chart lookup: none of 3106/2670/3105/3305 yet
      enqueue({ data: { platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES } })
      const { status } = await parseJsonResponse(
        await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES }),
      )
      expect(status).toBe(200)
      expect(mockEnsurePresetAccounts).toHaveBeenCalledTimes(1)
      // 3305: the services account an order with nothing to ship books
      // instead of 3105 (#88).
      expect([...(mockEnsurePresetAccounts.mock.calls[0][3] as string[])].sort()).toEqual([
        '2670',
        '3105',
        '3106',
        '3305',
      ])
      // 3106 is created with VAT code OSS by the ensure step; nothing else to mark.
      expect(findCall('chart_of_accounts', 'update')).toBeUndefined()
      const upsert = findCall('webshop_store_settings', 'upsert')![0] as Record<string, unknown>
      expect(upsert.country_account_rules).toEqual(OSS_RULES)
      // Only the part the request carries: the payment-method map is left out
      // of the body (undefined is dropped by JSON), so the column is untouched.
      expect(upsert.payment_method_account_map).toBeUndefined()
      expect(JSON.parse(JSON.stringify(upsert))).not.toHaveProperty('payment_method_account_map')
    })

    it('marks an existing OSS sales account without a VAT code', async () => {
      const rules = [
        { country: 'DE', vat_rate: null, mode: 'accounts', revenue_account: '3013', vat_account: '2674' },
      ]
      enqueue({
        data: [
          chartRow('3013', 'Försäljning OSS Tyskland'),
          chartRow('2674', 'Utgående moms OSS Tyskland'),
        ],
      })
      enqueue({ data: null }) // VAT code update
      enqueue({ data: { platform: 'shopify', store_scope: SHOP, country_account_rules: rules } })
      const { status } = await parseJsonResponse(
        await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: rules }),
      )
      expect(status).toBe(200)
      expect(mockEnsurePresetAccounts.mock.calls[0][3]).toEqual([])
      const update = findCall('chart_of_accounts', 'update')
      expect(update?.[0]).toEqual({ default_vat_treatment: 'oss' })
    })

    it('refuses an EU row with Swedish VAT on own accounts and points it at Svensk moms (crm#1449)', async () => {
      // Stored as an 'accounts' rule it would read as OSS (VAT code OSS on its
      // account, the OSS underlag); the one problem sends it to Svensk moms.
      const rules = [
        { country: 'DK', vat_rate: null, mode: 'accounts', revenue_account: '3001', vat_account: '2611' },
      ]
      enqueue({
        data: [
          chartRow('3001', 'Försäljning inom Sverige, 25 % moms'),
          chartRow('2611', 'Utgående moms på försäljning inom Sverige, 25 %'),
        ],
      })
      const { status, body } = await parseJsonResponse<{
        error: { code: string; details: { problems: Array<{ index: number; code: string }> } }
      }>(await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: rules }))
      expect(status).toBe(400)
      expect(body.error.code).toBe('WEBSHOP_COUNTRY_RULES_INVALID')
      expect(body.error.details.problems.map((p) => p.code)).toEqual(['revenue_swedish_vat_on_eu'])
      expect(findCall('webshop_store_settings', 'upsert')).toBeUndefined()
      expect(mockEnsurePresetAccounts).not.toHaveBeenCalled()
      // 3001 is not the preset OSS account: no usage lookup, no VAT code change.
      expect(mockSupabase.rpc).not.toHaveBeenCalled()
      expect(findCall('chart_of_accounts', 'update')).toBeUndefined()
    })

    describe('a preset 3106 whose VAT code puts it in a ruta', () => {
      const presetChart = (treatment: string, rate: number) => [
        chartRow('3106', 'Försäljning varor till annat EU-land, momspliktig', {
          default_vat_treatment: treatment,
          default_vat_rate: rate,
        }),
        chartRow('2670', 'Utgående moms på försäljning inom EU, OSS'),
        chartRow('3105', 'Försäljning varor till land utanför EU'),
      ]

      it.each([
        ['reverse_charge_eu_goods', 0],
        ['standard_25', 0.25],
        ['exempt', 0],
      ])('stores the OSS preset and gives an unused 3106 (%s) VAT code OSS', async (treatment, rate) => {
        enqueue({ data: presetChart(treatment, rate) })
        enqueue({ data: [] }) // usage counts filtered to 3106: no lines
        enqueue({ data: null }) // 3106 VAT code update
        enqueue({ data: { platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES } })
        const { status } = await parseJsonResponse(
          await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES }),
        )
        expect(status).toBe(200)
        expect(mockSupabase.rpc).toHaveBeenCalledWith('get_account_usage_counts', { p_company_id: 'company-1' })
        // Filtered by PostgREST, so the 1,000-row cap cannot drop 3106.
        expect(findCalls('rpc:get_account_usage_counts', 'eq')).toEqual([['account_number', '3106']])
        const updates = findCalls('chart_of_accounts', 'update')
        expect(updates).toEqual([[{ default_vat_treatment: 'oss', default_vat_rate: null }]])
        const eqs = findCalls('chart_of_accounts', 'eq')
        expect(eqs).toContainEqual(['company_id', 'company-1'])
        expect(eqs).toContainEqual(['account_number', '3106'])
        const upsert = findCall('webshop_store_settings', 'upsert')![0] as Record<string, unknown>
        expect(upsert.country_account_rules).toEqual(OSS_RULES)
      })

      it('refuses the rules and leaves the VAT code alone once 3106 has been booked on', async () => {
        enqueue({ data: presetChart('reverse_charge_eu_goods', 0) })
        enqueue({ data: [{ account_number: '3106', usage_count: 1 }] })
        const { status, body } = await parseJsonResponse<{
          error: { code: string; details: { problems: unknown[] } }
        }>(await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES }))
        expect(status).toBe(400)
        expect(body.error.code).toBe('WEBSHOP_COUNTRY_RULES_INVALID')
        expect(body.error.details.problems).toEqual([
          { index: 0, field: 'revenue_account', code: 'revenue_in_declaration', account: '3106', box: '35' },
        ])
        expect(findCall('chart_of_accounts', 'update')).toBeUndefined()
        expect(findCall('webshop_store_settings', 'upsert')).toBeUndefined()
        expect(mockEnsurePresetAccounts).not.toHaveBeenCalled()
      })

      it('fails closed on a usage answer that cannot vouch for 3106', async () => {
        // A full, unfiltered page: 1,000 other accounts, 3106 cut off by the
        // row cap. It must read as "used", never as "unused".
        const capped = Array.from({ length: 1000 }, (_, i) => ({
          account_number: String(1000 + i),
          usage_count: 1,
        }))
        enqueue({ data: presetChart('reverse_charge_eu_goods', 0) })
        enqueue({ data: capped })
        const { status, body } = await parseJsonResponse<{
          error: { details: { problems: Array<{ code: string; account?: string }> } }
        }>(await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES }))
        expect(status).toBe(400)
        expect(body.error.details.problems.map((p) => [p.code, p.account])).toEqual([
          ['revenue_in_declaration', '3106'],
        ])
        expect(findCall('chart_of_accounts', 'update')).toBeUndefined()
        expect(findCall('webshop_store_settings', 'upsert')).toBeUndefined()
      })

      it('does not look up usage when 3106 already has VAT code OSS', async () => {
        enqueue({ data: presetChart('oss', 0).map((r) => ({ ...r, default_vat_rate: null })) })
        enqueue({ data: { platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES } })
        const { status } = await parseJsonResponse(
          await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES }),
        )
        expect(status).toBe(200)
        expect(mockSupabase.rpc).not.toHaveBeenCalled()
        expect(findCall('chart_of_accounts', 'update')).toBeUndefined()
      })

      it('never changes an account the user typed, even an unused one', async () => {
        const rules = [
          { country: 'DE', vat_rate: null, mode: 'accounts', revenue_account: '3013', vat_account: '2674' },
        ]
        enqueue({
          data: [
            chartRow('3013', 'Försäljning Tyskland', { default_vat_treatment: 'reverse_charge_eu_goods' }),
            chartRow('2674', 'Utgående moms OSS Tyskland'),
          ],
        })
        const { status, body } = await parseJsonResponse<{
          error: { details: { problems: Array<{ code: string; account?: string }> } }
        }>(await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: rules }))
        expect(status).toBe(400)
        expect(body.error.details.problems.map((p) => [p.code, p.account])).toEqual([
          ['revenue_in_declaration', '3013'],
        ])
        expect(mockSupabase.rpc).not.toHaveBeenCalled()
        expect(findCall('chart_of_accounts', 'update')).toBeUndefined()
      })

      it('stores nothing when the usage lookup fails', async () => {
        enqueue({ data: presetChart('reverse_charge_eu_goods', 0) })
        enqueue({ error: { message: 'statement timeout', code: '57014' } })
        const res = await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES })
        expect(res.status).toBeGreaterThanOrEqual(500)
        expect(findCall('chart_of_accounts', 'update')).toBeUndefined()
        expect(findCall('webshop_store_settings', 'upsert')).toBeUndefined()
      })

      it('stores nothing when 3106 cannot get VAT code OSS', async () => {
        enqueue({ data: presetChart('standard_25', 0.25) })
        enqueue({ data: [] })
        enqueue({ error: { message: 'connection reset' } }) // 3106 VAT code update
        const res = await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: OSS_RULES })
        expect(res.status).toBeGreaterThanOrEqual(500)
        expect(findCall('webshop_store_settings', 'upsert')).toBeUndefined()
      })
    })

    it("stores a 'swedish' rule with its own revenue account, checked but never created (crm#1449)", async () => {
      const rules = [
        { country: 'EU', vat_rate: null, mode: 'swedish', revenue_account: '3012' },
        { country: 'NON_EU', vat_rate: 0, mode: 'accounts', revenue_account: '3105', vat_account: null },
      ]
      enqueue({
        data: [
          chartRow('3012', 'Försäljning varor EU-konsumenter', {
            default_vat_rate: 0.25,
            default_vat_treatment: 'standard_25',
          }),
          chartRow('3105', 'Försäljning varor till land utanför EU'),
        ],
      })
      enqueue({ data: { platform: 'shopify', store_scope: SHOP, country_account_rules: rules } })
      const { status } = await parseJsonResponse(
        await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: rules }),
      )
      expect(status).toBe(200)
      const lookup = findCall('chart_of_accounts', 'in')
      expect([...((lookup?.[1] as string[]) ?? [])].sort()).toEqual(['3012', '3105', '3305'])
      // Only the services account for 3105 the chart lacks (#88), never 3012.
      expect(mockEnsurePresetAccounts.mock.calls[0][3]).toEqual(['3305'])
      expect(findCall('chart_of_accounts', 'update')).toBeUndefined()
      const upsert = findCall('webshop_store_settings', 'upsert')![0] as Record<string, unknown>
      expect(upsert.country_account_rules).toEqual(rules)
    })

    it("refuses a 'swedish' rule whose own account is not a ruta 05 account", async () => {
      const rules = [{ country: 'EU', vat_rate: null, mode: 'swedish', revenue_account: '3108' }]
      enqueue({ data: [chartRow('3108', 'Försäljning varor till annat EU-land, momsfri')] })
      const { status, body } = await parseJsonResponse<{
        error: { details: { problems: Array<{ code: string; account?: string }> } }
      }>(await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: rules }))
      expect(status).toBe(400)
      expect(body.error.details.problems).toEqual([
        { index: 0, field: 'revenue_account', code: 'swedish_revenue_vat_code', account: '3108', box: '35' },
      ])
      expect(findCall('webshop_store_settings', 'upsert')).toBeUndefined()
    })

    describe('a Sverige row (crm#1449)', () => {
      const SALES_3011 = chartRow('3011', 'Försäljning varor till privatpersoner i Sverige, 25 % moms', {
        default_vat_rate: 0.25,
        default_vat_treatment: 'standard_25',
      })

      it("stores Sweden on the store's own sales account next to its other rules", async () => {
        // The reporting store's rules plus the Sverige row it asked for.
        const rules = [
          { country: 'EU', vat_rate: null, mode: 'swedish', revenue_account: '3011' },
          { country: 'NON_EU', vat_rate: 0, mode: 'accounts', revenue_account: '3105', vat_account: null },
          { country: 'SE', vat_rate: null, mode: 'swedish', revenue_account: '3011' },
        ]
        enqueue({
          data: [
            SALES_3011,
            chartRow('3105', 'Försäljning varor till land utanför EU', {
              default_vat_rate: 0,
              default_vat_treatment: 'export_goods',
            }),
            chartRow('3305', 'Försäljning tjänster till land utanför EU'),
          ],
        })
        enqueue({ data: { platform: 'shopify', store_scope: SHOP, country_account_rules: rules } })
        const { status } = await parseJsonResponse(
          await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: rules }),
        )
        expect(status).toBe(200)
        expect(mockEnsurePresetAccounts.mock.calls[0][3]).toEqual([])
        expect(findCall('chart_of_accounts', 'update')).toBeUndefined()
        const upsert = findCall('webshop_store_settings', 'upsert')![0] as Record<string, unknown>
        expect(upsert.country_account_rules).toEqual(rules)
      })

      it('refuses Sweden on own accounts and stores nothing', async () => {
        const rules = [{ country: 'SE', vat_rate: null, mode: 'accounts', revenue_account: '3011', vat_account: '2611' }]
        enqueue({ data: [SALES_3011, chartRow('2611', 'Utgående moms på försäljning inom Sverige, 25 %')] })
        const { status, body } = await parseJsonResponse<{
          error: { details: { problems: Array<{ code: string }> } }
        }>(await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: rules }))
        expect(status).toBe(400)
        expect(body.error.details.problems).toEqual([{ index: 0, field: 'country', code: 'country_sweden' }])
        expect(findCall('webshop_store_settings', 'upsert')).toBeUndefined()
      })
    })

    it('names an account that is not in the chart', async () => {
      const rules = [
        { country: 'NO', vat_rate: 25, mode: 'accounts', revenue_account: '3105', vat_account: '2899' },
      ]
      enqueue({ data: [chartRow('3105', 'Försäljning varor till land utanför EU')] })
      const { status, body } = await parseJsonResponse<{
        error: { details: { problems: Array<{ code: string; account?: string }> } }
      }>(await put({ platform: 'shopify', store_scope: SHOP, country_account_rules: rules }))
      expect(status).toBe(400)
      expect(body.error.details.problems).toEqual([
        { index: 0, field: 'vat_account', code: 'account_unknown', account: '2899' },
      ])
    })

    it('keeps country rules to Shopify stores', async () => {
      const { status, body } = await parseJsonResponse<{
        error: { details: { problems: Array<{ code: string }> } }
      }>(await put({ platform: 'woocommerce', store_scope: 'a.se', country_account_rules: OSS_RULES }))
      expect(status).toBe(400)
      expect(body.error.details.problems[0].code).toBe('platform_unsupported')
      expect(findCall('chart_of_accounts', 'select')).toBeUndefined()
    })

    it('saves the payment-method map without touching the rules', async () => {
      enqueue({ data: { platform: 'shopify', store_scope: SHOP } })
      const { status } = await parseJsonResponse(
        await put({
          platform: 'shopify',
          store_scope: SHOP,
          payment_method_account_map: { shopify_payments: { mode: 'book', account: '1686' } },
        }),
      )
      expect(status).toBe(200)
      const upsert = findCall('webshop_store_settings', 'upsert')![0] as Record<string, unknown>
      expect(JSON.parse(JSON.stringify(upsert))).not.toHaveProperty('country_account_rules')
    })

    it('returns 400 for a body with neither part, or a malformed rule', async () => {
      const empty = await put({ platform: 'shopify', store_scope: SHOP })
      expect(empty.status).toBe(400)
      const malformed = await put({
        platform: 'shopify',
        store_scope: SHOP,
        country_account_rules: [{ country: 'Danmark', vat_rate: null, mode: 'swedish' }],
      })
      expect(malformed.status).toBe(400)
    })
  })
})
