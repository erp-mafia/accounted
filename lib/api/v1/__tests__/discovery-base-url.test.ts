import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveDiscoveryBaseUrl } from '../base-url'

const CANONICAL = 'https://app.accounted.se'

function requestWithHost(host?: string) {
  return new Request('https://ignored.example/.well-known/oauth-authorization-server', {
    headers: host ? { host } : undefined,
  })
}

describe('resolveDiscoveryBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the canonical URL for the canonical host', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(resolveDiscoveryBaseUrl(requestWithHost('app.accounted.se'))).toBe(CANONICAL)
  })

  it('reflects the legacy host so existing MCP connectors stay self-consistent', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(resolveDiscoveryBaseUrl(requestWithHost('app.gnubok.se'))).toBe(
      'https://app.gnubok.se',
    )
  })

  it('falls back to canonical for a spoofed Host header', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(resolveDiscoveryBaseUrl(requestWithHost('evil.example'))).toBe(CANONICAL)
  })

  it('falls back to canonical when the Host header is missing', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(resolveDiscoveryBaseUrl(requestWithHost(undefined))).toBe(CANONICAL)
  })

  it('reflects localhost with its port for local development', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(resolveDiscoveryBaseUrl(requestWithHost('localhost:3000'))).toBe(
      'http://localhost:3000',
    )
  })

  it('does not reflect hosts that merely start with localhost or 127.0.0.1', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(resolveDiscoveryBaseUrl(requestWithHost('localhost.evil.example'))).toBe(CANONICAL)
    expect(resolveDiscoveryBaseUrl(requestWithHost('127.0.0.1.evil.example'))).toBe(CANONICAL)
  })

  it('is case-insensitive on the host comparison', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', CANONICAL)
    expect(resolveDiscoveryBaseUrl(requestWithHost('App.Gnubok.SE'))).toBe(
      'https://app.gnubok.se',
    )
  })
})
