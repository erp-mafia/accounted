import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

// The brands table is the registry of white-label hosts (see
// lib/domains/trusted-app-origin.ts); the stub stands in for it.
const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
}))

import { resolveDiscoveryBaseUrl } from '../base-url'

const CANONICAL = 'https://app.accounted.se'
const BRAND_HOST = 'byra.example.se'

function requestWithHost(host?: string) {
  return new Request('https://ignored.example/.well-known/oauth-authorization-server', {
    headers: host ? { host } : undefined,
  })
}

describe('resolveDiscoveryBaseUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('VERCEL_URL', '')
    vi.stubEnv('VERCEL_BRANCH_URL', '')
    resolveBrandResultByHostMock.mockImplementation(async (host: string) => ({
      brand: host === BRAND_HOST ? { domain: BRAND_HOST } : null,
      lookupFailed: false,
    }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the canonical URL for the canonical host', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost('app.accounted.se'))).toBe(CANONICAL)
  })

  it('reflects the legacy host so existing MCP connectors stay self-consistent', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost('app.gnubok.se'))).toBe(
      'https://app.gnubok.se',
    )
  })

  it('reflects a registered brand domain, the URL byrå users are shown in settings', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost(BRAND_HOST))).toBe(
      `https://${BRAND_HOST}`,
    )
    expect(await resolveDiscoveryBaseUrl(requestWithHost('Byra.Example.SE'))).toBe(
      `https://${BRAND_HOST}`,
    )
    expect(resolveBrandResultByHostMock).toHaveBeenCalledWith(BRAND_HOST)
  })

  it('falls back to canonical for a spoofed Host header', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost('evil.example'))).toBe(CANONICAL)
  })

  it('never reflects a host that merely contains a brand domain', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost(`${BRAND_HOST}.evil.example`))).toBe(
      CANONICAL,
    )
    expect(await resolveDiscoveryBaseUrl(requestWithHost(`evil.${BRAND_HOST}`))).toBe(CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost(`${BRAND_HOST}:8443`))).toBe(CANONICAL)
  })

  it('falls back to canonical when the brands lookup fails', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    resolveBrandResultByHostMock.mockResolvedValue({ brand: null, lookupFailed: true })
    expect(await resolveDiscoveryBaseUrl(requestWithHost(BRAND_HOST))).toBe(CANONICAL)
  })

  it('falls back to canonical when the brands lookup throws', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    resolveBrandResultByHostMock.mockRejectedValue(new Error('connection refused'))
    expect(await resolveDiscoveryBaseUrl(requestWithHost(BRAND_HOST))).toBe(CANONICAL)
  })

  it('answers the canonical, legacy and local hosts without a brands lookup', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    await resolveDiscoveryBaseUrl(requestWithHost('app.accounted.se'))
    await resolveDiscoveryBaseUrl(requestWithHost('app.gnubok.se'))
    await resolveDiscoveryBaseUrl(requestWithHost('localhost:3000'))
    await resolveDiscoveryBaseUrl(requestWithHost(undefined))
    expect(resolveBrandResultByHostMock).not.toHaveBeenCalled()
  })

  it('falls back to canonical when the Host header is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost(undefined))).toBe(CANONICAL)
  })

  it('reflects localhost with its port for local development', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost('localhost:3000'))).toBe(
      'http://localhost:3000',
    )
  })

  it('does not reflect hosts that merely start with localhost or 127.0.0.1', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost('localhost.evil.example'))).toBe(CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost('127.0.0.1.evil.example'))).toBe(CANONICAL)
  })

  it('is case-insensitive on the host comparison', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(await resolveDiscoveryBaseUrl(requestWithHost('App.Gnubok.SE'))).toBe(
      'https://app.gnubok.se',
    )
  })
})
