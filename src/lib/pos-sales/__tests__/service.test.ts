import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDb } from './fake-db'

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => h.db.client }))

import {
  connectPosVenue,
  disconnectPosConnection,
  fetchPosSalesDays,
  getPosSalesDay,
  listAvailablePosVenues,
  listPosConnections,
  listPosSalesDays,
  setPosConnectDepsForTesting,
  updatePosSalesSettings,
} from '../service'

const COMPANY = 'company-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never
const CONFIG = { baseUrl: 'https://connect.example.se', key: 'gnubok_ck_test_key_value_123456' }
const PROVIDER = { ref: 'heynow', displayName: 'Heynow', legalName: 'Heynow AB', portalUrl: null, supportUrl: null, accessRequestSv: 'Mejla support' }

function ctx() {
  return { supabase: h.db.client as never, companyId: COMPANY, userId: 'user-1', log }
}

function connectFetch(handler: (path: string, body: unknown, headers: Record<string, string>) => Response) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) =>
    handler(new URL(url).pathname, JSON.parse((init.body as string) || '{}'), init.headers as Record<string, string>),
  )
  setPosConnectDepsForTesting({ config: CONFIG, fetch: fetchImpl as unknown as typeof fetch })
  return fetchImpl
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = createFakeDb({
    company_settings: [{ company_id: COMPANY, org_number: '556677-8899', is_sandbox: false }],
    pos_connections: [],
    pos_sales_days: [],
    chart_of_accounts: [],
  })
  setPosConnectDepsForTesting({ config: CONFIG })
})

