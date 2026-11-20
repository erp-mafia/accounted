/**
 * The TIC client's budget wiring: every call that reaches the proxy reserves
 * one unit under the caller's purpose, a shared-cache hit costs nothing, a
 * spent budget surfaces as TIC's own RATE_LIMIT_EXCEEDED, only successful
 * answers are shared, and the proxy secret rides on every request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const budget = vi.hoisted(() => ({
  reserveTicCall: vi.fn(),
  readTicResponseCache: vi.fn(),
  writeTicResponseCache: vi.fn(),
}))

vi.mock('@/lib/tic-budget/budget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tic-budget/budget')>()
  return { ...actual, reserveTicCall: budget.reserveTicCall }
})
vi.mock('@/lib/tic-budget/cache', () => ({
  readTicResponseCache: budget.readTicResponseCache,
  writeTicResponseCache: budget.writeTicResponseCache,
}))

import { __resetTicCacheForTest, ticApiFetch, searchCompanyByOrgNumber } from '../lib/tic-client'
import { lookupCompanyByOrgNumber } from '../lib/lookup'
import { buildCompanyProfile } from '../lib/profile'

const PROXY_URL = 'https://proxy.example.com/api/tic/proxy'

function companyHit() {
  return {
    found: 1,
    hits: [
      {
        document: {
          companyId: 42,
          registrationNumber: '5560000001',
          names: [{ nameOrIdentifier: 'Testbolaget AB', companyNamingType: 'name' }],
        },
      },
    ],
  }
}

describe('ticApiFetch budget and shared cache', () => {
  beforeEach(() => {
    __resetTicCacheForTest()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
    vi.stubEnv('TIC_API_PROXY_URL', PROXY_URL)
    budget.reserveTicCall.mockResolvedValue({ ok: true })
    budget.readTicResponseCache.mockResolvedValue({ hit: false })
    budget.writeTicResponseCache.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reserves one unit under the caller purpose, then fetches and shares the answer', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    await expect(ticApiFetch('/companies/1/status', { purpose: 'refresh' })).resolves.toEqual({ ok: 1 })
    expect(budget.reserveTicCall).toHaveBeenCalledWith({ purpose: 'refresh' })
    expect(budget.writeTicResponseCache).toHaveBeenCalledWith('/companies/1/status', { ok: 1 })
  })

  it('charges an unnamed caller with an empty context (purpose other)', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    await ticApiFetch('/companies/1/status')
    expect(budget.reserveTicCall).toHaveBeenCalledWith({})
  })

  it('answers a shared-cache hit without budget or upstream call', async () => {
    budget.readTicResponseCache.mockResolvedValue({ hit: true, value: { cached: true } })
    await expect(ticApiFetch('/companies/1/status', { purpose: 'composer' })).resolves.toEqual({ cached: true })
    expect(budget.reserveTicCall).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    // ...and keeps it in process: the second read touches nothing.
    await ticApiFetch('/companies/1/status', { purpose: 'composer' })
    expect(budget.readTicResponseCache).toHaveBeenCalledTimes(1)
  })

  it('refuses with RATE_LIMIT_EXCEEDED when the budget denies, without calling TIC', async () => {
    budget.reserveTicCall.mockResolvedValue({ ok: false, scope: 'purpose' })
    await expect(ticApiFetch('/companies/1/status', { purpose: 'composer' })).rejects.toMatchObject({
      name: 'TICAPIError',
      statusCode: 429,
      code: 'RATE_LIMIT_EXCEEDED',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('still calls TIC when the budget failed open', async () => {
    budget.reserveTicCall.mockResolvedValue({ ok: true, failedOpen: true })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }))
    await expect(ticApiFetch('/x')).resolves.toEqual({ ok: 1 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('never shares a 404, a rate-limit answer or an upstream error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('no', { status: 404 }))
    await expect(ticApiFetch('/a')).resolves.toBeNull()
    vi.mocked(fetch).mockResolvedValueOnce(new Response('slow down', { status: 429 }))
    await expect(ticApiFetch('/b')).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' })
    vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 500, statusText: 'Server Error' }))
    await expect(ticApiFetch('/c')).rejects.toMatchObject({ statusCode: 500 })
    expect(budget.writeTicResponseCache).not.toHaveBeenCalled()
  })

  it('sends x-proxy-secret when TIC_API_PROXY_SECRET is set', async () => {
    vi.stubEnv('TIC_API_PROXY_SECRET', 'shared-secret')
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    await ticApiFetch('/x')
    expect(fetch).toHaveBeenCalledWith(
      `${PROXY_URL}?endpoint=${encodeURIComponent('/x')}`,
      expect.objectContaining({ headers: { Accept: 'application/json', 'x-proxy-secret': 'shared-secret' } }),
    )
  })

  it('threads the context through the org-number search and the MCP lookup', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(companyHit()), { status: 200 }))
    await searchCompanyByOrgNumber('5560000001', { purpose: 'onboarding_lookup' })
    expect(budget.reserveTicCall).toHaveBeenLastCalledWith({ purpose: 'onboarding_lookup' })

    __resetTicCacheForTest()
    await lookupCompanyByOrgNumber('5560000001', { purpose: 'mcp_lookup', subject: 'key-1' })
    expect(budget.reserveTicCall).toHaveBeenLastCalledWith({ purpose: 'mcp_lookup', subject: 'key-1' })
  })

  it('charges every call of the profile fan-out to the caller purpose, profile by default', async () => {
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input).includes('search-public')
        ? new Response(JSON.stringify(companyHit()), { status: 200 })
        : new Response('[]', { status: 200 }),
    )
    await buildCompanyProfile('5560000001', { warn: vi.fn() }, { purpose: 'composer' })
    expect(budget.reserveTicCall).toHaveBeenCalledTimes(7)
    for (const [ctx] of budget.reserveTicCall.mock.calls) expect(ctx).toEqual({ purpose: 'composer' })

    __resetTicCacheForTest()
    budget.reserveTicCall.mockClear()
    await buildCompanyProfile('5560000001', { warn: vi.fn() })
    expect(budget.reserveTicCall).toHaveBeenCalledTimes(7)
    for (const [ctx] of budget.reserveTicCall.mock.calls) expect(ctx).toEqual({ purpose: 'profile' })
  })
})
