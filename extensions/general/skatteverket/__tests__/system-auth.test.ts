/**
 * System (CCG) auth: config parsing and the token provider's cache
 * semantics. The stub transport stands in for the real mechanism, which is
 * pending Skatteverket's org-flow documentation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFetchToken = vi.fn()
vi.mock('../lib/system-auth/transport', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getSystemAuthTransport: () => ({ fetchToken: (...a: unknown[]) => mockFetchToken(...a) }),
  }
})

import {
  getSystemAuthMode,
  getSystemAuthMechanism,
  getSystemScopes,
  isSystemAuthConfigured,
  getSystemCertInfo,
} from '../lib/system-auth/config'
import {
  getSystemAccessToken,
  invalidateSystemToken,
  SystemAuthUnavailableError,
  __resetSystemTokenCacheForTests,
} from '../lib/system-auth/token-provider'

const ENV_KEYS = [
  'SKATTEVERKET_SYSTEM_AUTH_MODE',
  'SKATTEVERKET_SYSTEM_AUTH_MECHANISM',
  'SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL',
  'SKATTEVERKET_SYSTEM_CERT_PEM_B64',
  'SKATTEVERKET_SYSTEM_KEY_PEM_B64',
  'SKATTEVERKET_SYSTEM_SCOPES',
]
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  vi.clearAllMocks()
  __resetSystemTokenCacheForTests()
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('system-auth config', () => {
  it('defaults to mode off and mechanism mtls', () => {
    expect(getSystemAuthMode()).toBe('off')
    expect(getSystemAuthMechanism()).toBe('mtls')
  })

  it('parses valid modes and rejects garbage', () => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'shadow'
    expect(getSystemAuthMode()).toBe('shadow')
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'ON'
    expect(getSystemAuthMode()).toBe('on')
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'banana'
    expect(getSystemAuthMode()).toBe('off')
  })

  it('is unconfigured in mode off and configured with stub + on', () => {
    expect(isSystemAuthConfigured()).toBe(false)
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'on'
    process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM = 'stub'
    expect(isSystemAuthConfigured()).toBe(true)
  })

  it('mtls requires token url + cert + key', () => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'on'
    process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM = 'mtls'
    expect(isSystemAuthConfigured()).toBe(false)
    process.env.SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL = 'https://oauth2.test.skatteverket.se/token'
    process.env.SKATTEVERKET_SYSTEM_CERT_PEM_B64 = Buffer.from('-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----').toString('base64')
    process.env.SKATTEVERKET_SYSTEM_KEY_PEM_B64 = Buffer.from('-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----').toString('base64')
    expect(isSystemAuthConfigured()).toBe(true)
  })

  it('parses scopes from env with a sensible default', () => {
    expect(getSystemScopes()).toEqual(['skattekonto', 'agd:lasa', 'momsdeklaration'])
    process.env.SKATTEVERKET_SYSTEM_SCOPES = 'a  b'
    expect(getSystemScopes()).toEqual(['a', 'b'])
  })

  it('returns null cert info when the PEM cannot be parsed', () => {
    process.env.SKATTEVERKET_SYSTEM_CERT_PEM_B64 = Buffer.from('-----BEGIN CERTIFICATE-----\ngarbage\n-----END CERTIFICATE-----').toString('base64')
    expect(getSystemCertInfo()).toBeNull()
  })
})

describe('system token provider', () => {
  beforeEach(() => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'on'
    process.env.SKATTEVERKET_SYSTEM_AUTH_MECHANISM = 'stub'
  })

  it('throws SystemAuthUnavailableError when unconfigured', async () => {
    process.env.SKATTEVERKET_SYSTEM_AUTH_MODE = 'off'
    await expect(getSystemAccessToken()).rejects.toBeInstanceOf(SystemAuthUnavailableError)
    expect(mockFetchToken).not.toHaveBeenCalled()
  })

  it('mints once and serves from cache until invalidated', async () => {
    mockFetchToken.mockResolvedValue({ accessToken: 'tok-1', expiresAt: Date.now() + 3600_000 })

    expect(await getSystemAccessToken()).toBe('tok-1')
    expect(await getSystemAccessToken()).toBe('tok-1')
    expect(mockFetchToken).toHaveBeenCalledTimes(1)

    invalidateSystemToken()
    mockFetchToken.mockResolvedValue({ accessToken: 'tok-2', expiresAt: Date.now() + 3600_000 })
    expect(await getSystemAccessToken()).toBe('tok-2')
    expect(mockFetchToken).toHaveBeenCalledTimes(2)
  })

  it('re-mints when the cached token is within the refresh margin', async () => {
    // Expires in 60s: inside the 5-minute refresh-ahead margin.
    mockFetchToken.mockResolvedValueOnce({ accessToken: 'short', expiresAt: Date.now() + 60_000 })
    expect(await getSystemAccessToken()).toBe('short')
    mockFetchToken.mockResolvedValueOnce({ accessToken: 'fresh', expiresAt: Date.now() + 3600_000 })
    expect(await getSystemAccessToken()).toBe('fresh')
    expect(mockFetchToken).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent mints into one transport call', async () => {
    let release: (v: { accessToken: string; expiresAt: number }) => void = () => {}
    mockFetchToken.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve })
    )

    const first = getSystemAccessToken()
    const second = getSystemAccessToken()
    release({ accessToken: 'tok-x', expiresAt: Date.now() + 3600_000 })

    expect(await first).toBe('tok-x')
    expect(await second).toBe('tok-x')
    expect(mockFetchToken).toHaveBeenCalledTimes(1)
  })

  it('wraps transport failures in SystemAuthUnavailableError and does not cache them', async () => {
    mockFetchToken.mockRejectedValueOnce(new Error('handshake failed'))
    await expect(getSystemAccessToken()).rejects.toBeInstanceOf(SystemAuthUnavailableError)

    mockFetchToken.mockResolvedValueOnce({ accessToken: 'recovered', expiresAt: Date.now() + 3600_000 })
    expect(await getSystemAccessToken()).toBe('recovered')
  })
})
