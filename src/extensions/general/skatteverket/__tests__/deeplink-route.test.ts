/**
 * POST /system-connection/deeplink: gating (capability, role, system-auth
 * mode), org-number derivation server-side, the register check that answers
 * "already appointed" instead of a link, the opt-in row it records, the
 * OmbudApiError -> 502 mapping, and Ombudshantering being down -> 503 with a
 * message that says so. POST /system-connection/verify: the same org-number
 * claim gate before any probe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The dispatcher's session check, for the 401 case below.
const mockCreateClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/server')>()),
  createClient: (...a: unknown[]) => mockCreateClient(...a),
}))

const mockRequireCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }
})

const mockCreateDeepLink = vi.fn()
vi.mock('../lib/ombud-client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, createUtseOmbudDeepLink: (...a: unknown[]) => mockCreateDeepLink(...a) }
})

const mockProbeCompanyGrants = vi.fn()
vi.mock('../lib/grant-probe', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, probeCompanyGrants: (...a: unknown[]) => mockProbeCompanyGrants(...a) }
})

const mockRecordProbeResult = vi.fn()
const mockGetConnection = vi.fn(async (): Promise<unknown> => null)
const mockStanding = vi.fn(async (_companyId: string, _orgNumber: string): Promise<string> => 'clear')
vi.mock('../lib/connection-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    recordProbeResult: (...a: unknown[]) => mockRecordProbeResult(...a),
    getConnection: () => mockGetConnection(),
    getOmbudClaimStanding: (companyId: string, orgNumber: string) => mockStanding(companyId, orgNumber),
  }
})

const mockWriteAudit = vi.fn()
vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: (...a: unknown[]) => mockWriteAudit(...a) }))

import { skatteverketExtension } from '../index'
import { OmbudApiError } from '../lib/ombud-client'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse, testRoutes } from '@/tests/helpers'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { extensionRegistry } from '@/lib/extensions/registry'
import { POST as dispatch } from '@/app/api/extensions/ext/[...path]/route'

const ENV_KEYS = ['SKATTEVERKET_SYSTEM_AUTH_MODE', 'SKATTEVERKET_SYSTEM_AUTH_MECHANISM', 'SKATTEVERKET_ENABLED']
let savedEnv: Record<string, string | undefined>

function findRoute(path = '/system-connection/deeplink') {
  const route = testRoutes(skatteverketExtension).find((r) => r.method === 'POST' && r.path === path)
  if (!route) throw new Error(`${path} route not registered`)
  return route
}

/** Supabase stub: company_members role lookup, then company_settings org number. */
function makeContext(opts: { role?: string; orgNumber?: string | null } = {}): ExtensionContext {
  const role = opts.role ?? 'owner'
  const orgNumber = opts.orgNumber === undefined ? '556000-0000' : opts.orgNumber
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = vi.fn(self)
    if (table === 'company_members') {
      chain.single = vi.fn(async () => ({ data: { role }, error: null }))
      chain.maybeSingle = vi.fn(async () => ({ data: { role }, error: null }))
    } else if (table === 'company_settings') {
      chain.single = vi.fn(async () => ({
        data: orgNumber ? { org_number: orgNumber, entity_type: 'aktiebolag' } : { org_number: null, entity_type: 'aktiebolag' },
        error: null,
      }))
      chain.maybeSingle = chain.single
    } else {
      chain.single = vi.fn(async () => ({ data: null, error: null }))
      chain.maybeSingle = chain.single
    }
    return chain
  })
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from } as any,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const request = () =>
  new Request('http://localhost/api/extensions/ext/skatteverket/system-connection/deeplink', { method: 'POST' })

