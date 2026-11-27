import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDb } from './fake-db'
import { eventBus } from '@/lib/events'
import { getCanonicalAppOrigin } from '@/lib/domains/trusted-app-origin'
import type { SpendExpenseModel } from '../types'

const h = vi.hoisted(() => {
  const state = {
    db: null as unknown as FakeDb,
    /** The service-role client; a spy so a test can say a path never needed it. */
    admin: vi.fn(),
    checkPeriodLock: vi.fn(),
    sync: vi.fn(),
  }
  state.admin.mockImplementation(() => state.db.client)
  return state
})

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: h.admin }))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: h.checkPeriodLock }))
// The momskoder only shape reverse-charge basis lines, which these expenses do not carry.
vi.mock('@/lib/bookkeeping/chart-vat-treatments', () => ({ fetchChartVatTreatments: vi.fn(async () => ({})) }))
vi.mock('../sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync')>()),
  syncSpendConnection: h.sync,
}))

import {
  completeSpendConnectReturn,
  connectSpendWithApiKey,
  disconnectSpendConnection,
  fetchSpendNow,
  findPendingSpendConnection,
  getSpendItem,
  listAvailableSpendProviders,
  listSpendConnections,
  listSpendItems,
  setSpendConnectDepsForTesting,
  sha256Hex,
  startSpendConnect,
  updateSpendSettings,
} from '../service'

const COMPANY = 'company-1'
const SHA = 'a'.repeat(64)
const HANDLE = 'spd_' + 'h'.repeat(40)
const STATE = 's'.repeat(43)
const RESULT = 'r'.repeat(40)
const API_KEY = 'pleo_live_key_0123456789abcdef'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never
const CONFIG = { baseUrl: 'https://connect.example.se', key: 'gnubok_ck_test_key_value_123456' }
const PROVIDER = {
  ref: 'pleo',
  displayName: 'Pleo',
  legalName: 'Pleo Technologies A/S',
  portalUrl: null,
  supportUrl: null,
  connectModes: ['oauth', 'api_key'],
  maxDimensions: 5,
  setupNoteSv: null,
}

function ctx(companyId = COMPANY) {
  return { supabase: h.db.client as never, companyId, userId: 'user-1', log }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const providers = () => json({ providers: [PROVIDER], serverTime: '2026-10-17T10:00:00Z' })

type Handler = (body: Record<string, unknown>, headers: Record<string, string>) => Response

/** Connect answering per operation path; any other call fails the request. */
function connectFetch(routes: Record<string, Handler>) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/connect/spend', '')
    const handler = routes[path]
    if (!handler) throw new Error(`unexpected Connect call ${path}`)
    return handler(JSON.parse((init.body as string) || '{}'), init.headers as Record<string, string>)
  })
  setSpendConnectDepsForTesting({ config: CONFIG, fetch: fetchImpl as unknown as typeof fetch })
  return fetchImpl
}

function connectionAnswer(overrides: Record<string, unknown> = {}) {
  return {
    connectionHandle: HANDLE,
    provider: PROVIDER,
    mode: 'oauth',
    providerCompanyRef: 'pleo-company-1',
    providerCompanyName: 'Exempel AB',
    providerOrgNumber: '5566778899',
    connectedAt: '2026-10-17T10:00:00Z',
    ...overrides,
  }
}

function connectionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'conn-1',
    company_id: COMPANY,
    provider: 'pleo',
    provider_name: 'Pleo',
    route: 'connect',
    mode: 'oauth',
    provider_company_ref: 'pleo-company-1',
    provider_company_name: 'Exempel AB',
    provider_org_number: '5566778899',
    status: 'active',
    health: 'ok',
    health_code: null,
    next_run_at: '2026-10-17T10:00:00Z',
    lease_until: '1970-01-01T00:00:00.000Z',
    last_success_at: null,
    last_error_code: null,
    last_error_at: null,
    failures_in_row: 0,
    master_data_sha256: null,
    master_data_sent_at: null,
    settings: { wallet_account: '1940' },
    created_by: 'user-1',
    created_at: '2026-10-17T09:00:00Z',
    ended_by: null,
    ended_at: null,
    updated_at: '2026-10-17T09:00:00Z',
    connection_handle: HANDLE,
    pending_state_sha256: null,
    pending_expires_at: null,
    pending_return_origin: null,
    ...overrides,
  }
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return connectionRow({
    status: 'connecting',
    connection_handle: null,
    provider_company_ref: null,
    provider_company_name: null,
    provider_org_number: null,
    pending_state_sha256: sha256Hex(STATE),
    pending_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    pending_return_origin: 'https://byra.example.se',
    ...overrides,
  })
}

