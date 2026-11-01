/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  verifyCronSecret: vi.fn(),
  getCompanyIdsWithCapability: vi.fn(),
  createExtensionContext: vi.fn(),
  syncSkattekonto: vi.fn(),
}))

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => log }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mocks.createClient(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: (...args: unknown[]) => mocks.verifyCronSecret(...args),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  getCompanyIdsWithCapability: (...args: unknown[]) => mocks.getCompanyIdsWithCapability(...args),
}))

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: (...args: unknown[]) => mocks.createExtensionContext(...args),
}))

vi.mock('@/extensions/general/skatteverket/lib/skattekonto-sync', () => ({
  SKATTEKONTO_LAST_SYNCED_AT_KEY: 'skattekonto_last_synced_at',
  SKATTEKONTO_UNAVAILABLE_KEY: 'skattekonto_unavailable',
  syncSkattekonto: (...args: unknown[]) => mocks.syncSkattekonto(...args),
  // The real classifier keys on these two test doubles' shapes.
  skattekontoUnavailableReason: (err: unknown) =>
    (err as { unavailable?: string } | null)?.unavailable ?? null,
}))

vi.mock('@/extensions/general/skatteverket/lib/api-client', () => {
  class SkatteverketAuthError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message)
    }
  }
  return { SkatteverketAuthError }
})

vi.mock('@/extensions/general/skatteverket/lib/skattekonto-client', () => {
  class SkatteverketSkattekontoError extends Error {
    felkod = 'TEST'
  }
  return { SkatteverketSkattekontoError }
})

vi.mock('@/extensions/general/skatteverket/lib/token-store', () => ({
  RECONSENT_ERROR_CODES: [] as const,
  markNeedsReconsent: vi.fn(),
}))

vi.mock('@/extensions/general/skatteverket/lib/system-auth/config', () => ({
  getSystemAuthMode: vi.fn(() => 'off'),
  isSystemAuthConfigured: vi.fn(() => false),
}))

vi.mock('@/extensions/general/skatteverket/lib/connection-store', () => ({
  listVerifiedCompanies: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/extensions/general/skatteverket/lib/grant-probe', () => ({
  recordGrantRefusal: vi.fn(),
}))

vi.mock('@/extensions/general/skatteverket/lib/resolve-auth', () => ({
  currentSkvEnvironment: vi.fn(() => 'test'),
  hasVerifiedGrant: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/lib/errors/get-error-message', () => ({
  getErrorMessage: vi.fn(() => 'Något gick fel. Försök igen.'),
}))

import { GET } from '../route'
import { getSystemAuthMode, isSystemAuthConfigured } from '@/extensions/general/skatteverket/lib/system-auth/config'
import { listVerifiedCompanies } from '@/extensions/general/skatteverket/lib/connection-store'
import { recordGrantRefusal } from '@/extensions/general/skatteverket/lib/grant-probe'
import { SkatteverketAuthError } from '@/extensions/general/skatteverket/lib/api-client'

function makeRequest(): Request {
  return new Request('http://localhost/api/extensions/skatteverket/skattekonto/sync/cron')
}

function makeSupabaseStub(
  tokens: Record<string, unknown>[],
  opts: { lastSyncedAt?: string; extensionRows?: Record<string, unknown>[] } = {},
) {
  return {
    from: vi.fn((table: string) => {
      const resolved = table === 'skatteverket_tokens'
        ? { data: tokens, error: null }
        : table === 'extension_data' && opts.extensionRows
          ? { data: opts.extensionRows, error: null }
          : { data: null, error: null }
      const chain: any = {}
      for (const method of ['select', 'eq', 'in', 'order', 'range']) {
        chain[method] = vi.fn(() => chain)
      }
      // The per-company cooldown read (extension_data, maybeSingle).
      const single = table === 'extension_data' && opts.lastSyncedAt
        ? { data: { value: opts.lastSyncedAt }, error: null }
        : resolved
      chain.maybeSingle = vi.fn().mockResolvedValue(single)
      chain.then = (resolve: (value: unknown) => void) => resolve(resolved)
      return chain
    }),
  }
}

