/**
 * POST /system-connection/deeplink: gating (capability, role, system-auth
 * mode), org-number derivation server-side, the opt-in row it records, and
 * the OmbudApiError -> 502 mapping. POST /system-connection/verify: the same
 * org-number claim gate before any probe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
const mockGetConnection = vi.fn(async () => null)
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
import { testRoutes } from '@/tests/helpers'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const ENV_KEYS = ['SKATTEVERKET_SYSTEM_AUTH_MODE', 'SKATTEVERKET_SYSTEM_AUTH_MECHANISM']
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
  mockProbeCompanyGrants.mockResolvedValue({
    connection: { id: 'conn-1', lasombud_status: 'granted' },
    lasombud: { status: 'granted' },
    momsOmbud: { status: 'granted' },
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
  })

  it('409 ORG_NUMBER_PROVEN_TWICE when another claimant is proven too: no link, no row', async () => {
    mockStanding.mockResolvedValue('proven_twice')
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ORG_NUMBER_PROVEN_TWICE')
    expect(getErrorMessage(body, { locale: 'sv' })).toMatch(/Arkivera de andra företagen/)
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
