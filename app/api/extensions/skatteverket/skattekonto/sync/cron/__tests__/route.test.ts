/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  verifyCronSecret: vi.fn(),
  getCompanyIdsWithCapability: vi.fn(),
  createExtensionContext: vi.fn(),
  syncSkattekonto: vi.fn(),
  markNeedsReconsent: vi.fn(),
}))

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
  syncSkattekonto: (...args: unknown[]) => mocks.syncSkattekonto(...args),
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
  // Mirrors the real RECONSENT_ERROR_CODES: terminal codes only. Ordinary
  // session expiry is deliberately absent (#2567).
  RECONSENT_ERROR_CODES: ['REFRESH_EXHAUSTED', 'MISSING_SCOPE', 'TOKEN_CORRUPTED'] as const,
  markNeedsReconsent: mocks.markNeedsReconsent,
}))

vi.mock('@/extensions/general/skatteverket/lib/system-auth/config', () => ({
  getSystemAuthMode: vi.fn(() => 'off'),
  isSystemAuthConfigured: vi.fn(() => false),
}))

vi.mock('@/extensions/general/skatteverket/lib/connection-store', () => ({
  listVerifiedCompanies: vi.fn().mockResolvedValue([]),
  markGrantRevoked: vi.fn(),
}))

vi.mock('@/extensions/general/skatteverket/lib/resolve-auth', () => ({
  currentSkvEnvironment: vi.fn(() => 'test'),
  hasVerifiedGrant: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/lib/errors/get-error-message', () => ({
  getErrorMessage: vi.fn(() => 'Något gick fel. Försök igen.'),
}))

import { GET } from '../route'

function makeRequest(): Request {
  return new Request('http://localhost/api/extensions/skatteverket/skattekonto/sync/cron')
}

function makeSupabaseStub(tokens: Record<string, unknown>[]) {
  return {
    from: vi.fn((table: string) => {
      const resolved = table === 'skatteverket_tokens'
        ? { data: tokens, error: null }
        : { data: null, error: null }
      const chain: any = {}
      for (const method of ['select', 'eq', 'order', 'range']) {
        chain[method] = vi.fn(() => chain)
      }
      chain.maybeSingle = vi.fn().mockResolvedValue(resolved)
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

  it('skips a session past the refresh window without calling Skatteverket (#2567)', async () => {
    // The resting state of the personal-token cohort: the row is 'active'
    // (ordinary expiry is not a health fault any more), but its 65-minute
    // session died hours ago, so there is nothing to sync with and nothing
    // worth asking Skatteverket about.
    const deadCompanyId = '44444444-4444-4444-8444-444444444444'
    const tokens = [
      {
        user_id: '55555555-5555-4555-8555-555555555555',
        company_id: deadCompanyId,
        expires_at: new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(),
        refresh_count: 1,
      },
    ]
    mocks.createClient.mockReturnValue(makeSupabaseStub(tokens))
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([deadCompanyId]))

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ processed: 0, deadSessions: 1 })
    expect(mocks.syncSkattekonto).not.toHaveBeenCalled()
    expect(mocks.getCompanyIdsWithCapability).not.toHaveBeenCalled()
  })

  it('does not latch a health fault when Skatteverket reports SESSION_EXPIRED live', async () => {
    // A session that dies between the pre-check and the call: quiet-bucketed
    // as expired, row untouched, so the next consent just works.
    const companyId = '66666666-6666-4666-8666-666666666666'
    const tokens = [
      {
        user_id: '77777777-7777-4777-8777-777777777777',
        company_id: companyId,
        expires_at: '2099-01-01T00:00:00Z',
        refresh_count: 0,
      },
    ]
    mocks.createClient.mockReturnValue(makeSupabaseStub(tokens))
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([companyId]))
    const { SkatteverketAuthError } = await import(
      '@/extensions/general/skatteverket/lib/api-client'
    )
    mocks.syncSkattekonto.mockRejectedValueOnce(
      new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED'),
    )

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ processed: 1, expired: 1, errors: 0 })
    expect(mocks.markNeedsReconsent).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('still latches a terminal auth error so the row leaves the work list', async () => {
    const companyId = '88888888-8888-4888-8888-888888888888'
    const userId = '99999999-9999-4999-8999-999999999999'
    const tokens = [
      { user_id: userId, company_id: companyId, expires_at: '2099-01-01T00:00:00Z', refresh_count: 0 },
    ]
    mocks.createClient.mockReturnValue(makeSupabaseStub(tokens))
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set([companyId]))
    const { SkatteverketAuthError } = await import(
      '@/extensions/general/skatteverket/lib/api-client'
    )
    mocks.syncSkattekonto.mockRejectedValueOnce(
      new SkatteverketAuthError('Behörighet saknas.', 'MISSING_SCOPE'),
    )

    const response = await GET(makeRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ processed: 1, expired: 1 })
    expect(mocks.markNeedsReconsent).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      companyId,
      'MISSING_SCOPE',
    )
  })
})
