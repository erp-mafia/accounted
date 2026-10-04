/**
 * GET /status: canRefresh follows the 65-minute refresh-token life, not
 * merely "a refresh token is stored". The silent-drop case: a token that
 * expired hours ago with its (dead) refresh token still in the row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockGetTokens = vi.fn()
const mockGetTokenHealth = vi.fn()
vi.mock('../lib/token-store', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getTokens: (...a: unknown[]) => mockGetTokens(...a),
    getTokenHealth: (...a: unknown[]) => mockGetTokenHealth(...a),
  }
})

const mockHasOmbudReadAccess = vi.fn()
vi.mock('../lib/resolve-auth', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, hasOmbudReadAccess: (...a: unknown[]) => mockHasOmbudReadAccess(...a) }
})

import { skatteverketExtension } from '../index'
import { skvStatusNeedsReconnect } from '@/lib/notices/predicates'
import type { ExtensionContext } from '@/lib/extensions/types'

function findRoute() {
  const route = skatteverketExtension.apiRoutes?.find((r) => r.method === 'GET' && r.path === '/status')
  if (!route) throw new Error('status route not registered')
  return route
}

function makeContext(): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: vi.fn() } as any,
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

const NOW = Date.parse('2026-09-01T12:00:00Z')
const request = () => new Request('http://localhost/api/extensions/ext/skatteverket/status')

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  mockGetTokenHealth.mockResolvedValue({ status: 'active', last_error_code: null, last_error_at: null })
  mockHasOmbudReadAccess.mockResolvedValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /status canRefresh', () => {
  it('not connected without a token row', async () => {
    mockGetTokens.mockResolvedValue(null)
    const res = await findRoute().handler(request(), makeContext())
    expect(await res.json()).toMatchObject({ connected: false })
  })

  it('a token expired hours ago with a stored refresh token is NOT refreshable', async () => {
    mockGetTokens.mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: NOW - 3 * 60 * 60 * 1000,
      refresh_count: 0,
      scope: 'momsdeklaration ska agd',
    })
    const body = await (await findRoute().handler(request(), makeContext())).json()
    expect(body).toMatchObject({ connected: true, expired: true, canRefresh: false, needsReconsent: false })
  })

  it('a token three minutes past expiry is still refreshable', async () => {
    mockGetTokens.mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: NOW - 3 * 60 * 1000,
      refresh_count: 2,
      scope: 'momsdeklaration',
    })
    const body = await (await findRoute().handler(request(), makeContext())).json()
    expect(body).toMatchObject({ connected: true, expired: true, canRefresh: true })
  })

  it('a live token at the refresh cap is not refreshable', async () => {
    mockGetTokens.mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      expires_at: NOW + 30 * 60 * 1000,
      refresh_count: 10,
      scope: 'momsdeklaration',
    })
    const body = await (await findRoute().handler(request(), makeContext())).json()
    expect(body).toMatchObject({ connected: true, expired: false, canRefresh: false })
  })
})

describe('GET /status ombud', () => {
  const deadSession = {
    access_token: 'a',
    refresh_token: 'r',
    expires_at: NOW - 3 * 60 * 60 * 1000,
    refresh_count: 0,
    scope: 'momsdeklaration',
  }

  it('a dead BankID session asks for reconnect without an ombud grant', async () => {
    mockGetTokens.mockResolvedValue(deadSession)
    const body = await (await findRoute().handler(request(), makeContext())).json()
    expect(body).toMatchObject({ connected: true, ombud: false })
    expect(skvStatusNeedsReconnect(body)).toBe(true)
  })

  it('with reads on the ombud grant the same dead session asks for nothing', async () => {
    mockGetTokens.mockResolvedValue(deadSession)
    mockHasOmbudReadAccess.mockResolvedValue(true)
    const body = await (await findRoute().handler(request(), makeContext())).json()
    // connected keeps meaning "this user has a BankID connection" (signing needs it).
    expect(body).toMatchObject({ connected: true, ombud: true, expired: true })
    expect(skvStatusNeedsReconnect(body)).toBe(false)
    expect(mockHasOmbudReadAccess).toHaveBeenCalledWith('company-1')
  })

  it('reports ombud for a company with no BankID connection at all', async () => {
    mockGetTokens.mockResolvedValue(null)
    mockHasOmbudReadAccess.mockResolvedValue(true)
    const body = await (await findRoute().handler(request(), makeContext())).json()
    expect(body).toMatchObject({ connected: false, ombud: true })
  })

  it('a failed ombud lookup reads as no ombud, never as an error', async () => {
    mockGetTokens.mockResolvedValue(null)
    mockHasOmbudReadAccess.mockRejectedValue(new Error('db down'))
    const res = await findRoute().handler(request(), makeContext())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ connected: false, ombud: false })
  })
})