function expenseModel(overrides: Partial<SpendExpenseModel> = {}): SpendExpenseModel {
  return {
    externalId: 'exp-1',
    batchRef: null,
    kind: 'card_purchase',
    subKind: null,
    date: '2026-10-05',
    currency: 'SEK',
    amount: 125,
    original: null,
    walletAccount: null,
    lines: [{ account: '5410', amount: 125, vat: { code: 'SE25', type: 'standard', rate: 0.25, amount: 25 }, dimensions: {}, description: null }],
    merchant: { name: 'Kontorsbolaget AB', country: 'SE', taxId: null, categoryCode: null },
    person: { name: 'Kim Exempel', ref: null },
    note: null,
    attendees: [],
    reference: 'P-1001',
    settles: [],
    files: [
      {
        fileRef: 'file-1',
        name: 'kvitto.pdf',
        contentType: 'application/pdf',
        size: 2048,
        sha256: 'b'.repeat(64),
        downloadUrl: 'https://files.connect.example.se/file-1',
        downloadExpiresAt: '2026-10-06T00:00:00Z',
      },
    ],
    providerUrl: null,
    issues: [],
    ...overrides,
  }
}

function itemRow(overrides: Record<string, unknown> = {}, model: SpendExpenseModel = expenseModel()): Record<string, unknown> {
  return {
    id: 'item-1',
    company_id: COMPANY,
    connection_id: 'conn-1',
    provider: 'pleo',
    external_id: model.externalId,
    batch_ref: null,
    kind: model.kind,
    expense_date: model.date,
    currency: model.currency,
    amount: model.amount,
    merchant_name: model.merchant?.name ?? null,
    person_name: model.person?.name ?? null,
    status: 'ready',
    reasons: [],
    raw_sha256: SHA,
    document_ids: ['doc-1'],
    received_at: '2026-10-05T12:00:00Z',
    receive_count: 1,
    ack_outcome: 'received',
    acknowledged_at: '2026-10-05T12:00:01Z',
    changed_after_booking: false,
    latest_raw_sha256: null,
    latest_received_at: null,
    journal_entry_id: null,
    booked_at: null,
    booked_by: null,
    created_at: '2026-10-05T12:00:00Z',
    updated_at: '2026-10-05T12:00:00Z',
    expense: model,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  h.db = createFakeDb({
    company_settings: [{ company_id: COMPANY, org_number: '556677-8899', is_sandbox: false, vat_registered: true, dimensions_enabled: false }],
    companies: [],
    spend_connections: [],
    spend_items: [],
    chart_of_accounts: [],
  })
  h.checkPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-2026' })
  // A test that expects no Connect call fails loudly if one happens.
  setSpendConnectDepsForTesting({
    config: CONFIG,
    fetch: vi.fn(async () => {
      throw new Error('no Connect call expected')
    }) as unknown as typeof fetch,
  })
})

