/**
 * /api/settings/collections/* through the real withRouteContext, the real
 * connection service and the fake adapter, over an in-memory database:
 * 401 without a session, 400 on a bad body, 403 for a member and for a
 * company without the paid capability, 404 without a connection, 503 with
 * the kill switch off, and each happy path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFakeCollectionsAdapter, createFakeCollectionsStore } from '@/lib/collections/adapters/fake'
import type { CollectionsAdapter } from '@/lib/collections/port'
import {
  ADMIN_ID,
  CASH_ACCOUNT_ID,
  COMPANY_ID,
  createMemorySupabase,
  seedCompany,
  type MemorySupabase,
} from '@/lib/collections/__tests__/memory-supabase'

let db: MemorySupabase
let adapter: CollectionsAdapter

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111') }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => db.client, createClient: async () => db.client }))
const hasCapabilityMock = vi.fn()
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...args),
}))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: vi.fn().mockResolvedValue(false) }))
vi.mock('@/lib/collections/adapters', () => ({ collectionsAdapterFor: () => adapter, ensureCollectionsAdapters: () => {} }))
vi.mock('@/lib/domains/trusted-app-origin', () => ({ resolveRequestAppOrigin: vi.fn().mockResolvedValue('https://app.test') }))

import { GET, PATCH } from '../route'
import { POST as CONSENT } from '../consent/route'
import { POST as ONBOARDING } from '../onboarding/route'
import { POST as TERMS } from '../terms/route'
import { POST as SIGNATURE } from '../signature/route'
import { POST as REFRESH } from '../refresh/route'
import { POST as CANCEL } from '../cancel/route'
import { POST as DISCONNECT } from '../disconnect/route'

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T
}

type Handler = (request: Request, params: { params: Promise<Record<string, never>> }) => Promise<Response>

const ENV_KEYS = ['COLLECTIONS_ENABLED', 'COLLECTIONS_PILOT_COMPANIES', 'COLLECTIONS_LADDER_ENABLED', 'COLLECTIONS_DELIVERY_ENABLED', 'COLLECTIONS_FAKE_ADAPTER', 'GNUBOK_CONNECTOR_KEY'] as const

function switchOn(extra: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  vi.stubEnv('COLLECTIONS_ENABLED', '1')
  vi.stubEnv('COLLECTIONS_PILOT_COMPANIES', COMPANY_ID)
  vi.stubEnv('COLLECTIONS_FAKE_ADAPTER', '1')
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v)
}

function call(handler: Handler, method: string, body?: unknown): Promise<Response> {
  return handler(
    new Request('http://localhost/api/settings/collections', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  )
}

const CONSENT_BODY = { termsVersion: 'fake-2026-10', dpaVersion: null, acceptTerms: true, acceptDataSharing: true }
const ONBOARDING_BODY = {
  company: {
    name: 'Test AB',
    addressLine1: 'Storgatan 1',
    addressLine2: null,
    postalCode: '111 22',
    city: 'Stockholm',
    email: 'faktura@test.se',
    phone: null,
    vatRegistered: true,
    vatNumber: 'SE556012579001',
    ownerPersonalNumber: null,
    payout: { cashAccountId: CASH_ACCOUNT_ID, kind: 'bankgiro' },
  },
  kyc: {
    businessDescription: 'IT-konsult',
    invoicesAbroad: false,
    invoicesAbroadDescription: null,
    pep: false,
    pepDescription: null,
    sanctions: false,
    sanctionsDescription: null,
  },
  rules: { minimumAmount: 100, defaultStartStep: 'reminder', reminderFeeTermsSince: null, lateInterest: null, ladderMode: 'off' },
}

interface ConnectionBody {
  data: { connection: { state: string; subStatus: string | null; onboarded: boolean } | null; signUrl?: string | null }
}
interface ErrorBody {
  error: { code: string; message: string } | string
  type?: string
  errors?: { field: string; message: string }[]
}

async function activate(): Promise<void> {
  expect((await call(CONSENT, 'POST', CONSENT_BODY)).status).toBe(200)
  expect((await call(ONBOARDING, 'POST', ONBOARDING_BODY)).status).toBe(200)
  expect((await call(SIGNATURE, 'POST', { sendToSigner: false, signerEmail: null, language: 'sv' })).status).toBe(200)
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of ENV_KEYS) vi.stubEnv(k, '')
  db = createMemorySupabase()
  seedCompany(db)
  adapter = createFakeCollectionsAdapter({ store: createFakeCollectionsStore() })
  requireAuthMock.mockResolvedValue({
    user: { id: ADMIN_ID, email: 'ada@test.se', user_metadata: { full_name: 'Ada Admin' }, is_anonymous: false },
    supabase: db.client,
    error: null,
  })
  hasCapabilityMock.mockResolvedValue(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('authentication and roles', () => {
  it('answers 401 without a session, on every route', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    for (const [handler, method] of [
      [GET, 'GET'],
      [PATCH, 'PATCH'],
      [CONSENT, 'POST'],
      [ONBOARDING, 'POST'],
      [TERMS, 'POST'],
      [SIGNATURE, 'POST'],
      [REFRESH, 'POST'],
      [CANCEL, 'POST'],
      [DISCONNECT, 'POST'],
    ] as const) {
      expect((await call(handler as Handler, method, method === 'GET' ? undefined : {})).status).toBe(401)
    }
  })

  it('lets a member read the status but change nothing (403)', async () => {
    switchOn()
    db.rpcs.set('user_is_company_admin', () => false)
    const res = await call(GET, 'GET')
    expect(res.status).toBe(200)
    const body = await json<{ data: { canManage: boolean; activation: unknown } }>(res)
    expect(body.data).toMatchObject({ canManage: false, activation: null })
    for (const handler of [CONSENT, ONBOARDING, TERMS, SIGNATURE, REFRESH, CANCEL, DISCONNECT]) {
      expect((await call(handler, 'POST', {})).status).toBe(403)
    }
    expect((await call(PATCH, 'PATCH', { minimumAmount: 1 })).status).toBe(403)
  })
})

describe('GET /api/settings/collections', () => {
  it('shows nothing on a dark installation and reads no provider', async () => {
    const res = await call(GET, 'GET')
    expect(res.status).toBe(200)
    const body = await json<{ data: { availability: { start: string }; connection: null; provider: null; activation: null } }>(res)
    expect(body.data).toMatchObject({ availability: { start: 'hidden' }, connection: null, provider: null, activation: null })
  })

  it('gives an admin the provider\'s terms and the form prefilled from the company', async () => {
    switchOn()
    const body = await json<{
      data: {
        availability: { start: string; sandbox: boolean }
        provider: { profile: { displayName: string; termsVersion: string } }
        activation: { company: { orgNumber: string; soleTrader: boolean }; payoutOptions: { number: string }[]; defaultPayoutCashAccountId: string }
      }
    }>(await call(GET, 'GET'))
    expect(body.data.availability.start).toBe('activate')
    expect(body.data.provider.profile).toMatchObject({ displayName: 'Acme Inkasso', termsVersion: 'fake-2026-10' })
    expect(body.data.activation.company).toMatchObject({ orgNumber: '5560125790', soleTrader: false })
    expect(body.data.activation.payoutOptions.map((o) => o.number)).toEqual(['1234567', '8327-9123456789'])
    expect(body.data.activation.defaultPayoutCashAccountId).toBe(CASH_ACCOUNT_ID)
  })

  it('never returns the provider\'s handle', async () => {
    switchOn()
    await activate()
    const text = await (await call(GET, 'GET')).text()
    expect(text).not.toContain('connection_handle')
    expect(text).not.toContain('fake-connection-')
  })
})

describe('start gates on the activation routes', () => {
  it('answers 503 COLLECTIONS_DISABLED with the kill switch off', async () => {
    for (const [handler, body] of [
      [CONSENT, CONSENT_BODY],
      [ONBOARDING, ONBOARDING_BODY],
      [TERMS, { termsVersion: 'v', accept: true }],
      [SIGNATURE, { sendToSigner: false, signerEmail: null }],
    ] as const) {
      const res = await call(handler, 'POST', body)
      expect(res.status).toBe(503)
      expect(((await json<ErrorBody>(res)).error as { code: string }).code).toBe('COLLECTIONS_DISABLED')
    }
  })

  it('answers the paywall 403 without the paid capability', async () => {
    switchOn()
    hasCapabilityMock.mockResolvedValue(false)
    const res = await call(CONSENT, 'POST', CONSENT_BODY)
    expect(res.status).toBe(403)
    // The paywall's own envelope, so the page shows its UpgradeNote.
    expect(await json(res)).toMatchObject({ capability_blocked: true, capability: 'collections' })
  })
})

describe('the activation', () => {
  it('consents, applies, signs and reaches active', async () => {
    switchOn()
    const consent = await json<ConnectionBody>(await call(CONSENT, 'POST', CONSENT_BODY))
    expect(consent.data.connection).toMatchObject({ state: 'connecting', subStatus: 'not_started', onboarded: false })

    const applied = await json<ConnectionBody>(await call(ONBOARDING, 'POST', ONBOARDING_BODY))
    expect(applied.data.connection).toMatchObject({ state: 'connecting', subStatus: 'awaiting_signature', onboarded: true })

    const signed = await json<ConnectionBody>(await call(SIGNATURE, 'POST', { sendToSigner: true, signerEmail: 'vd@test.se' }))
    expect(signed.data.signUrl).toBeNull()
    expect(signed.data.connection).toMatchObject({ state: 'active' })

    const refreshed = await json<ConnectionBody>(await call(REFRESH, 'POST'))
    expect(refreshed.data.connection).toMatchObject({ state: 'active' })
  })

  it('answers 400 on a malformed body and on field errors', async () => {
    switchOn()
    expect((await call(CONSENT, 'POST', { termsVersion: 'fake-2026-10', acceptTerms: false })).status).toBe(400)
    await call(CONSENT, 'POST', CONSENT_BODY)
    expect((await call(ONBOARDING, 'POST', { company: {} })).status).toBe(400)
    const res = await call(ONBOARDING, 'POST', { ...ONBOARDING_BODY, company: { ...ONBOARDING_BODY.company, postalCode: '12' } })
    expect(res.status).toBe(400)
    const body = await json<ErrorBody>(res)
    expect(body.type).toBe('validation_error')
    expect(body.errors).toEqual([{ field: 'company.postalCode', message: 'invalid_postal_code', code: 'custom' }])
    expect((await call(SIGNATURE, 'POST', { sendToSigner: true, signerEmail: null })).status).toBe(400)
    expect((await call(PATCH, 'PATCH', {})).status).toBe(400)
  })

  it('answers 404 without a connection', async () => {
    switchOn()
    for (const [handler, body] of [
      [ONBOARDING, ONBOARDING_BODY],
      [TERMS, { termsVersion: 'v', accept: true }],
      [SIGNATURE, { sendToSigner: false, signerEmail: null }],
      [REFRESH, undefined],
      [CANCEL, undefined],
      [DISCONNECT, undefined],
    ] as const) {
      const res = await call(handler, 'POST', body)
      expect(res.status).toBe(404)
      expect(((await json<ErrorBody>(res)).error as { code: string }).code).toBe('COLLECTIONS_CONNECTION_NOT_FOUND')
    }
    expect((await call(PATCH, 'PATCH', { minimumAmount: 50 })).status).toBe(404)
  })

  it('answers 409 for a second consent and for a step out of order', async () => {
    switchOn()
    await call(CONSENT, 'POST', CONSENT_BODY)
    expect((await call(CONSENT, 'POST', CONSENT_BODY)).status).toBe(409)
    const res = await call(TERMS, 'POST', { termsVersion: 'fake-2026-10', accept: true })
    expect(res.status).toBe(409)
    expect(((await json<ErrorBody>(res)).error as { code: string }).code).toBe('COLLECTIONS_CONNECTION_STEP')
  })
})

describe('obligation routes keep working with the start gates closed', () => {
  it('refreshes, changes rules and disconnects after the kill switch went off', async () => {
    switchOn()
    await activate()
    vi.stubEnv('COLLECTIONS_ENABLED', '')
    expect((await call(REFRESH, 'POST')).status).toBe(200)
    const patched = await call(PATCH, 'PATCH', { minimumAmount: 400, defaultStartStep: 'collection' })
    expect(patched.status).toBe(200)
    expect((await call(DISCONNECT, 'POST')).status).toBe(200)
    expect(db.rows('collection_connections')[0]).toMatchObject({ state: 'disconnected', minimum_amount: 400, ended_by: ADMIN_ID })
  })

  it('cancels an activation with the kill switch off', async () => {
    switchOn()
    await call(CONSENT, 'POST', CONSENT_BODY)
    vi.stubEnv('COLLECTIONS_ENABLED', '')
    const res = await call(CANCEL, 'POST')
    expect(res.status).toBe(200)
    expect((await json<ConnectionBody>(res)).data.connection).toMatchObject({ state: 'disconnected' })
  })

  it('refuses to disconnect with open work (409)', async () => {
    switchOn()
    await activate()
    db.rpcs.set('collection_obligation_counts', () => [{ open_cases: 2, unbooked_collected_payments: 0, unbooked_settlements: 0 }])
    const res = await call(DISCONNECT, 'POST')
    expect(res.status).toBe(409)
    expect(((await json<ErrorBody>(res)).error as { code: string }).code).toBe('COLLECTIONS_DISCONNECT_BLOCKED')
  })
})

describe('PATCH /api/settings/collections', () => {
  it('turns delivery on only behind its flag', async () => {
    switchOn()
    await activate()
    const refused = await call(PATCH, 'PATCH', { distributionEnabled: true })
    expect(refused.status).toBe(503)
    vi.stubEnv('COLLECTIONS_DELIVERY_ENABLED', '1')
    const allowed = await call(PATCH, 'PATCH', { distributionEnabled: true })
    expect(allowed.status).toBe(200)
    expect(db.rows('collection_connections')[0]).toMatchObject({ distribution_enabled: true })
    // Turning it off again stops work: never gated.
    vi.stubEnv('COLLECTIONS_DELIVERY_ENABLED', '')
    expect((await call(PATCH, 'PATCH', { distributionEnabled: false })).status).toBe(200)
  })
})
