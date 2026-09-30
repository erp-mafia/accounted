import { describe, expect, it } from 'vitest'
import nextConfig from '../../../../next.config'
import { STATIC_POLICY_SOURCE, buildContentSecurityPolicy, cspOriginsFromEnv } from '../csp'

/**
 * The next.config.ts half of the header contract: no framework banner, and
 * Content-Security-Policy from headers() only where the proxy does not set
 * its nonce policy (lib/security/csp.ts; the partition itself is tested in
 * src/__tests__/proxy.test.ts).
 */

const CATCH_ALL = '/((?!api/documents/[^/]+/inline$).*)'
const INLINE_DOCUMENT = '/api/documents/:id/inline'

async function headerRules() {
  expect(nextConfig.headers).toBeTypeOf('function')
  return nextConfig.headers!()
}

function valueOf(rule: { headers: { key: string; value: string }[] }, key: string) {
  return rule.headers.find((header) => header.key.toLowerCase() === key.toLowerCase())?.value
}

describe('next.config.ts response headers', () => {
  it('does not send X-Powered-By', () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })

  it('sets CSP from exactly two rules: the static policy and the inline document preview', async () => {
    const rules = await headerRules()
    const withCsp = rules.filter((rule) => valueOf(rule, 'Content-Security-Policy') !== undefined)
    expect(withCsp.map((rule) => rule.source)).toEqual([STATIC_POLICY_SOURCE, INLINE_DOCUMENT])

    const staticRule = withCsp[0]
    expect(valueOf(staticRule, 'Content-Security-Policy')).toBe(
      buildContentSecurityPolicy({ origins: cspOriginsFromEnv(), isDev: false }),
    )
    const staticScriptSrc = valueOf(staticRule, 'Content-Security-Policy')!
      .split('; ')
      .find((directive) => directive.startsWith('script-src'))
    expect(staticScriptSrc).not.toContain("'unsafe-inline'")

    // The inline preview keeps exactly the policy it had.
    expect(valueOf(withCsp[1], 'Content-Security-Policy')).toBe("frame-ancestors 'self'")
  })

  it('keeps the other security headers on the catch-all, without a CSP of its own', async () => {
    const catchAll = (await headerRules()).find((rule) => rule.source === CATCH_ALL)
    expect(catchAll?.headers.map((header) => header.key)).toEqual([
      'Strict-Transport-Security',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Permissions-Policy',
    ])
    expect(valueOf(catchAll!, 'X-Frame-Options')).toBe('DENY')
  })
})
