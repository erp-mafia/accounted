/**
 * POST /system-connection/deeplink: gating (capability, role, system-auth
 * mode), org-number derivation server-side, the opt-in row it records, and
 * the OmbudApiError -> 502 mapping.
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

const mockRecordProbeResult = vi.fn()
vi.mock('../lib/connection-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, recordProbeResult: (...a: unknown[]) => mockRecordProbeResult(...a) }
})

const mockWriteAudit = vi.fn()
vi.mock('../lib/audit', () => ({ writeSkatteverketAudit: (...a: unknown[]) => mockWriteAudit(...a) }))

import { skatteverketExtension } from '../index'
import { OmbudApiError } from '../lib/ombud-client'
import type { ExtensionContext } from '@/lib/extensions/types'

const ENV_KEYS = ['SKATTEVERKET_SYSTEM_AUTH_MODE', 'SKATTEVERKET_SYSTEM_AUTH_MECHANISM']
let savedEnv: Record<string, string | undefined>

function findRoute() {
  const route = skatteverketExtension.apiRoutes?.find(
    (r) => r.method === 'POST' && r.path === '/system-connection/deeplink'
  )
  if (!route) throw new Error('deeplink route not registered')
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
  mockWriteAudit.mockResolvedValue(undefined)
  mockCreateDeepLink.mockResolvedValue({
    djuplank: 'https://sso.skatteverket.se/ombud?x=1',
    roller: { lasombud: 'JLO', moms_ombud: 'MOMS' },
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
  it('500 without an extension context', async () => {
    const res = await findRoute().handler(request())
    expect(res.status).toBe(500)
  })

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

  it('mints the link for the company\'s own 12-digit org number, records the opt-in row, audits', async () => {
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: {
        djuplank: 'https://sso.skatteverket.se/ombud?x=1',
        roller: { lasombud: 'JLO', moms_ombud: 'MOMS' },
        expires_on: '2026-09-22',
      },
    })
    expect(mockCreateDeepLink).toHaveBeenCalledWith('165560000000', ['lasombud', 'moms_ombud'])
    expect(mockRecordProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', orgNumber: '165560000000', createdBy: 'user-1', error: null })
    )
    // No grant state is asserted by minting a link.
    expect(mockRecordProbeResult.mock.calls[0][0]).not.toHaveProperty('lasombud')
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ endpoint: 'system-connection/deeplink', agRegistreradId: '165560000000', outcome: 'ok' })
    )
  })

  it('502 with the error code when the register refuses or the role codes are unresolved', async () => {
    mockCreateDeepLink.mockRejectedValue(new OmbudApiError('Rollkod saknas', 'OBR_ROLE_UNRESOLVED'))
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'OBR_ROLE_UNRESOLVED' })
    expect(mockRecordProbeResult).not.toHaveBeenCalled()
  })
})
