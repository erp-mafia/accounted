/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  verifyCronSecret: vi.fn(),
  getCompanyIdsWithCapability: vi.fn(),
  createExtensionContext: vi.fn(),
  syncSkattekonto: vi.fn(),
  computeSkattekontoDrift: vi.fn(),
  maybeAlertDrift: vi.fn(),
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

vi.mock('@/extensions/general/skatteverket/lib/skattekonto-drift', () => ({
  computeSkattekontoDrift: (...args: unknown[]) => mocks.computeSkattekontoDrift(...args),
  maybeAlertDrift: (...args: unknown[]) => mocks.maybeAlertDrift(...args),
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
    mocks.computeSkattekontoDrift.mockResolvedValue(null)
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
})
