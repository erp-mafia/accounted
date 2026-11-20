/**
 * Forecast rows through the v1 door of the operation registry
 * (src/lib/operations/cash-forecast.ts, rules in lib/forecast/rows.ts):
 *   GET  /api/v1/companies/:companyId/cash-forecast-rows          (cash-forecast-rows.list)
 *   POST /api/v1/companies/:companyId/cash-forecast-rows          (cash-forecast-rows.upsert-batch)
 *   POST /api/v1/companies/:companyId/cash-forecast-rows/cancel   (cash-forecast-rows.cancel)
 *
 * The rows are not bookkeeping: the writes commit directly under
 * forecast:write (no staging), are idempotent by the caller's own key, change
 * only open rows, and never delete.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listRoute, POST as upsertRoute } from '../route'
import { POST as cancelRoute } from '../cancel/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

function makeClient(byTable: Record<string, TableMockResult | TableMockResult[]>) {
  const { supabase, calls, payloads } = createTableMockSupabase(byTable)
  return Object.assign(supabase, { calls, payloads })
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ROW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ROW_ID_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const INVOICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/cash-forecast-rows`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    expected_date: '2026-11-20',
    amount: '48000.00',
    direction: 'in',
    currency: 'SEK',
    category: 'revenue',
    source: 'pms',
    external_source: 'boom',
    external_id: 'booking-1',
    confidence: 'likely',
    dimension_value_id: null,
    invoice_id: null,
    supplier_invoice_id: null,
    status: 'open',
    matched_transaction_id: null,
    note: null,
    created_at: '2026-10-28T09:00:00Z',
    updated_at: '2026-10-28T09:00:00Z',
    ...overrides,
  }
}

const input = (overrides: Record<string, unknown> = {}) => ({
  external_source: 'boom',
  external_id: 'booking-1',
  expected_date: '2026-11-20',
  amount: 48000,
  direction: 'in',
  category: 'revenue',
  ...overrides,
})

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const post = (url: string, body: unknown) => request(url, { method: 'POST', body: JSON.stringify(body) })
const wroteRows = (client: ReturnType<typeof makeClient>) =>
  client.calls.some(
    (c) =>
      (c.table === 'cash_forecast_rows' && ['insert', 'update', 'upsert', 'delete'].includes(c.method)) ||
      c.table === 'rpc:upsert_cash_forecast_rows',
  )

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'PMS key',
    scopes: ['reports:read', 'forecast:write'],
    mode: 'live',
  })
})

describe('GET /cash-forecast-rows', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await listRoute(request(BASE), params)).status).toBe(401)
  })

  it('400 VALIDATION_ERROR for a status that does not exist', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await listRoute(request(`${BASE}?status=deleted`), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('lists the company\'s rows by expected date, filtered and paginated, with qualified ids', async () => {
    const client = makeClient({ company_members: MEMBER, cash_forecast_rows: { data: [row()], error: null, count: 3 } })
    mockServiceClient.mockReturnValue(client)
    const res = await listRoute(request(`${BASE}?status=open&from=2026-11-01&limit=1&offset=2`), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.total).toBe(3)
    expect(body.data.rows[0]).toMatchObject({ cash_forecast_row_id: ROW_ID, amount: 48000, external_id: 'booking-1' })
    expect(body.data.rows[0].id).toBeUndefined()
    expect(client.calls).toContainEqual({ table: 'cash_forecast_rows', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(client.calls).toContainEqual({ table: 'cash_forecast_rows', method: 'eq', args: ['status', 'open'] })
    expect(client.calls).toContainEqual({ table: 'cash_forecast_rows', method: 'gte', args: ['expected_date', '2026-11-01'] })
    expect(client.calls).toContainEqual({ table: 'cash_forecast_rows', method: 'range', args: [2, 2] })
  })
})

describe('POST /cash-forecast-rows (upsert a batch)', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await upsertRoute(post(BASE, { rows: [input()] }), params)).status).toBe(401)
  })

  it('403 without forecast:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await upsertRoute(post(BASE, { rows: [input()] }), params)).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a zero amount, a key twice in one batch, and two invoices on one row', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    for (const rows of [
      [input({ amount: 0 })],
      [input(), input({ amount: 5 })],
      [input({ invoice_id: INVOICE_ID, supplier_invoice_id: ROW_ID_2 })],
    ]) {
      const res = await upsertRoute(post(BASE, { rows }), params)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('404 CASH_FORECAST_ROW_REFERENCE_NOT_FOUND for an invoice of another company, writing nothing', async () => {
    const client = makeClient({ company_members: MEMBER, invoices: { data: [], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await upsertRoute(post(BASE, { rows: [input({ invoice_id: INVOICE_ID })] }), params)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('CASH_FORECAST_ROW_REFERENCE_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'invoices', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(wroteRows(client)).toBe(false)
  })

  it('creates new keys, updates open ones, leaves a cancelled one as it is, and commits directly', async () => {
    const client = makeClient({
      company_members: MEMBER,
      // The rows the batch names that exist.
      cash_forecast_rows: {
        data: [
          { id: ROW_ID, external_id: 'booking-1', status: 'open' },
          { id: ROW_ID_2, external_id: 'booking-3', status: 'cancelled' },
        ],
        error: null,
      },
      // What the one batch statement wrote: booking-1 updated, booking-2 inserted.
      'rpc:upsert_cash_forecast_rows': {
        data: [row({ amount: '50000.00' }), row({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', external_id: 'booking-2', source: 'api' })],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await upsertRoute(
      post(BASE, { rows: [input({ amount: 50000 }), input({ external_id: 'booking-2' }), input({ external_id: 'booking-3' })] }),
      params,
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({ created: 1, updated: 1 })
    expect(body.data.skipped).toEqual([{ cash_forecast_row_id: ROW_ID_2, external_source: 'boom', external_id: 'booking-3', status: 'cancelled' }])
    expect(body.data.rows.map((r: { external_id: string }) => r.external_id)).toEqual(['booking-1', 'booking-2'])
    // One statement for the batch, new and open keys only; the cancelled key is never sent.
    expect(client.payloads('rpc:upsert_cash_forecast_rows', 'rpc')).toEqual([
      {
        p_company_id: COMPANY_ID,
        p_source: 'api',
        p_created_by: 'user-1',
        p_rows: [
          expect.objectContaining({ external_id: 'booking-2', amount: 48000, confidence: 'likely' }),
          expect.objectContaining({ external_id: 'booking-1', amount: 50000 }),
        ],
      },
    ])
    expect(client.calls.some((c) => c.table === 'cash_forecast_rows' && ['insert', 'upsert', 'delete'].includes(c.method))).toBe(false)
    // Not bookkeeping: nothing is staged for approval.
    expect(client.calls.some((c) => c.table === 'pending_operations')).toBe(false)
  })

  it('previews with ?dry_run=true and writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER, cash_forecast_rows: { data: [], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await upsertRoute(post(`${BASE}?dry_run=true`, { rows: [input()] }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview ?? body.data).toMatchObject({ would_create: 1, would_update: 0 })
    expect(wroteRows(client)).toBe(false)
  })
})

describe('POST /cash-forecast-rows/cancel', () => {
  const CANCEL = `${BASE}/cancel`

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await cancelRoute(post(CANCEL, { cash_forecast_row_id: ROW_ID }), params)).status).toBe(401)
  })

  it('400 VALIDATION_ERROR when the row is named neither by id nor by both outside keys', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    for (const body of [{}, { external_source: 'boom' }, { cash_forecast_row_id: ROW_ID, external_id: 'x' }]) {
      const res = await cancelRoute(post(CANCEL, body), params)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('404 CASH_FORECAST_ROW_NOT_FOUND for a row outside the company', async () => {
    const client = makeClient({ company_members: MEMBER, cash_forecast_rows: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await cancelRoute(post(CANCEL, { cash_forecast_row_id: ROW_ID }), params)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('CASH_FORECAST_ROW_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'cash_forecast_rows', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it('cancels an open row by the outside key with a compare-and-set, and never deletes', async () => {
    const client = makeClient({
      company_members: MEMBER,
      cash_forecast_rows: [{ data: row(), error: null }, { data: row({ status: 'cancelled' }), error: null }],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await cancelRoute(post(CANCEL, { external_source: 'boom', external_id: 'booking-1' }), params)
    expect(res.status).toBe(200)
    expect((await res.json()).data.row).toMatchObject({ cash_forecast_row_id: ROW_ID, status: 'cancelled' })
    expect(client.payloads('cash_forecast_rows', 'update')).toEqual([{ status: 'cancelled' }])
    expect(client.calls).toContainEqual({ table: 'cash_forecast_rows', method: 'eq', args: ['status', 'open'] })
    expect(client.calls.some((c) => c.table === 'cash_forecast_rows' && c.method === 'delete')).toBe(false)
  })

  it('answers a cancelled row as it is, and refuses a realised one with 409', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, cash_forecast_rows: { data: row({ status: 'cancelled' }), error: null } }))
    const again = await cancelRoute(post(CANCEL, { cash_forecast_row_id: ROW_ID }), params)
    expect(again.status).toBe(200)
    expect((await again.json()).data.row.status).toBe('cancelled')

    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, cash_forecast_rows: { data: row({ status: 'realised' }), error: null } }))
    const realised = await cancelRoute(post(CANCEL, { cash_forecast_row_id: ROW_ID }), params)
    expect(realised.status).toBe(409)
    expect((await realised.json()).error.code).toBe('CASH_FORECAST_ROW_NOT_OPEN')
  })
})
