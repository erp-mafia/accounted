import { describe, it, expect } from 'vitest'
import { isRedirectedFromLegacyHost } from '../legacy-redirect'

describe('legacy-host redirect exclusions', () => {
  it('forwards ordinary pages to the new domain', () => {
    expect(isRedirectedFromLegacyHost('/')).toBe(true)
    expect(isRedirectedFromLegacyHost('/dashboard')).toBe(true)
    expect(isRedirectedFromLegacyHost('/reports')).toBe(true)
    // login and MFA pages MUST redirect: a usable login page on the
    // legacy host would establish sessions there and loop users between
    // domains.
    expect(isRedirectedFromLegacyHost('/login')).toBe(true)
    expect(isRedirectedFromLegacyHost('/mfa')).toBe(true)
  })

  it('keeps machine surfaces on the legacy host', () => {
    expect(isRedirectedFromLegacyHost('/api/v1/companies')).toBe(false)
    expect(isRedirectedFromLegacyHost('/api/extensions/ext/skatteverket/callback')).toBe(false)
    expect(isRedirectedFromLegacyHost('/.well-known/oauth-authorization-server')).toBe(false)
    expect(isRedirectedFromLegacyHost('/_next/static/chunk.js')).toBe(false)
  })

  it('keeps PKCE-cookie-bound auth flows on the legacy host (#1092)', () => {
    // Password reset and signup confirmation links sent before the
    // cutover carry a PKCE code whose verifier cookie lives on the
    // legacy host; forwarding them would break the exchange.
    expect(isRedirectedFromLegacyHost('/auth/callback')).toBe(false)
    expect(isRedirectedFromLegacyHost('/reset-password')).toBe(false)
  })
})
