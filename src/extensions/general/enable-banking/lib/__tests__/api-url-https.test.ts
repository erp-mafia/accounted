/**
 * accounted#21: the direct Enable Banking path sends Arcim's signed EB JWT in
 * Authorization, so the configured base URL must be https. The base URL is a
 * module-level constant read at import, hence the fresh import per case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getAuthorizationHeader = vi.fn(() => 'Bearer test-jwt')
vi.mock('../jwt', () => ({
  generateJWT: vi.fn(() => 'test-jwt'),
  getAuthorizationHeader: () => getAuthorizationHeader(),
  _resetTokenCache: vi.fn(),
}))

async function loadWithBaseUrl(baseUrl: string) {
  vi.resetModules()
  vi.stubEnv('ENABLE_BANKING_API_URL_PRODUCTION', '')
  vi.stubEnv('ENABLE_BANKING_API_URL', baseUrl)
  // No connector key: the direct path, where the JWT is sent.
  vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
  return import('../api-client')
}

describe('Enable Banking direct path: base URL must be https', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ balances: [] }), { status: 200 }),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('refuses an http base URL before the JWT is minted or sent', async () => {
    const { getAccountBalances } = await loadWithBaseUrl('http://api.enablebanking.com')
    await expect(getAccountBalances('acc-1')).rejects.toThrow(/ENABLE_BANKING_API_URL must be https/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(getAuthorizationHeader).not.toHaveBeenCalled()
  })

  it('sends to an https base URL', async () => {
    const { getAccountBalances } = await loadWithBaseUrl('https://api.enablebanking.com')
    await getAccountBalances('acc-1')
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://api.enablebanking.com/accounts/acc-1/balances')
  })

  it('accepts a localhost mock in test, refuses it in production', async () => {
    const { getAccountBalances } = await loadWithBaseUrl('http://localhost:4010')
    await getAccountBalances('acc-1')
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://localhost:4010/accounts/acc-1/balances')

    vi.stubEnv('NODE_ENV', 'production')
    fetchSpy.mockClear()
    await expect(getAccountBalances('acc-1')).rejects.toThrow(/must be https/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
