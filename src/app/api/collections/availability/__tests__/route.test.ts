/**
 * GET /api/collections/availability through the real withRouteContext:
 * 401 without a session, the dark answer with nothing configured, and the
 * provider read from the catalogue once the company may start work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { catalogueResponse } from '../../../../../../packages/connect-contract/src/__tests__/fixtures'
import { __resetCatalogueCacheForTests } from '@/lib/collections/catalogue'

const COMPANY = '11111111-1111-4111-8111-111111111111'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111') }))
const hasCapabilityMock = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: (...args: unknown[]) => hasCapabilityMock(...args) }))
const isSandboxMock = vi.fn()
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: (...args: unknown[]) => isSandboxMock(...args) }))

import { GET } from '../route'

const ENV = [
  'COLLECTIONS_ENABLED',
  'COLLECTIONS_PILOT_COMPANIES',
  'COLLECTIONS_LADDER_ENABLED',
  'COLLECTIONS_DELIVERY_ENABLED',
  'COLLECTIONS_FAKE_ADAPTER',
  'GNUBOK_CONNECTOR_KEY',
  'GNUBOK_CONNECT_URL',
] as const

const fetchMock = vi.fn()
const db = createTableMockSupabase()
const NO_OBLIGATIONS = { data: [{ open_cases: 0, unbooked_collected_payments: 0, unbooked_settlements: 0 }] }

beforeEach(() => {
  vi.clearAllMocks()
  __resetCatalogueCacheForTests()
  for (const k of ENV) vi.stubEnv(k, '')
  vi.stubGlobal('fetch', fetchMock)
  db.reset()
  db.setTable('collection_connections', { data: null })
  db.setTable('rpc:collection_obligation_counts', NO_OBLIGATIONS)
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', is_anonymous: false }, supabase: db.supabase, error: null })
  hasCapabilityMock.mockResolvedValue(false)
  isSandboxMock.mockResolvedValue(false)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const call = () => GET(new Request('http://localhost/api/collections/availability'), { params: Promise.resolve({}) })

interface Body {
  data: {
    enabled: boolean
    pilot: boolean
    capability: boolean
    start: string
    provider: { displayName: string } | null
    displayName: string | null
  }
}

describe('GET /api/collections/availability', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    const res = await call()
    expect(res.status).toBe(401)
    expect(hasCapabilityMock).not.toHaveBeenCalled()
  })

  it('answers dark with nothing configured, without calling Connect', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    const res = await call()
    const { status, body } = await parseJsonResponse<Body>(res)
    expect(status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(body.data).toMatchObject({ enabled: false, pilot: false, capability: false, start: 'hidden', provider: null, displayName: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks the paid capability for collections', async () => {
    await call()
    expect(hasCapabilityMock).toHaveBeenCalledWith(expect.anything(), COMPANY, 'collections')
  })

  it('shows the upgrade note to a pilot company without the capability, with the provider from the catalogue', async () => {
    vi.stubEnv('COLLECTIONS_ENABLED', '1')
    vi.stubEnv('COLLECTIONS_PILOT_COMPANIES', COMPANY)
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    fetchMock.mockResolvedValue(new Response(JSON.stringify(catalogueResponse), { status: 200 }))
    const { body } = await parseJsonResponse<Body>(await call())
    expect(body.data).toMatchObject({ enabled: true, pilot: true, capability: false, start: 'upgrade', displayName: 'Acme Inkasso' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://connect.accounted.se/api/connect/catalogue')
  })

  it('asks a paying pilot company to activate, and survives the catalogue being down', async () => {
    vi.stubEnv('COLLECTIONS_ENABLED', 'true')
    vi.stubEnv('COLLECTIONS_PILOT_COMPANIES', '*')
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    hasCapabilityMock.mockResolvedValue(true)
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const { status, body } = await parseJsonResponse<Body>(await call())
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ capability: true, start: 'activate', provider: null, displayName: null })
  })

  it('keeps showing the connection and its open work with every start gate closed', async () => {
    db.setTable('collection_connections', {
      data: {
        route: 'connect',
        state: 'active',
        sub_status: null,
        health: 'ok',
        distribution_enabled: false,
        ladder_mode: 'off',
        display_name: 'Persisted Name',
        minimum_amount: 100,
        late_interest_percent: null,
        ladder_days_after_due: 10,
        failures_in_row: 0,
      },
    })
    db.setTable('rpc:collection_obligation_counts', { data: [{ open_cases: 1, unbooked_collected_payments: 0, unbooked_settlements: 0 }] })
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const { body } = await parseJsonResponse<Body & { data: { obligations: boolean; connection: { state: string } } }>(await call())
    expect(body.data).toMatchObject({ start: 'hidden', obligations: true, connection: { state: 'active' }, displayName: 'Persisted Name' })
    expect(db.findCall('rpc:collection_obligation_counts', 'rpc')).toEqual([{ p_company_id: COMPANY }])
  })
})
