import { describe, expect, it } from 'vitest'
import { buildCustomRoute } from 'next/dist/lib/build-custom-route'
import nextConfig from '../../../../next.config'
import { STATIC_POLICY_SOURCE, buildContentSecurityPolicy, cspOriginsFromEnv } from '../csp'

/**
 * The next.config.ts half of the header contract: no framework banner, and
 * Content-Security-Policy from headers() only where the proxy does not set
 * its nonce policy (lib/security/csp.ts; the partition itself is tested in
 * src/__tests__/proxy.test.ts).
 */

const CATCH_ALL =
  '/((?!api/documents/[^/]+/inline$|api/signera/[^/]+/document$|api/signing/me/[^/]+/document$).*)'
const INLINE_DOCUMENT = '/api/documents/:id/inline'
// The PDF a signer reads, embedded on the signing page (<object>).
const SIGNING_DOCUMENTS = ['/api/signera/:token/document', '/api/signing/me/:signerId/document']
const EMBEDDABLE_DOCUMENTS = [INLINE_DOCUMENT, ...SIGNING_DOCUMENTS]

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

  it('sets CSP from the static policy and the embeddable document routes only', async () => {
    const rules = await headerRules()
    const withCsp = rules.filter((rule) => valueOf(rule, 'Content-Security-Policy') !== undefined)
    expect(withCsp.map((rule) => rule.source)).toEqual([STATIC_POLICY_SOURCE, ...EMBEDDABLE_DOCUMENTS])

    const staticRule = withCsp[0]
    expect(valueOf(staticRule, 'Content-Security-Policy')).toBe(
      buildContentSecurityPolicy({ origins: cspOriginsFromEnv(), isDev: false }),
    )
    const staticScriptSrc = valueOf(staticRule, 'Content-Security-Policy')!
      .split('; ')
      .find((directive) => directive.startsWith('script-src'))
    expect(staticScriptSrc).not.toContain("'unsafe-inline'")

    // The inline preview keeps exactly the policy it had, and the signing
    // PDF gets the same one.
    for (const rule of withCsp.slice(1)) {
      expect(valueOf(rule, 'Content-Security-Policy'), rule.source).toBe("frame-ancestors 'self'")
    }
  })

  it('lets the embeddable document routes be framed by this origin only', async () => {
    const rules = await headerRules()
    for (const source of EMBEDDABLE_DOCUMENTS) {
      const rule = rules.find((candidate) => candidate.source === source)
      expect(rule, source).toBeDefined()
      expect(valueOf(rule!, 'X-Frame-Options'), source).toBe('SAMEORIGIN')
      expect(valueOf(rule!, 'X-Content-Type-Options'), source).toBe('nosniff')
    }
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

  // Two X-Frame-Options values on one response block the frame in Chromium,
  // so every path gets exactly one: DENY from the catch-all, or SAMEORIGIN
  // from its embeddable document rule. Compiled as Next.js compiles them.
  it.each([
    ['/signera/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd', 'DENY'],
    ['/api/signera/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd', 'DENY'],
    ['/api/signera/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd/poll', 'DENY'],
    ['/api/signera/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd/document/extra', 'DENY'],
    ['/api/signing/me/6f1c2a3e-1234-4bcd-9abc-0123456789ab/start', 'DENY'],
    ['/api/documents/6f1c2a3e-1234-4bcd-9abc-0123456789ab', 'DENY'],
    ['/api/documents/6f1c2a3e-1234-4bcd-9abc-0123456789ab/inline', 'SAMEORIGIN'],
    ['/api/signera/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd/document', 'SAMEORIGIN'],
    ['/api/signing/me/6f1c2a3e-1234-4bcd-9abc-0123456789ab/document', 'SAMEORIGIN'],
  ])('%s gets exactly one X-Frame-Options: %s', async (path, expected) => {
    const matching = (await headerRules()).filter(
      (rule) =>
        valueOf(rule, 'X-Frame-Options') !== undefined &&
        new RegExp(buildCustomRoute('header', { source: rule.source, headers: [] }).regex, 'i').test(path),
    )
    expect(matching.map((rule) => valueOf(rule, 'X-Frame-Options'))).toEqual([expected])
  })
})