describe('venues and connecting', () => {
  it('asks Connect with the company id and its ten-digit organisation number', async () => {
    const fetchImpl = connectFetch((path, body, headers) => {
      expect(path).toBe('/api/connect/pos/venues')
      expect(body).toEqual({ orgNumber: '5566778899' })
      expect(headers['X-Connector-Company']).toBe(COMPANY)
      return new Response(JSON.stringify({ venues: [], providers: [PROVIDER], serverTime: 'now' }), { status: 200 })
    })
    const outcome = await listAvailablePosVenues(ctx())
    expect(outcome).toMatchObject({ ok: true, data: { org_number: '5566778899', providers: [PROVIDER] } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('needs an organisation number, and says Connect is missing when there is no key', async () => {
    h.db.tables.company_settings[0].org_number = null
    expect(await listAvailablePosVenues(ctx())).toMatchObject({ ok: false, code: 'POS_ORG_NUMBER_MISSING' })
    h.db.tables.company_settings[0].org_number = '556677-8899'
    setPosConnectDepsForTesting({ config: null })
    expect(await listAvailablePosVenues(ctx())).toMatchObject({ ok: false, code: 'POS_CONNECT_UNCONFIGURED' })
  })

  it('connects a venue: the handle from Connect is stored server-side and the first fetch is due at once', async () => {
    connectFetch((path, body) => {
      expect(path).toBe('/api/connect/pos/connect')
      expect(body).toEqual({ provider: 'heynow', venueRef: '5550000000000001', orgNumber: '5566778899' })
      return new Response(
        JSON.stringify({
          connectionHandle: 'pos_' + 'h'.repeat(43),
          provider: PROVIDER,
          venueRef: '5550000000000001',
          venueName: 'Restaurang Exempel',
          connectedAt: '2026-10-03T10:00:00Z',
        }),
        { status: 200 },
      )
    })
    const outcome = await connectPosVenue(ctx(), { provider: 'heynow', venue_ref: '5550000000000001', sync_from: '2026-09-30' })
    expect(outcome).toMatchObject({ ok: true, created: true })
    const row = h.db.tables.pos_connections[0]
    expect(row).toMatchObject({
      company_id: COMPANY,
      provider: 'heynow',
      provider_name: 'Heynow',
      venue_name: 'Restaurang Exempel',
      connection_handle: 'pos_' + 'h'.repeat(43),
      status: 'active',
      sync_from: '2026-09-30',
      created_by: 'user-1',
    })
    // The member-facing view never carries the handle.
    if (outcome.ok && !outcome.dryRun) expect('connection_handle' in outcome.data.connection).toBe(false)
  })

  it('refuses the sandbox, a duplicate, and a first day that is not in the past', async () => {
    h.db.tables.company_settings[0].is_sandbox = true
    expect(await connectPosVenue(ctx(), { provider: 'heynow', venue_ref: 'v' })).toMatchObject({ ok: false, code: 'POS_SANDBOX_BLOCKED' })
    h.db.tables.company_settings[0].is_sandbox = false
    expect(await connectPosVenue(ctx(), { provider: 'heynow', venue_ref: 'v', sync_from: '2999-01-01' })).toMatchObject({
      ok: false,
      code: 'POS_SYNC_FROM_INVALID',
    })
    expect(await connectPosVenue(ctx(), { provider: 'heynow', venue_ref: 'v', sync_from: '2026-02-30' })).toMatchObject({
      ok: false,
      code: 'POS_SYNC_FROM_INVALID',
    })
    h.db.tables.pos_connections.push({ id: 'conn-1', company_id: COMPANY, provider: 'heynow', venue_ref: 'v', status: 'active' })
    expect(await connectPosVenue(ctx(), { provider: 'heynow', venue_ref: 'v' })).toMatchObject({ ok: false, code: 'POS_ALREADY_CONNECTED' })
  })

  it('answers Connect\'s refusal as a connect failure with its code', async () => {
    connectFetch(() => new Response(JSON.stringify({ error: 'x', code: 'CONNECTOR_POS_VENUE_TAKEN', retryable: false }), { status: 409 }))
    expect(await connectPosVenue(ctx(), { provider: 'heynow', venue_ref: 'v' })).toMatchObject({
      ok: false,
      code: 'POS_CONNECT_FAILED',
      details: { connect_code: 'CONNECTOR_POS_VENUE_TAKEN' },
    })
    expect(h.db.tables.pos_connections).toEqual([])
  })
})

describe('disconnecting', () => {
  beforeEach(() => {
    h.db.tables.pos_connections.push({
      id: 'conn-1',
      company_id: COMPANY,
      provider: 'heynow',
      venue_ref: 'v',
      venue_name: 'Restaurang Exempel',
      provider_name: 'Heynow',
      connection_handle: 'pos_' + 'h'.repeat(43),
      status: 'active',
    })
  })

  it('releases the venue at Connect and ends the row without deleting it', async () => {
    const fetchImpl = connectFetch((path, _body, headers) => {
      expect(path).toBe('/api/connect/pos/disconnect')
      expect(headers['X-Connector-Connection']).toBe('pos_' + 'h'.repeat(43))
      return new Response(JSON.stringify({ disconnected: true }), { status: 200 })
    })
    expect(await disconnectPosConnection(ctx(), { connection_id: 'conn-1' })).toMatchObject({ ok: true, data: { status: 'disconnected' } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(h.db.tables.pos_connections[0]).toMatchObject({ status: 'disconnected', connection_handle: null, ended_by: 'user-1' })
  })

  it('ends locally with a warning when Connect cannot be reached', async () => {
    connectFetch(() => {
      throw new TypeError('fetch failed')
    })
    const outcome = await disconnectPosConnection(ctx(), { connection_id: 'conn-1' })
    expect(outcome).toMatchObject({ ok: true })
    expect((outcome as { warnings?: Array<{ code: string }> }).warnings?.[0].code).toBe('POS_DISCONNECT_REMOTE_FAILED')
    expect(h.db.tables.pos_connections[0].status).toBe('disconnected')
  })

  it('previews without calling Connect, and refuses another company\'s connection', async () => {
    const fetchImpl = connectFetch(() => new Response('{}', { status: 200 }))
    expect(await disconnectPosConnection(ctx(), { connection_id: 'conn-1' }, { dryRun: true })).toMatchObject({ ok: true, dryRun: true })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await disconnectPosConnection({ ...ctx(), companyId: 'other' }, { connection_id: 'conn-1' })).toMatchObject({
      ok: false,
      code: 'POS_CONNECTION_NOT_FOUND',
    })
  })
})

describe('settings', () => {
  beforeEach(() => {
    h.db.tables.pos_connections.push({ id: 'conn-1', company_id: COMPANY, settings: {}, status: 'active' })
    h.db.tables.pos_sales_days.push({
      id: 'd1',
      connection_id: 'conn-1',
      journal_entry_id: null,
      status: 'needs_review',
      day: {
        businessDate: '2026-10-01',
        currency: 'SEK',
        sales: { net: 500, vat: 0, gross: 500 },
        vatGroups: [{ ratePercent: 0, net: 500, vat: 0, gross: 500 }],
        tenders: [{ kind: 'card', method: 'card', amount: 500, tips: 0, receiptCount: 1 }],
        tips: 0,
        discounts: 0,
        refunds: { count: 0, gross: 0 },
        receiptCount: 1,
        firstReceiptNumber: '1',
        lastReceiptNumber: '1',
        firstPaidAt: null,
        lastPaidAt: null,
        categories: [],
        receipts: [],
        issues: [],
      },
    })
  })

  it('stores the merged mapping and re-evaluates the waiting days', async () => {
    const outcome = await updatePosSalesSettings(ctx(), { connection_id: 'conn-1', settings: { revenue_accounts: { '0': '2421' } } })
    expect(outcome).toMatchObject({ ok: true, data: { reevaluated_days: 1 } })
    expect((h.db.tables.pos_connections[0].settings as { revenue_accounts: Record<string, string> }).revenue_accounts['0']).toBe('2421')
    expect(h.db.tables.pos_sales_days[0].status).toBe('ready')
  })

  it('refuses an account neither in the chart nor in BAS, and accepts one the company created', async () => {
    expect(await updatePosSalesSettings(ctx(), { connection_id: 'conn-1', settings: { tips_account: '2828' } })).toMatchObject({
      ok: false,
      code: 'POS_SETTINGS_ACCOUNT_UNKNOWN',
      details: { accounts: ['2828'] },
    })
    h.db.tables.chart_of_accounts.push({ company_id: COMPANY, account_number: '2828', is_active: true })
    expect(await updatePosSalesSettings(ctx(), { connection_id: 'conn-1', settings: { tips_account: '2828' } })).toMatchObject({ ok: true })
  })

  it('refuses a malformed patch and an unknown connection', async () => {
    expect(await updatePosSalesSettings(ctx(), { connection_id: 'conn-1', settings: { tips_account: '28' } as never })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    })
    expect(await updatePosSalesSettings(ctx(), { connection_id: 'nope', settings: {} })).toMatchObject({ ok: false, code: 'POS_CONNECTION_NOT_FOUND' })
  })
})

describe('reads', () => {
  it('lists connections with resolved settings, and days with numbers as numbers', async () => {
    h.db.tables.pos_connections.push({ id: 'conn-1', company_id: COMPANY, settings: {}, status: 'active' })
    h.db.tables.pos_sales_days.push({ id: 'd1', company_id: COMPANY, connection_id: 'conn-1', business_date: '2026-10-01', gross: '112.00', net: '100.00', vat: '12.00', tips: '0.00', review_reasons: null, tenders: [], vat_groups: [] })
    const connections = await listPosConnections(ctx())
    expect(connections).toMatchObject({ ok: true, data: { available: true } })
    if (connections.ok && !connections.dryRun) expect(connections.data.connections[0].resolved_settings.tender_accounts.card).toBe('1686')
    const days = await listPosSalesDays(ctx(), {})
    expect(days).toMatchObject({ ok: true, data: { total: 1, days: [{ gross: 112, net: 100, vat: 12, review_reasons: [] }] } })
  })

  it('answers an unknown day as not found', async () => {
    expect(await getPosSalesDay(ctx(), { day_id: 'nope' })).toMatchObject({ ok: false, code: 'POS_DAY_NOT_FOUND' })
  })

  it('refuses a fetch in the sandbox, of a day that does not exist, or without an active connection', async () => {
    expect(await fetchPosSalesDays(ctx(), {})).toMatchObject({ ok: false, code: 'POS_CONNECTION_NOT_FOUND' })
    expect(await fetchPosSalesDays(ctx(), { business_dates: ['2026-02-30'] })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
      details: { business_dates: ['2026-02-30'] },
    })
    h.db.tables.company_settings[0].is_sandbox = true
    expect(await fetchPosSalesDays(ctx(), {})).toMatchObject({ ok: false, code: 'POS_SANDBOX_BLOCKED' })
  })
})