beforeEach(() => {
  vi.clearAllMocks()
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'on'
  process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM = 'stub'
  mockRequireCapability.mockResolvedValue(null)
  mockRecordProbeResult.mockResolvedValue({ id: 'conn-1', status: 'pending' })
  mockStanding.mockResolvedValue('clear')
  mockGetConnection.mockResolvedValue(null)
  // The register lists nothing for the company yet: the link is handed out.
  mockProbeCompanyGrants.mockResolvedValue({
    connection: { id: 'conn-1', status: 'pending', lasombud_status: 'denied', moms_ombud_status: 'denied' },
    lasombud: { status: 'denied' },
    momsOmbud: { status: 'denied' },
  })
  mockWriteAudit.mockResolvedValue(undefined)
  mockCreateDeepLink.mockResolvedValue({
    djuplank: 'https://sso.skatteverket.se/ombud?x=1',
    roller: { lasombud: 'skol', moms_ombud: 'momsdeklaration_ombud' },
    expiresOn: '2026-09-22',
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('POST /system-connection/deeplink', () => {

  it('refuses when the capability gate blocks', async () => {
    const { NextResponse } = await import('next/server')
    mockRequireCapability.mockResolvedValue(NextResponse.json({ error: 'capability_blocked' }, { status: 403 }))
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(403)
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
  })

  it('refuses a viewer (AGI write role required)', async () => {
    const res = await findRoute().handler(request(), makeContext({ role: 'viewer' }))
    expect(res.status).toBe(403)
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
  })

  it('503 while system auth is off', async () => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'off'
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(503)
  })

  it('400 when the company has no org number', async () => {
    const res = await findRoute().handler(request(), makeContext({ orgNumber: null }))
    expect(res.status).toBe(400)
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
  })

  it('422 with the way out when the number does not fit the form: no link, no row', async () => {
    const res = await findRoute().handler(request(), makeContext({ orgNumber: '198003740118' }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe('FILING_IDENTITY_REFUSED')
    expect(body.error).toMatch(/kontakta supporten/)
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('mints the link for the company\'s own 12-digit org number, records the opt-in row, audits', async () => {
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: {
        djuplank: 'https://sso.skatteverket.se/ombud?x=1',
        roller: { lasombud: 'skol', moms_ombud: 'momsdeklaration_ombud' },
        expires_on: '2026-09-22',
      },
    })
    // The deep-link call is audited by the transport against the caller.
    expect(mockCreateDeepLink).toHaveBeenCalledWith(
      '165560000000',
      { companyId: 'company-1', userId: 'user-1' },
      ['lasombud', 'moms_ombud'],
    )
    // A new link is a new wait: a grant Skatteverket withdrew is awaited again.
    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', orgNumber: '165560000000', createdBy: 'user-1', error: null, reopened: true })
    )
    // No grant state is asserted by minting a link.
    expect(mockRecordProbeResult.mock.calls[0][0]).not.toHaveProperty('lasombud')
    // No route-level row on top of the transport's.
    expect(mockWriteAudit).not.toHaveBeenCalled()
  })

  it('409 ORG_NUMBER_CONTESTED when other live companies claim the number and no member here proved it: no link, no row, and the way out', async () => {
    mockStanding.mockResolvedValue('unproven')
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ORG_NUMBER_CONTESTED')
    expect(getErrorMessage(body, { locale: 'sv' })).toMatch(/Anslut det här företaget till Skatteverket med BankID.*försök sedan igen/)
    expect(getErrorMessage(body, { locale: 'sv' })).not.toMatch(/[Kk]ontakta support/)
    expect(getErrorMessage(body, { locale: 'en' })).toMatch(/Connect this company to Skatteverket with BankID.*then try again/)
    expect(mockStanding).toHaveBeenCalledWith('company-1', '165560000000')
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
    // The register is never asked on a number the company has not proven.
    expect(mockProbeCompanyGrants).not.toHaveBeenCalled()
  })

  it('409 ORG_NUMBER_PROVEN_TWICE when another claimant is proven too: no link, no row', async () => {
    mockStanding.mockResolvedValue('proven_twice')
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ORG_NUMBER_PROVEN_TWICE')
    expect(getErrorMessage(body, { locale: 'sv' })).toMatch(/Arkivera de andra företagen/)
    expect(mockProbeCompanyGrants).not.toHaveBeenCalled()
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('a failed proof read hands out no link', async () => {
    mockStanding.mockRejectedValue(new Error('ownership proof read failed: timeout'))
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('500 when the opt-in row cannot be stored: the link is not handed out', async () => {
    mockRecordProbeResult.mockResolvedValue(null)
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(500)
  })

  it('502 with the error code when the register refuses', async () => {
    mockCreateDeepLink.mockRejectedValue(new OmbudApiError('Ombudshantering svarade 400', 'OBR_HTTP_ERROR', 400))
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'OBR_HTTP_ERROR' })
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('Ombudshantering down (503): 503, and the person reads that Skatteverket\'s service is unavailable and to try again in a while', async () => {
    // The answer prod got on 2026-11-14, which the page showed as "Något gick fel. Försök igen."
    mockCreateDeepLink.mockRejectedValue(
      new OmbudApiError('Ombudshantering svarade 503 (djuplank/utseombud): {\n  "message": "Service Unavailable"\n}', 'OBR_HTTP_ERROR', 503),
    )
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('SKATTEVERKET_OMBUD_UNAVAILABLE')
    expect(getErrorMessage(body, { locale: 'sv' })).toBe(
      'Skatteverkets ombudstjänst är inte tillgänglig just nu. Försök igen om en stund.',
    )
    expect(getErrorMessage(body, { locale: 'en' })).toBe(
      "Skatteverket's ombud service is unavailable right now. Try again in a while.",
    )
    expect(JSON.stringify(body)).not.toContain('Service Unavailable')
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it.each([
    ['a 502', new OmbudApiError('Ombudshantering svarade 502 (djuplank/utseombud)', 'OBR_HTTP_ERROR', 502)],
    ['a 504', new OmbudApiError('Ombudshantering svarade 504 (djuplank/utseombud)', 'OBR_HTTP_ERROR', 504)],
    ['no answer within the timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['no connection at all', new TypeError('fetch failed')],
  ])('%s reads the same', async (_case, failure) => {
    mockCreateDeepLink.mockRejectedValue(failure)
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('SKATTEVERKET_OMBUD_UNAVAILABLE')
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('a 500 is not read as the service being down: the 502 with its code, as before', async () => {
    mockCreateDeepLink.mockRejectedValue(new OmbudApiError('Ombudshantering svarade 500 (djuplank/utseombud)', 'OBR_HTTP_ERROR', 500))
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'OBR_HTTP_ERROR' })
  })
})

describe('POST /system-connection/deeplink: the register is asked first', () => {
  const verified = {
    id: 'conn-1',
    org_number: '165560000000',
    status: 'verified',
    lasombud_status: 'granted',
    moms_ombud_status: 'granted',
    lasombud_checked_at: null as string | null,
  }

  it('already appointed with both roles (directly at Skatteverket, say): Klart, no link, no new opt-in', async () => {
    mockProbeCompanyGrants.mockResolvedValue({
      connection: verified,
      lasombud: { status: 'granted' },
      momsOmbud: { status: 'granted' },
    })
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { already_appointed: true, connection: verified } })
    // The same probe verify runs, for the company's own number and caller.
    expect(mockProbeCompanyGrants).toHaveBeenCalledWith('company-1', '165560000000', 'user-1')
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })

  it('nothing granted: the link, as before', async () => {
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.djuplank).toBe('https://sso.skatteverket.se/ombud?x=1')
    expect(body.data).not.toHaveProperty('already_appointed')
    expect(mockProbeCompanyGrants).toHaveBeenCalledTimes(1)
    expect(mockCreateDeepLink).toHaveBeenCalledTimes(1)
  })

  it('one role granted, the other missing: the link, for both roles', async () => {
    mockProbeCompanyGrants.mockResolvedValue({
      connection: { ...verified, status: 'partial', moms_ombud_status: 'denied' },
      lasombud: { status: 'granted' },
      momsOmbud: { status: 'denied' },
    })
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(200)
    expect((await res.json()).data.djuplank).toBe('https://sso.skatteverket.se/ombud?x=1')
    expect(mockCreateDeepLink).toHaveBeenCalledWith('165560000000', expect.anything(), ['lasombud', 'moms_ombud'])
  })

  it('probed within the last minute: the stored answer decides, the register is not asked again', async () => {
    mockGetConnection.mockResolvedValue({ ...verified, lasombud_checked_at: new Date(Date.now() - 20_000).toISOString() })
    const res = await findRoute().handler(request(), makeContext())
    expect((await res.json()).data.already_appointed).toBe(true)
    expect(mockProbeCompanyGrants).not.toHaveBeenCalled()
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
  })

  it('a stored answer for another org number is never reused', async () => {
    mockGetConnection.mockResolvedValue({
      ...verified,
      org_number: '165599999999',
      lasombud_checked_at: new Date(Date.now() - 20_000).toISOString(),
    })
    const res = await findRoute().handler(request(), makeContext())
    expect((await res.json()).data.djuplank).toBe('https://sso.skatteverket.se/ombud?x=1')
    expect(mockProbeCompanyGrants).toHaveBeenCalledTimes(1)
  })

  it('a grant signed before the opt-in is not accepted: the link, so the company signs again', async () => {
    mockProbeCompanyGrants.mockResolvedValue({
      connection: {
        ...verified,
        status: 'pending',
        lasombud_status: 'denied',
        moms_ombud_status: 'denied',
        last_probe_detail: {
          lasombud: { status: 'denied', reason: 'predates_opt_in' },
          moms_ombud: { status: 'denied', reason: 'predates_opt_in' },
        },
      },
      lasombud: { status: 'denied', reason: 'predates_opt_in' },
      momsOmbud: { status: 'denied', reason: 'predates_opt_in' },
    })
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.djuplank).toBe('https://sso.skatteverket.se/ombud?x=1')
    expect(body.data).not.toHaveProperty('already_appointed')
    expect(mockRecordProbeResult).toHaveBeenCalledWith(expect.objectContaining({ reopened: true }))
  })

  it('a check that fails hands out the link instead of an error', async () => {
    mockProbeCompanyGrants.mockRejectedValue(new Error('skatteverket_company_connections read failed: timeout'))
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(200)
    expect((await res.json()).data.djuplank).toBe('https://sso.skatteverket.se/ombud?x=1')
  })
})

describe('POST /system-connection/deeplink through the extension dispatcher', () => {
  beforeEach(() => {
    process.env.SKATTEVERKET_ENABLED = 'true'
    extensionRegistry.clear()
    extensionRegistry.register(skatteverketExtension)
  })
  afterEach(() => extensionRegistry.clear())

  it('401 without a session: the register is not asked and no link is minted', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'Not authenticated' } })
    mockCreateClient.mockResolvedValue(supabase)

    const response = await dispatch(
      createMockRequest('/api/extensions/ext/skatteverket/system-connection/deeplink', { method: 'POST' }),
      { params: Promise.resolve({ path: ['skatteverket', 'system-connection', 'deeplink'] }) },
    )
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(mockProbeCompanyGrants).not.toHaveBeenCalled()
    expect(mockCreateDeepLink).not.toHaveBeenCalled()
  })
})

describe('POST /system-connection/verify: the org-number claim', () => {
  const verify = () =>
    findRoute('/system-connection/verify').handler(
      new Request('http://localhost/api/extensions/ext/skatteverket/system-connection/verify', { method: 'POST' }),
      makeContext(),
    )

  it('409 ORG_NUMBER_CONTESTED for an unproven claimant: the register is never asked', async () => {
    mockStanding.mockResolvedValue('unproven')
    const res = await verify()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('ORG_NUMBER_CONTESTED')
    expect(mockStanding).toHaveBeenCalledWith('company-1', '165560000000')
    expect(mockProbeCompanyGrants).not.toHaveBeenCalled()
  })

  it('409 ORG_NUMBER_PROVEN_TWICE when two claimants are proven', async () => {
    mockStanding.mockResolvedValue('proven_twice')
    const res = await verify()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('ORG_NUMBER_PROVEN_TWICE')
    expect(mockProbeCompanyGrants).not.toHaveBeenCalled()
  })

  it('a clear claim (sole claimant, or the one proven) is probed', async () => {
    const res = await verify()
    expect(res.status).toBe(200)
    expect(mockProbeCompanyGrants).toHaveBeenCalledWith('company-1', '165560000000', 'user-1')
  })
})

describe('POST /system-connection/verify: one check a minute', () => {
  const verify = () =>
    findRoute('/system-connection/verify').handler(
      new Request('http://localhost/api/extensions/ext/skatteverket/system-connection/verify', { method: 'POST' }),
      makeContext(),
    )
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  it('429 when the register was asked within the minute', async () => {
    // One clock read for both stamps: read apart, a millisecond can tick
    // between them, and a later last_probe_at reads as a link minted since.
    const checkedAt = ago(20_000)
    mockGetConnection.mockResolvedValue({ id: 'conn-1', lasombud_checked_at: checkedAt, last_probe_at: checkedAt })
    const res = await verify()
    expect(res.status).toBe(429)
    expect(mockProbeCompanyGrants).not.toHaveBeenCalled()
  })

  it('the 429 names the wait that is left of the minute, in the body and in Retry-After', async () => {
    const checkedAt = ago(20_000)
    mockGetConnection.mockResolvedValue({ id: 'conn-1', lasombud_checked_at: checkedAt, last_probe_at: checkedAt })
    const res = await verify()
    expect(res.status).toBe(429)
    const body = (await res.json()) as { retry_after_seconds: number }
    expect(body.retry_after_seconds).toBeGreaterThanOrEqual(39)
    expect(body.retry_after_seconds).toBeLessThanOrEqual(40)
    expect(res.headers.get('Retry-After')).toBe(String(body.retry_after_seconds))
  })

  it('back from signing within the minute: the appoint button checked, then minted the link, so the check runs', async () => {
    mockGetConnection.mockResolvedValue({ id: 'conn-1', lasombud_checked_at: ago(20_000), last_probe_at: ago(19_900) })
    const res = await verify()
    expect(res.status).toBe(200)
    expect(mockProbeCompanyGrants).toHaveBeenCalledTimes(1)
  })
})