describe('GET /api/extensions/skatteverket/skattekonto/sync/cron', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let infoSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SKATTEVERKET_ENABLED = 'true'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    mocks.verifyCronSecret.mockReturnValue(null)
    mocks.createExtensionContext.mockImplementation(
      (supabase: unknown, userId: string, companyId: string) => ({ supabase, userId, companyId }),
    )
    mocks.syncSkattekonto.mockResolvedValue({ booked: 0, upcoming: 0 })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    infoSpy.mockRestore()
    logSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  it('returns 401 before creating a database client when cron auth fails', async () => {
    mocks.verifyCronSecret.mockReturnValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )

    const response = await GET(makeRequest())

    expect(response.status).toBe(401)
    expect(mocks.createClient).not.toHaveBeenCalled()
  })

  it('syncs an entitled company after fifty ineligible token rows', async () => {
    const entitledCompanyId = '11111111-1111-4111-8111-111111111111'
    const tokens = [
      ...Array.from({ length: 50 }, (_, index) => ({
        user_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        company_id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
        expires_at: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        refresh_count: 0,
      })),
      {
        user_id: '33333333-3333-4333-8333-333333333333',
        company_id: entitledCompanyId,
        expires_at: '2099-01-01T00:00:00Z',
        refresh_count: 0,
      },
    ]
    mocks.createClient.mockReturnValue(makeSupabaseStub(tokens))
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([entitledCompanyId]))

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ processed: 1, synced: 1, errors: 0 })
    expect(mocks.syncSkattekonto).toHaveBeenCalledTimes(1)
    expect(mocks.syncSkattekonto.mock.calls[0][0]).toMatchObject({ companyId: entitledCompanyId })
  })

  it('the hourly schedule is never blocked by the previous run: 55 minutes ago syncs, 30 minutes ago waits', async () => {
    const companyId = '11111111-1111-4111-8111-111111111111'
    const tokens = [{ user_id: 'u1', company_id: companyId, expires_at: '2099-01-01T00:00:00Z', refresh_count: 0 }]
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([companyId]))

    mocks.createClient.mockReturnValue(
      makeSupabaseStub(tokens, { lastSyncedAt: new Date(Date.now() - 55 * 60 * 1000).toISOString() }),
    )
    expect(await (await GET(makeRequest())).json()).toMatchObject({ synced: 1 })

    mocks.syncSkattekonto.mockClear()
    mocks.createClient.mockReturnValue(
      makeSupabaseStub(tokens, { lastSyncedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }),
    )
    await GET(makeRequest())
    expect(mocks.syncSkattekonto).not.toHaveBeenCalled()
  })
  // B07: Skatteverket answering "no skattekonto yet" (404) or "this person is
  // not authorized" (403 felkod 6) is a state. It was logged as
  // "[skattekonto-sync-cron] Sync failed" every hour for every such company.
  it('a no-skattekonto answer is reported as unavailable, not logged as an error', async () => {
    const companyId = '11111111-1111-4111-8111-111111111111'
    const tokens = [{ user_id: 'u1', company_id: companyId, expires_at: '2099-01-01T00:00:00Z', refresh_count: 0 }]
    mocks.createClient.mockReturnValue(makeSupabaseStub(tokens))
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([companyId]))
    mocks.syncSkattekonto.mockRejectedValue(Object.assign(new Error('Inget skattekonto'), { unavailable: 'no_account' }))

    const body = await (await GET(makeRequest())).json()

    expect(body).toMatchObject({ processed: 1, unavailable: 1, errors: 0 })
    expect(body.results[0]).toMatchObject({ companyId, status: 'unavailable', error: 'no_account' })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('a real failure is still an error', async () => {
    const companyId = '11111111-1111-4111-8111-111111111111'
    const tokens = [{ user_id: 'u1', company_id: companyId, expires_at: '2099-01-01T00:00:00Z', refresh_count: 0 }]
    mocks.createClient.mockReturnValue(makeSupabaseStub(tokens))
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([companyId]))
    mocks.syncSkattekonto.mockRejectedValue(new Error('Skatteverket svarade med 500'))

    const body = await (await GET(makeRequest())).json()

    expect(body).toMatchObject({ processed: 1, unavailable: 0, errors: 1 })
    expect(log.error).toHaveBeenCalledWith('Sync failed', expect.anything())
  })

  it('a system credential that cannot be minted is an error once per run: every company on the grant stops syncing', async () => {
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    vi.mocked(getSystemAuthMode).mockReturnValue('on')
    vi.mocked(isSystemAuthConfigured).mockReturnValue(true)
    vi.mocked(listVerifiedCompanies).mockResolvedValue([{ company_id: first, created_by: 'u1' }, { company_id: second, created_by: 'u2' }] as never)
    mocks.createClient.mockReturnValue(makeSupabaseStub([]))
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([first, second]))
    mocks.syncSkattekonto.mockRejectedValue(new (SkatteverketAuthError as any)('certificate rejected', 'SYSTEM_AUTH_FAILED'))

    const body = await (await GET(makeRequest())).json()

    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['system_auth_failed', 'system_auth_failed'])
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(
      'system token minting/authentication failed; skipping remaining system-mode entries this run',
      expect.objectContaining({ message: 'certificate rejected' }),
    )
    vi.mocked(getSystemAuthMode).mockReturnValue('off')
    vi.mocked(isSystemAuthConfigured).mockReturnValue(false)
    vi.mocked(listVerifiedCompanies).mockResolvedValue([])
  })

  it.each([
    ['withdrawn', 'grant_withdrawn', { grantWithdrawn: 1, grantRefused: 0 }],
    ['active', 'grant_refused', { grantWithdrawn: 0, grantRefused: 1 }],
    ['unverified', 'grant_refused', { grantWithdrawn: 0, grantRefused: 1 }],
  ] as const)('a refused system read asks the register; register says %s: %s (#115)', async (verdict, status, counts) => {
    const companyId = '11111111-1111-4111-8111-111111111111'
    vi.mocked(getSystemAuthMode).mockReturnValue('on')
    vi.mocked(isSystemAuthConfigured).mockReturnValue(true)
    vi.mocked(listVerifiedCompanies).mockResolvedValue([{ company_id: companyId, created_by: 'u1' }] as never)
    vi.mocked(recordGrantRefusal).mockResolvedValue(verdict)
    mocks.createClient.mockReturnValue(makeSupabaseStub([]))
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([companyId]))
    mocks.syncSkattekonto.mockRejectedValue(new (SkatteverketAuthError as any)('Ombud saknas.', 'OMBUD_GRANT_MISSING'))

    const body = await (await GET(makeRequest())).json()

    expect(recordGrantRefusal).toHaveBeenCalledWith(companyId, 'lasombud')
    expect(body.results[0]).toMatchObject({ companyId, source: 'system', status, error: 'OMBUD_GRANT_MISSING' })
    expect(body).toMatchObject({ processed: 1, errors: 0, ...counts })
    vi.mocked(getSystemAuthMode).mockReturnValue('off')
    vi.mocked(isSystemAuthConfigured).mockReturnValue(false)
    vi.mocked(listVerifiedCompanies).mockResolvedValue([])
  })

  it('an unavailable company is asked again after three hours, not every hour', async () => {
    const companyId = '11111111-1111-4111-8111-111111111111'
    const tokens = [{ user_id: 'u1', company_id: companyId, expires_at: '2099-01-01T00:00:00Z', refresh_count: 0 }]
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([companyId]))
    const state = (hoursAgo: number) => ({
      company_id: companyId,
      key: 'skattekonto_unavailable',
      value: {
        reason: 'no_account',
        since: '2026-10-20T10:00:00.000Z',
        checkedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
      },
    })

    mocks.createClient.mockReturnValue(makeSupabaseStub(tokens, { extensionRows: [state(1)] }))
    const skipped = await (await GET(makeRequest())).json()
    expect(mocks.syncSkattekonto).not.toHaveBeenCalled()
    expect(skipped.results[0]).toMatchObject({ status: 'skipped_cooldown', error: 'no_account' })

    mocks.createClient.mockReturnValue(makeSupabaseStub(tokens, { extensionRows: [state(3.5)] }))
    expect(await (await GET(makeRequest())).json()).toMatchObject({ synced: 1 })
  })

  it('a company Skatteverket has no account for no longer jumps the queue', async () => {
    const stale = '11111111-1111-4111-8111-111111111111'
    const noAccount = '22222222-2222-4222-8222-222222222222'
    const tokens = [
      { user_id: 'u2', company_id: noAccount, expires_at: '2099-01-01T00:00:00Z', refresh_count: 0 },
      { user_id: 'u1', company_id: stale, expires_at: '2099-01-01T00:00:00Z', refresh_count: 0 },
    ]
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([stale, noAccount]))
    const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()
    mocks.createClient.mockReturnValue(
      makeSupabaseStub(tokens, {
        extensionRows: [
          { company_id: stale, key: 'skattekonto_last_synced_at', value: hoursAgo(5) },
          {
            company_id: noAccount,
            key: 'skattekonto_unavailable',
            value: { reason: 'no_account', since: hoursAgo(30), checkedAt: hoursAgo(4) },
          },
        ],
      }),
    )

    const body = await (await GET(makeRequest())).json()

    // Never synced, but asked 4 h ago: behind the company synced 5 h ago.
    expect(body.results.map((r: { companyId: string }) => r.companyId)).toEqual([stale, noAccount])
  })

  it('syncs up to four companies at once, so one slow company does not stall the run', async () => {
    const companyIds = Array.from({ length: 9 }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`)
    const tokens = companyIds.map((company_id, i) => ({
      user_id: `u${i}`,
      company_id,
      expires_at: '2099-01-01T00:00:00Z',
      refresh_count: 0,
    }))
    mocks.createClient.mockReturnValue(makeSupabaseStub(tokens))
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set(companyIds))
    let inFlight = 0
    let maxInFlight = 0
    mocks.syncSkattekonto.mockImplementation(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return { booked: 0, upcoming: 0 }
    })

    const body = await (await GET(makeRequest())).json()

    expect(body).toMatchObject({ processed: 9, synced: 9, errors: 0 })
    expect(maxInFlight).toBe(4)
    expect(body.results.map((r: { companyId: string }) => r.companyId)).toEqual(companyIds)
  })
})
