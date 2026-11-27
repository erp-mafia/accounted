/**
 * The browser's way back from the provider's consent page, against the real
 * service on the in-memory tables: the state lookup by hash, the binding to
 * the person who started, the completion at Connect, and where the browser
 * lands. The first fetch is only checked to be scheduled after the answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createFakeDb, type FakeDb } from '@/lib/spend/__tests__/fake-db'
import { eventBus } from '@/lib/events'

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  requireFlowInitiator: vi.fn(),
  sync: vi.fn(),
  after: [] as Array<() => void | Promise<void>>,
}))

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => h.db.client }))
vi.mock('@/lib/auth/oauth-flow-binding', () => ({ requireFlowInitiator: h.requireFlowInitiator }))
// The app and one registered brand domain are trusted; anything else lands on the app.
vi.mock('@/lib/domains/trusted-app-origin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/domains/trusted-app-origin')>()),
  resolveTrustedAppOrigin: vi.fn(async (candidate: string | null | undefined) =>
    candidate === 'https://byra.example.se' ? candidate : 'https://app.accounted.se',
  ),
}))
vi.mock('@/lib/spend/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/spend/sync')>()),
  syncSpendConnection: h.sync,
}))
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (fn: () => void | Promise<void>) => {
    h.after.push(fn)
  },
}))

import { setSpendConnectDepsForTesting, sha256Hex } from '@/lib/spend/service'
import { GET } from '../route'

const COMPANY = 'company-1'
const STATE = 's'.repeat(43)
const RESULT = 'r'.repeat(40)
const HANDLE = 'spd_' + 'h'.repeat(40)
const CONFIG = { baseUrl: 'https://connect.example.se', key: 'gnubok_ck_test_key_value_123456' }
const PROVIDER = {
  ref: 'pleo',
  displayName: 'Pleo',
  legalName: 'Pleo Technologies A/S',
  portalUrl: null,
  supportUrl: null,
  connectModes: ['oauth'],
  maxDimensions: 5,
  setupNoteSv: null,
}

const back = (query: string) => new Request(`https://app.accounted.se/api/spend/connections/return?${query}`)
const valid = () => back(`state=${STATE}&result=${RESULT}`)
const location = (response: Response) => response.headers.get('location')

function connectComplete(answer: () => Response) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).pathname).toBe('/api/connect/spend/complete')
    expect(JSON.parse(init.body as string)).toEqual({ state: STATE, result: RESULT })
    return answer()
  })
  setSpendConnectDepsForTesting({ config: CONFIG, fetch: fetchImpl as unknown as typeof fetch })
  return fetchImpl
}

function connection(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      connectionHandle: HANDLE,
      provider: PROVIDER,
      mode: 'oauth',
      providerCompanyRef: 'pleo-company-1',
      providerCompanyName: 'Exempel AB',
      providerOrgNumber: '5566778899',
      connectedAt: '2026-10-17T10:00:00Z',
      ...overrides,
    }),
    { status: 200 },
  )
}

function pending(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    company_id: COMPANY,
    provider: 'pleo',
    provider_name: 'Pleo',
    mode: 'oauth',
    status: 'connecting',
    health: 'ok',
    failures_in_row: 0,
    settings: {},
    created_by: 'user-1',
    connection_handle: null,
    pending_state_sha256: sha256Hex(STATE),
    pending_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    pending_return_origin: 'https://byra.example.se',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  h.after = []
  h.db = createFakeDb({
    company_settings: [{ company_id: COMPANY, org_number: '556677-8899' }],
    companies: [],
    spend_connections: [pending()],
  })
  h.requireFlowInitiator.mockResolvedValue({ ok: true, userId: 'user-1' })
  h.sync.mockResolvedValue({ connectionId: 'conn-1', status: 'synced', received: 0, rejected: 0, deferred: 0, changedAfterBooking: 0, masterData: 'sent' })
  setSpendConnectDepsForTesting({
    config: CONFIG,
    fetch: vi.fn(async () => {
      throw new Error('no Connect call expected')
    }) as unknown as typeof fetch,
  })
})

describe('GET /api/spend/connections/return', () => {
  it.each([
    ['no state or result', ''],
    ['a short state', `state=short&result=${RESULT}`],
    ['a short result', `state=${STATE}&result=short`],
    ['an overlong state', `state=${'s'.repeat(201)}&result=${RESULT}`],
  ])('sends %s back to the settings page as invalid', async (_name, query) => {
    const response = await GET(back(query))
    expect(response.status).toBe(307)
    expect(location(response)).toBe('https://app.accounted.se/settings/spend?spend_error=SPEND_CONNECT_INVALID')
    expect(h.requireFlowInitiator).not.toHaveBeenCalled()
    expect(h.db.tables.spend_connections[0].status).toBe('connecting')
  })

  it('answers a state nobody started, or one already used, as expired', async () => {
    h.db.tables.spend_connections[0].pending_state_sha256 = sha256Hex('another-state-0123456789')
    expect(location(await GET(valid()))).toBe('https://app.accounted.se/settings/spend?spend_error=SPEND_CONNECT_EXPIRED')
    h.db.tables.spend_connections[0] = pending({ status: 'active' })
    expect(location(await GET(valid()))).toBe('https://app.accounted.se/settings/spend?spend_error=SPEND_CONNECT_EXPIRED')
    h.db.tables.spend_connections[0] = pending({ created_by: null })
    expect(location(await GET(valid()))).toBe('https://app.accounted.se/settings/spend?spend_error=SPEND_CONNECT_EXPIRED')
    expect(h.requireFlowInitiator).not.toHaveBeenCalled()
  })

  it('refuses a browser that belongs to someone else than the person who started', async () => {
    h.requireFlowInitiator.mockResolvedValue({
      ok: false,
      reason: 'mismatch',
      sessionUserId: 'user-2',
      response: NextResponse.json({ error: { code: 'OAUTH_FLOW_INITIATOR_MISMATCH' } }, { status: 403 }),
    })
    const fetchImpl = connectComplete(() => connection())
    const response = await GET(valid())
    expect(location(response)).toBe('https://byra.example.se/settings/spend?spend_error=SPEND_CONNECT_WRONG_USER')
    expect(h.requireFlowInitiator).toHaveBeenCalledWith(expect.any(Request), 'user-1', { flow: 'spend.return', returnOrigin: 'https://byra.example.se' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(h.db.tables.spend_connections[0].status).toBe('connecting')
  })

  it('sends a browser without a session to log in first, keeping the attempt', async () => {
    h.requireFlowInitiator.mockResolvedValue({
      ok: false,
      reason: 'no_session',
      response: NextResponse.redirect('https://byra.example.se/login?next=%2Fapi%2Fspend%2Fconnections%2Freturn'),
    })
    const response = await GET(valid())
    expect(location(response)).toBe('https://byra.example.se/login?next=%2Fapi%2Fspend%2Fconnections%2Freturn')
    expect(h.db.tables.spend_connections[0].status).toBe('connecting')
  })

  it('refuses an attempt past its window without asking Connect', async () => {
    h.db.tables.spend_connections[0] = pending({ pending_expires_at: new Date(Date.now() - 1000).toISOString() })
    const fetchImpl = connectComplete(() => connection())
    expect(location(await GET(valid()))).toBe('https://byra.example.se/settings/spend?spend_error=SPEND_CONNECT_EXPIRED')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("carries a refused completion's code to the settings page", async () => {
    connectComplete(() => new Response(JSON.stringify({ error: 'x', code: 'CONNECTOR_SPEND_COMPANY_MISMATCH', retryable: false }), { status: 409 }))
    expect(location(await GET(valid()))).toBe('https://byra.example.se/settings/spend?spend_error=SPEND_COMPANY_MISMATCH')
    expect(h.db.tables.spend_connections[0].status).toBe('connecting')
    expect(h.after).toEqual([])
  })

  it('activates the connection, lands on the origin the person started on, and fetches only after the answer', async () => {
    connectComplete(() => connection())
    const response = await GET(valid())
    expect(response.status).toBe(307)
    expect(location(response)).toBe('https://byra.example.se/settings/spend?spend_connected=1')
    expect(h.db.tables.spend_connections[0]).toMatchObject({
      status: 'active',
      connection_handle: HANDLE,
      provider_company_name: 'Exempel AB',
      pending_state_sha256: null,
      pending_return_origin: null,
    })
    expect(h.sync).not.toHaveBeenCalled()
    expect(h.after).toHaveLength(1)
    await h.after[0]()
    expect(h.sync).toHaveBeenCalledWith(h.db.client, 'conn-1', expect.objectContaining({ connect: expect.objectContaining({ config: CONFIG }) }))
  })

  it('lands on the app when the stored origin is no longer a trusted one', async () => {
    h.db.tables.spend_connections[0] = pending({ pending_return_origin: 'https://gone.example.com' })
    connectComplete(() => connection())
    expect(location(await GET(valid()))).toBe('https://app.accounted.se/settings/spend?spend_connected=1')
  })

  it('still answers when the first fetch fails after it', async () => {
    connectComplete(() => connection())
    h.sync.mockRejectedValue(new Error('Connect down'))
    expect(location(await GET(valid()))).toBe('https://byra.example.se/settings/spend?spend_connected=1')
    await expect(h.after[0]()).resolves.toBeUndefined()
  })
})