describe('providers', () => {
  it('lists the providers Connect offers this company', async () => {
    const fetchImpl = connectFetch({
      '/providers': (_body, headers) => {
        expect(headers['X-Connector-Company']).toBe(COMPANY)
        return providers()
      },
    })
    expect(await listAvailableSpendProviders(ctx())).toEqual({ ok: true, data: { providers: [PROVIDER] } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('says Connect is missing on an installation without a connector key', async () => {
    setSpendConnectDepsForTesting({ config: null })
    expect(await listAvailableSpendProviders(ctx())).toEqual({ ok: false, code: 'SPEND_CONNECT_UNCONFIGURED' })
    expect(await listSpendConnections(ctx())).toMatchObject({ ok: true, data: { connections: [], available: false } })
  })
})

describe('starting a connection through the consent page', () => {
  it('refuses the sandbox and a company without an organisation number before asking Connect', async () => {
    const fetchImpl = connectFetch({ '/providers': providers })
    h.db.tables.company_settings[0].is_sandbox = true
    expect(await startSpendConnect(ctx(), { provider: 'pleo' })).toEqual({ ok: false, code: 'SPEND_SANDBOX_BLOCKED' })
    h.db.tables.company_settings[0].is_sandbox = false
    h.db.tables.company_settings[0].org_number = null
    expect(await startSpendConnect(ctx(), { provider: 'pleo' })).toEqual({ ok: false, code: 'SPEND_ORG_NUMBER_MISSING' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(h.db.tables.spend_connections).toEqual([])
  })

  it('refuses a provider Connect does not offer, and one without a consent page', async () => {
    connectFetch({ '/providers': providers })
    expect(await startSpendConnect(ctx(), { provider: 'other' })).toEqual({
      ok: false,
      code: 'SPEND_PROVIDER_UNKNOWN',
      details: { provider: 'other' },
    })
    connectFetch({ '/providers': () => json({ providers: [{ ...PROVIDER, connectModes: ['api_key'] }], serverTime: 'now' }) })
    expect(await startSpendConnect(ctx(), { provider: 'pleo' })).toEqual({
      ok: false,
      code: 'SPEND_MODE_UNSUPPORTED',
      details: { mode: 'oauth' },
    })
    expect(h.db.tables.spend_connections).toEqual([])
  })

  it('refuses a second live connection to the same provider', async () => {
    h.db.tables.spend_connections.push(connectionRow())
    connectFetch({ '/providers': providers })
    expect(await startSpendConnect(ctx(), { provider: 'pleo' })).toEqual({
      ok: false,
      code: 'SPEND_ALREADY_CONNECTED',
      details: { connection_id: 'conn-1' },
    })
  })

  it('keeps only the hash of a fresh state on a pending row valid for fifteen minutes, and answers the consent page', async () => {
    let sentState = ''
    const fetchImpl = connectFetch({
      '/providers': providers,
      '/authorize': (body) => {
        sentState = String(body.state)
        expect(body).toEqual({
          provider: 'pleo',
          orgNumber: '5566778899',
          returnUrl: `${getCanonicalAppOrigin()}/api/spend/connections/return`,
          state: sentState,
        })
        return json({ authorizeUrl: 'https://auth.pleo.io/oauth/authorize?client_id=accounted', expiresAt: '2026-10-17T10:15:00Z' })
      },
    })
    const before = Date.now()
    const outcome = await startSpendConnect(ctx(), { provider: 'pleo', return_origin: 'https://byra.example.se' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const row = h.db.tables.spend_connections[0]
    expect(outcome).toEqual({ ok: true, data: { connection_id: row.id, authorize_url: 'https://auth.pleo.io/oauth/authorize?client_id=accounted' } })
    expect(row).toMatchObject({
      company_id: COMPANY,
      provider: 'pleo',
      provider_name: 'Pleo',
      mode: 'oauth',
      status: 'connecting',
      pending_return_origin: 'https://byra.example.se',
      created_by: 'user-1',
    })
    expect(sentState.length).toBeGreaterThanOrEqual(43)
    expect(row.pending_state_sha256).toBe(sha256Hex(sentState))
    expect(JSON.stringify(row)).not.toContain(sentState)
    const window = Date.parse(row.pending_expires_at as string) - before
    expect(window).toBeGreaterThanOrEqual(15 * 60 * 1000)
    expect(window).toBeLessThan(15 * 60 * 1000 + 5000)
    expect(row.connection_handle).toBeUndefined()
  })

  it('replaces an unfinished attempt, so only the newest state can finish', async () => {
    h.db.tables.spend_connections.push(pendingRow({ pending_state_sha256: sha256Hex('old-state-0123456789') }))
    connectFetch({
      '/providers': providers,
      '/authorize': () => json({ authorizeUrl: 'https://auth.pleo.io/oauth/authorize?client_id=accounted', expiresAt: 'later' }),
    })
    expect(await startSpendConnect(ctx(), { provider: 'pleo' })).toMatchObject({ ok: true, data: { connection_id: 'conn-1' } })
    expect(h.db.tables.spend_connections).toHaveLength(1)
    expect(h.db.tables.spend_connections[0].pending_state_sha256).not.toBe(sha256Hex('old-state-0123456789'))
  })

  it('removes the pending row when Connect refuses to start, and names the refusal', async () => {
    connectFetch({
      '/providers': providers,
      '/authorize': () => json({ error: 'upstream', code: 'CONNECTOR_SPEND_PROVIDER_ERROR', retryable: true }, 502),
    })
    expect(await startSpendConnect(ctx(), { provider: 'pleo' })).toEqual({
      ok: false,
      code: 'SPEND_CONNECT_FAILED',
      details: { connect_code: 'CONNECTOR_SPEND_PROVIDER_ERROR', retryable: true },
    })
    expect(h.db.tables.spend_connections).toEqual([])

    connectFetch({
      '/providers': providers,
      '/authorize': () => json({ error: 'mismatch', code: 'CONNECTOR_SPEND_COMPANY_MISMATCH', retryable: false }, 409),
    })
    expect(await startSpendConnect(ctx(), { provider: 'pleo' })).toEqual({ ok: false, code: 'SPEND_COMPANY_MISMATCH' })
    expect(h.db.tables.spend_connections).toEqual([])
  })
})

describe('finishing the consent round trip', () => {
  it('finds the pending row by the hash of its state, and nothing else', async () => {
    h.db.tables.spend_connections.push(pendingRow())
    expect(await findPendingSpendConnection(STATE)).toMatchObject({ id: 'conn-1', pending_return_origin: 'https://byra.example.se' })
    expect(await findPendingSpendConnection('t'.repeat(43))).toBeNull()
    h.db.tables.spend_connections[0].status = 'active'
    expect(await findPendingSpendConnection(STATE)).toBeNull()
  })

  it('refuses an attempt past its window without asking Connect', async () => {
    const fetchImpl = connectFetch({})
    const pending = pendingRow({ pending_expires_at: new Date(Date.now() - 1000).toISOString() })
    h.db.tables.spend_connections.push({ ...pending })
    expect(await completeSpendConnectReturn(pending as never, { state: STATE, result: RESULT }, log)).toEqual({
      ok: false,
      code: 'SPEND_CONNECT_EXPIRED',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(h.db.tables.spend_connections[0].status).toBe('connecting')
  })

  it('activates the pending row with the handle Connect gives, and the same state cannot finish twice', async () => {
    const pending = pendingRow()
    h.db.tables.spend_connections.push({ ...pending })
    connectFetch({
      '/complete': (body) => {
        expect(body).toEqual({ state: STATE, result: RESULT })
        return json(connectionAnswer())
      },
    })
    expect(await completeSpendConnectReturn(pending as never, { state: STATE, result: RESULT }, log)).toEqual({
      ok: true,
      connectionId: 'conn-1',
      companyId: COMPANY,
    })
    expect(h.db.tables.spend_connections[0]).toMatchObject({
      status: 'active',
      connection_handle: HANDLE,
      provider_company_ref: 'pleo-company-1',
      provider_company_name: 'Exempel AB',
      provider_org_number: '5566778899',
      pending_state_sha256: null,
      pending_expires_at: null,
      pending_return_origin: null,
      health: 'ok',
      health_code: null,
    })
    expect(await completeSpendConnectReturn(pending as never, { state: STATE, result: RESULT }, log)).toEqual({
      ok: false,
      code: 'SPEND_CONNECT_FAILED',
    })
  })

  it('refuses a provider company registered to another organisation number and releases it at Connect', async () => {
    const pending = pendingRow()
    h.db.tables.spend_connections.push({ ...pending })
    const fetchImpl = connectFetch({
      '/complete': () => json(connectionAnswer({ providerOrgNumber: '5560001111' })),
      '/disconnect': (_body, headers) => {
        expect(headers['X-Connector-Connection']).toBe(HANDLE)
        return json({ disconnected: true })
      },
    })
    expect(await completeSpendConnectReturn(pending as never, { state: STATE, result: RESULT }, log)).toEqual({
      ok: false,
      code: 'SPEND_COMPANY_MISMATCH',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(h.db.tables.spend_connections).toEqual([])
  })

  it('compares organisation numbers as keys: a 12-digit form of another company is refused, of this one accepted', async () => {
    const refused = pendingRow()
    h.db.tables.spend_connections.push({ ...refused })
    connectFetch({
      '/complete': () => json(connectionAnswer({ providerOrgNumber: '165560001111' })),
      '/disconnect': () => json({ disconnected: true }),
    })
    expect(await completeSpendConnectReturn(refused as never, { state: STATE, result: RESULT }, log)).toEqual({
      ok: false,
      code: 'SPEND_COMPANY_MISMATCH',
    })

    const accepted = pendingRow()
    h.db.tables.spend_connections.push({ ...accepted })
    connectFetch({ '/complete': () => json(connectionAnswer({ providerOrgNumber: '165566778899' })) })
    expect(await completeSpendConnectReturn(accepted as never, { state: STATE, result: RESULT }, log)).toMatchObject({ ok: true })
  })

  it.each([[null], ['12345678']])('accepts a provider company whose number is not a Swedish one (%s)', async (providerOrgNumber) => {
    const pending = pendingRow()
    h.db.tables.spend_connections.push({ ...pending })
    connectFetch({ '/complete': () => json(connectionAnswer({ providerOrgNumber })) })
    expect(await completeSpendConnectReturn(pending as never, { state: STATE, result: RESULT }, log)).toMatchObject({ ok: true })
    expect(h.db.tables.spend_connections[0].status).toBe('active')
  })

  it.each([
    ['CONNECTOR_SPEND_COMPANY_MISMATCH', 'SPEND_COMPANY_MISMATCH'],
    ['CONNECTOR_SPEND_ALREADY_CONNECTED', 'SPEND_ALREADY_CONNECTED'],
    ['CONNECTOR_SPEND_PROVIDER_ERROR', 'SPEND_CONNECT_FAILED'],
  ])('answers Connect refusing with %s as %s and leaves the pending row', async (connectCode, code) => {
    const pending = pendingRow()
    h.db.tables.spend_connections.push({ ...pending })
    connectFetch({ '/complete': () => json({ error: 'refused', code: connectCode, retryable: false }, 409) })
    expect(await completeSpendConnectReturn(pending as never, { state: STATE, result: RESULT }, log)).toEqual({ ok: false, code })
    expect(h.db.tables.spend_connections[0].status).toBe('connecting')
  })
})

describe('connecting with an API key', () => {
  it('hands the key to Connect and stores only the handle', async () => {
    connectFetch({
      '/connect-key': (body) => {
        expect(body).toEqual({ provider: 'pleo', orgNumber: '5566778899', apiKey: API_KEY })
        return json(connectionAnswer({ mode: 'api_key' }))
      },
    })
    const outcome = await connectSpendWithApiKey(ctx(), { provider: 'pleo', api_key: API_KEY })
    expect(outcome).toMatchObject({
      ok: true,
      created: true,
      data: {
        connection: {
          provider: 'pleo',
          mode: 'api_key',
          status: 'active',
          provider_company_name: 'Exempel AB',
          resolved_settings: { wallet_account: null, out_of_pocket_account: '2820' },
        },
      },
    })
    expect(h.db.tables.spend_connections[0]).toMatchObject({ company_id: COMPANY, connection_handle: HANDLE, status: 'active', created_by: 'user-1' })
    expect(JSON.stringify(h.db.tables)).not.toContain(API_KEY)
    if (outcome.ok && !outcome.dryRun) expect('connection_handle' in outcome.data.connection).toBe(false)
  })

  it('refuses a provider company that is another entity, and ends it at Connect without storing anything', async () => {
    const fetchImpl = connectFetch({
      '/connect-key': () => json(connectionAnswer({ mode: 'api_key', providerOrgNumber: '5560001111' })),
      '/disconnect': () => json({ disconnected: true }),
    })
    expect(await connectSpendWithApiKey(ctx(), { provider: 'pleo', api_key: API_KEY })).toEqual({ ok: false, code: 'SPEND_COMPANY_MISMATCH' })
    expect(h.db.tables.spend_connections).toHaveLength(0)
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/connect/spend/connect-key',
      '/api/connect/spend/disconnect',
    ])
  })

  it('replaces an unfinished consent attempt for the same provider', async () => {
    h.db.tables.spend_connections.push(pendingRow())
    connectFetch({ '/connect-key': () => json(connectionAnswer({ mode: 'api_key' })) })
    expect(await connectSpendWithApiKey(ctx(), { provider: 'pleo', api_key: API_KEY })).toMatchObject({ ok: true })
    expect(h.db.tables.spend_connections.map((row) => row.status)).toEqual(['active'])
  })

  it('refuses the sandbox, a missing organisation number and a live connection without calling Connect', async () => {
    const fetchImpl = connectFetch({})
    h.db.tables.company_settings[0].is_sandbox = true
    expect(await connectSpendWithApiKey(ctx(), { provider: 'pleo', api_key: API_KEY })).toEqual({ ok: false, code: 'SPEND_SANDBOX_BLOCKED' })
    h.db.tables.company_settings[0].is_sandbox = false
    h.db.tables.company_settings[0].org_number = null
    expect(await connectSpendWithApiKey(ctx(), { provider: 'pleo', api_key: API_KEY })).toEqual({ ok: false, code: 'SPEND_ORG_NUMBER_MISSING' })
    h.db.tables.company_settings[0].org_number = '556677-8899'
    h.db.tables.spend_connections.push(connectionRow())
    expect(await connectSpendWithApiKey(ctx(), { provider: 'pleo', api_key: API_KEY })).toEqual({
      ok: false,
      code: 'SPEND_ALREADY_CONNECTED',
      details: { connection_id: 'conn-1' },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('releases the new handle at Connect when another connect stored the provider first', async () => {
    const fetchImpl = connectFetch({
      '/connect-key': () => {
        // Another request finishes connecting between our check and our insert.
        h.db.tables.spend_connections.push(connectionRow({ id: 'conn-other' }))
        return json(connectionAnswer({ mode: 'api_key' }))
      },
      '/disconnect': (_body, headers) => {
        expect(headers['X-Connector-Connection']).toBe(HANDLE)
        return json({ disconnected: true })
      },
    })
    expect(await connectSpendWithApiKey(ctx(), { provider: 'pleo', api_key: API_KEY })).toEqual({ ok: false, code: 'SPEND_ALREADY_CONNECTED' })
    expect(fetchImpl.mock.calls.map((call) => new URL(call[0] as string).pathname)).toEqual([
      '/api/connect/spend/connect-key',
      '/api/connect/spend/disconnect',
    ])
    expect(h.db.tables.spend_connections.map((row) => row.id)).toEqual(['conn-other'])
  })
})

describe('disconnecting', () => {
  beforeEach(() => {
    h.db.tables.spend_connections.push(connectionRow())
  })

  it('ends the connection at Connect and here, and keeps the row', async () => {
    const fetchImpl = connectFetch({
      '/disconnect': (_body, headers) => {
        expect(headers['X-Connector-Connection']).toBe(HANDLE)
        return json({ disconnected: true })
      },
    })
    expect(await disconnectSpendConnection(ctx(), { connection_id: 'conn-1' })).toEqual({
      ok: true,
      data: { connection_id: 'conn-1', status: 'disconnected' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(h.db.tables.spend_connections[0]).toMatchObject({
      status: 'disconnected',
      connection_handle: null,
      ended_by: 'user-1',
      lease_until: new Date(0).toISOString(),
    })
    expect(h.db.tables.spend_connections[0].ended_at).toEqual(expect.any(String))
  })

  it('answers an ended connection as ended again without calling Connect', async () => {
    h.db.tables.spend_connections[0].status = 'disconnected'
    const fetchImpl = connectFetch({})
    expect(await disconnectSpendConnection(ctx(), { connection_id: 'conn-1' })).toEqual({
      ok: true,
      data: { connection_id: 'conn-1', status: 'disconnected' },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(h.db.updates).toEqual([])
  })

  it('ends locally with a warning when Connect cannot be reached', async () => {
    connectFetch({
      '/disconnect': () => {
        throw new TypeError('fetch failed')
      },
    })
    const outcome = await disconnectSpendConnection(ctx(), { connection_id: 'conn-1' })
    expect(outcome).toMatchObject({ ok: true, data: { status: 'disconnected' }, warnings: [{ code: 'SPEND_DISCONNECT_REMOTE_FAILED' }] })
    expect(h.db.tables.spend_connections[0].status).toBe('disconnected')
  })

  it("previews without calling Connect, and refuses another company's connection", async () => {
    const fetchImpl = connectFetch({})
    expect(await disconnectSpendConnection(ctx(), { connection_id: 'conn-1' }, { dryRun: true })).toEqual({
      ok: true,
      dryRun: true,
      preview: { connection_id: 'conn-1', provider_name: 'Pleo', provider_company_name: 'Exempel AB' },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await disconnectSpendConnection(ctx('company-2'), { connection_id: 'conn-1' })).toEqual({
      ok: false,
      code: 'SPEND_CONNECTION_NOT_FOUND',
      details: { connection_id: 'conn-1' },
    })
    expect(h.db.tables.spend_connections[0].status).toBe('active')
  })
})

describe('settings', () => {
  beforeEach(() => {
    h.db.tables.spend_connections.push(connectionRow({ settings: { wallet_account: '1930' } }))
    h.db.tables.spend_items.push(
      // The provider maps the wallet to 1940 while the settings say 1930: it waits for a person.
      itemRow(
        { id: 'item-review', status: 'review', reasons: [{ code: 'wallet_account_differs', params: { settings: '1930', provider: '1940' } }] },
        expenseModel({ walletAccount: '1940' }),
      ),
      itemRow({ id: 'item-booked', external_id: 'exp-2', status: 'booked', journal_entry_id: 'je-1' }, expenseModel({ externalId: 'exp-2', walletAccount: '1940' })),
      itemRow({ id: 'item-rejected', external_id: 'exp-3', status: 'rejected' }, expenseModel({ externalId: 'exp-3', walletAccount: '1940' })),
    )
  })

  it('stores the merged settings and re-evaluates the unbooked expenses only', async () => {
    const outcome = await updateSpendSettings(ctx(), { connection_id: 'conn-1', settings: { wallet_account: null } })
    expect(outcome).toEqual({
      ok: true,
      data: { connection_id: 'conn-1', settings: { wallet_account: null, out_of_pocket_account: '2820' }, reevaluated_items: 1 },
    })
    expect(h.db.tables.spend_connections[0].settings).toEqual({ wallet_account: null, out_of_pocket_account: '2820' })
    const byId = Object.fromEntries(h.db.tables.spend_items.map((row) => [row.id, row]))
    expect(byId['item-review']).toMatchObject({ status: 'ready', reasons: [] })
    expect(byId['item-booked']).toMatchObject({ status: 'booked', journal_entry_id: 'je-1' })
    expect(byId['item-rejected']).toMatchObject({ status: 'rejected' })
  })

  it('refuses an account the engine cannot book on, until the chart holds it', async () => {
    expect(await updateSpendSettings(ctx(), { connection_id: 'conn-1', settings: { wallet_account: '1949' } })).toEqual({
      ok: false,
      code: 'SPEND_SETTINGS_ACCOUNT_UNKNOWN',
      details: { accounts: ['1949'] },
    })
    // The chart is read as the member; a refusal never reaches for the service role.
    expect(h.admin).not.toHaveBeenCalled()
    h.db.tables.chart_of_accounts.push({ company_id: COMPANY, account_number: '1949', is_active: true })
    expect(await updateSpendSettings(ctx(), { connection_id: 'conn-1', settings: { wallet_account: '1949' } })).toMatchObject({ ok: true })
    // A deactivated account stays refused, BAS account or not: the engine never reactivates.
    h.db.tables.chart_of_accounts.push({ company_id: COMPANY, account_number: '2820', is_active: false })
    expect(await updateSpendSettings(ctx(), { connection_id: 'conn-1', settings: { out_of_pocket_account: '2820' } })).toEqual({
      ok: false,
      code: 'SPEND_SETTINGS_ACCOUNT_UNKNOWN',
      details: { accounts: ['2820'] },
    })
  })

  it('refuses a wallet account outside 19xx, an unknown key and an unknown connection', async () => {
    expect(await updateSpendSettings(ctx(), { connection_id: 'conn-1', settings: { wallet_account: '2820' } })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    })
    expect(await updateSpendSettings(ctx(), { connection_id: 'conn-1', settings: { auto_book: true } as never })).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    })
    expect(await updateSpendSettings(ctx(), { connection_id: 'nope', settings: {} })).toEqual({
      ok: false,
      code: 'SPEND_CONNECTION_NOT_FOUND',
      details: { connection_id: 'nope' },
    })
    expect(h.db.updates).toEqual([])
  })

  it('previews the merged settings on a dry run without the service role, and writes nothing', async () => {
    expect(await updateSpendSettings(ctx(), { connection_id: 'conn-1', settings: { out_of_pocket_account: '2893' } }, { dryRun: true })).toEqual({
      ok: true,
      dryRun: true,
      preview: { connection_id: 'conn-1', settings: { wallet_account: '1930', out_of_pocket_account: '2893' } },
    })
    expect(h.admin).not.toHaveBeenCalled()
    expect(h.db.updates).toEqual([])
  })
})

describe('reads', () => {
  it('lists live connections, ended ones on request, never with what only the server presents', async () => {
    h.db.tables.spend_connections.push(
      connectionRow(),
      connectionRow({ id: 'conn-ended', provider: 'other', status: 'disconnected', connection_handle: null, ended_at: '2026-10-10T00:00:00Z' }),
      connectionRow({ id: 'conn-pending', provider: 'third', status: 'connecting', connection_handle: null, pending_state_sha256: SHA, pending_return_origin: 'https://byra.example.se' }),
    )
    const live = await listSpendConnections(ctx())
    const all = await listSpendConnections(ctx(), { include_ended: true })
    if (!live.ok || live.dryRun || !all.ok || all.dryRun) throw new Error('expected data')
    expect(live.data.available).toBe(true)
    expect(live.data.connections.map((c) => c.id)).toEqual(['conn-1'])
    expect(all.data.connections.map((c) => c.id)).toEqual(['conn-1', 'conn-ended'])
    for (const connection of all.data.connections) {
      for (const key of ['connection_handle', 'pending_state_sha256', 'pending_expires_at', 'pending_return_origin']) {
        expect(key in connection).toBe(false)
      }
    }
    expect(live.data.connections[0].resolved_settings).toEqual({ wallet_account: '1940', out_of_pocket_account: '2820' })
  })

  it('lists expenses with numbers as numbers and lists as lists, filtered and counted per company', async () => {
    h.db.tables.spend_items.push(
      itemRow({ amount: '125.00', reasons: null, document_ids: null }),
      itemRow({ id: 'item-2', external_id: 'exp-2', status: 'review', amount: '80.50', expense_date: '2026-10-06' }),
    )
    const all = await listSpendItems(ctx(), {})
    if (!all.ok || all.dryRun) throw new Error('expected data')
    expect(all.data.total).toBe(2)
    expect(all.data.items.find((item) => item.id === 'item-1')).toMatchObject({ amount: 125, reasons: [], document_ids: [] })
    expect(await listSpendItems(ctx(), { status: 'review', from: '2026-10-06', to: '2026-10-06' })).toMatchObject({
      ok: true,
      data: { total: 1, items: [{ id: 'item-2', amount: 80.5 }] },
    })
    expect(await listSpendItems(ctx('company-2'), {})).toMatchObject({ ok: true, data: { total: 0, items: [] } })
  })

  it('answers an unknown expense as not found, also for another company', async () => {
    h.db.tables.spend_connections.push(connectionRow())
    h.db.tables.spend_items.push(itemRow())
    expect(await getSpendItem(ctx(), { item_id: 'nope' })).toEqual({ ok: false, code: 'SPEND_ITEM_NOT_FOUND', details: { item_id: 'nope' } })
    expect(await getSpendItem(ctx('company-2'), { item_id: 'item-1' })).toMatchObject({ ok: false, code: 'SPEND_ITEM_NOT_FOUND' })
  })

  it('shows a ready expense with the verifikat it books as', async () => {
    h.db.tables.spend_connections.push(connectionRow())
    h.db.tables.spend_items.push(itemRow())
    const outcome = await getSpendItem(ctx(), { item_id: 'item-1' })
    expect(outcome).toMatchObject({
      ok: true,
      data: {
        item: { id: 'item-1', amount: 125, status: 'ready' },
        connection: {
          id: 'conn-1',
          provider: 'pleo',
          provider_name: 'Pleo',
          status: 'active',
          settings: { wallet_account: '1940', out_of_pocket_account: '2820' },
        },
        description: 'Kortköp Kontorsbolaget AB (Kim Exempel), Pleo',
        reasons: [],
      },
    })
    if (!outcome.ok || outcome.dryRun) throw new Error('expected data')
    expect(outcome.data.proposal.lines).toEqual([
      { account_number: '5410', debit_amount: 100, credit_amount: 0, line_description: 'Kontorsbolaget AB' },
      { account_number: '2641', debit_amount: 25, credit_amount: 0, line_description: 'Ingående moms 25 %' },
      { account_number: '1940', debit_amount: 0, credit_amount: 125, line_description: 'Betalt med företagskort' },
    ])
    expect(h.checkPeriodLock).toHaveBeenCalledWith(h.db.client, COMPANY, '2026-10-05')
  })

  it('reads again why an expense waits, and proposes nothing for a booked one', async () => {
    h.db.tables.spend_connections.push(connectionRow())
    // Stored as ready, but no receipt came: the read says why it waits now.
    h.db.tables.spend_items.push(itemRow({ document_ids: [] }, expenseModel({ files: [] })))
    const waiting = await getSpendItem(ctx(), { item_id: 'item-1' })
    if (!waiting.ok || waiting.dryRun) throw new Error('expected data')
    expect(waiting.data.reasons.map((reason) => reason.code)).toEqual(['vat_without_receipt'])
    // Without a receipt the Swedish VAT is no deduction: the gross is the cost.
    expect(waiting.data.proposal.lines.map((line) => [line.account_number, line.debit_amount, line.credit_amount])).toEqual([
      ['5410', 125, 0],
      ['1940', 0, 125],
    ])

    h.db.tables.spend_items[0] = itemRow({ status: 'booked', journal_entry_id: 'je-1' })
    expect(await getSpendItem(ctx(), { item_id: 'item-1' })).toMatchObject({ ok: true, data: { proposal: { lines: [] }, reasons: [] } })
  })
})

describe('receiving now', () => {
  it('runs the sync for every active connection with the same Connect transport', async () => {
    h.db.tables.spend_connections.push(
      connectionRow(),
      connectionRow({ id: 'conn-2', provider: 'other' }),
      connectionRow({ id: 'conn-ended', provider: 'third', status: 'disconnected' }),
    )
    h.sync.mockImplementation(async (_db: unknown, id: string) => ({
      connectionId: id,
      status: 'synced',
      received: 1,
      rejected: 0,
      deferred: 0,
      changedAfterBooking: 0,
      masterData: 'unchanged',
    }))
    expect(await fetchSpendNow(ctx(), {})).toMatchObject({ ok: true, data: { results: [{ connectionId: 'conn-1' }, { connectionId: 'conn-2' }] } })
    expect(h.sync).toHaveBeenCalledTimes(2)
    expect(h.sync.mock.calls[0][0]).toBe(h.db.client)
    expect(h.sync.mock.calls[0][2]).toMatchObject({ connect: { config: CONFIG } })
    h.sync.mockClear()
    expect(await fetchSpendNow(ctx(), { connection_id: 'conn-2' })).toMatchObject({ ok: true, data: { results: [{ connectionId: 'conn-2' }] } })
    expect(h.sync).toHaveBeenCalledTimes(1)
  })

  it('refuses the sandbox and a company without an active connection; a dry run names the connections', async () => {
    expect(await fetchSpendNow(ctx(), {})).toEqual({ ok: false, code: 'SPEND_CONNECTION_NOT_FOUND', details: { connection_id: null } })
    h.db.tables.spend_connections.push(connectionRow())
    expect(await fetchSpendNow(ctx(), {}, { dryRun: true })).toEqual({ ok: true, dryRun: true, preview: { connection_ids: ['conn-1'] } })
    h.db.tables.company_settings[0].is_sandbox = true
    expect(await fetchSpendNow(ctx(), {})).toEqual({ ok: false, code: 'SPEND_SANDBOX_BLOCKED' })
    expect(h.sync).not.toHaveBeenCalled()
  })
})
