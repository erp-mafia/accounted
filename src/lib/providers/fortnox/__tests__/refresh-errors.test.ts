import { afterEach, describe, expect, it, vi } from 'vitest'
import { fortnoxRetryAfter } from '../oauth-error'
import { refreshFortnoxToken } from '../oauth'
import { classifyProviderError } from '../../with-provider-call'

const config = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://example.test/callback' }
afterEach(() => vi.unstubAllGlobals())

describe('Fortnox refresh failure contract', () => {
  it.each([
    [400, 'invalid_grant', 'PROVIDER_AUTH_EXPIRED'],
    [401, 'invalid_client', 'PROVIDER_CONFIGURATION_ERROR'],
    [401, 'error_missing_license', 'PROVIDER_LICENSE_MISSING'],
    [401, 'error_missing_app_license', 'PROVIDER_LICENSE_MISSING'],
    [429, 'rate_limited', 'PROVIDER_RATE_LIMITED'],
    [503, 'unavailable', 'PROVIDER_UPSTREAM_ERROR'],
    [400, 'unknown_error', 'PROVIDER_UPSTREAM_ERROR'],
  ])('preserves HTTP %s / %s as %s', async (status, code, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: code, error_description: 'untrusted diagnostic' }), {
      status, headers: { 'Retry-After': '120' },
    })))
    const error = await refreshFortnoxToken(config, 'synthetic-refresh').catch(error => error)
    expect(error).toMatchObject({ status, providerCode: code, retryAfterSeconds: 120 })
    expect(classifyProviderError(error)).toBe(expected)
    expect(String(error)).not.toContain('untrusted diagnostic')
  })

  it('does not interpret an opaque HTTP 401 as a dead refresh grant', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('gateway failed', { status: 401 })))
    const error = await refreshFortnoxToken(config, 'synthetic-refresh').catch(error => error)
    expect(classifyProviderError(error)).toBe('PROVIDER_UPSTREAM_ERROR')
  })
})


it('parses HTTP date retry hints and ignores malformed delays', () => {
  expect(fortnoxRetryAfter(new Date(Date.now() + 120_000).toUTCString())).toBeGreaterThanOrEqual(119)
  expect(fortnoxRetryAfter('unknown')).toBeUndefined()
  expect(fortnoxRetryAfter('-100')).toBeUndefined()
})
