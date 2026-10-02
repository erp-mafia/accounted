import { afterEach, describe, expect, it, vi } from 'vitest'
import { getScriptNonceFromHeader } from 'next/dist/server/app-render/get-script-nonce-from-header'
import {
  CSP_NONCE_HEADER,
  buildContentSecurityPolicy,
  cspOriginsFromEnv,
  generateCspNonce,
  proxyOwnsContentSecurityPolicy,
  requestCspNonce,
  type CspOrigins,
} from '../csp'

/**
 * The single static policy next.config.ts shipped before the nonce policy,
 * copied verbatim from the removed code. Every directive except script-src
 * must still come out byte-identical.
 */
function previousPolicy(origins: CspOrigins, isDev: boolean): string {
  const { supabaseUrl, supabaseWsUrl } = origins
  const turnstileOrigin = origins.turnstile ? ' https://challenges.cloudflare.com' : ''
  return [
    "default-src 'self'",
    `connect-src 'self' ${supabaseUrl} ${supabaseWsUrl} https://*.supabase.co wss://*.supabase.co https://*.enablebanking.com`,
    `style-src 'self' 'unsafe-inline' https://*.enablebanking.com`,
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} https://*.enablebanking.com${turnstileOrigin}`,
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'self' blob:",
    `frame-src 'self' blob: ${supabaseUrl}${turnstileOrigin}`,
    "frame-ancestors 'none'",
  ].join('; ')
}

function directives(policy: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const directive of policy.split('; ')) {
    const name = directive.split(' ')[0]
    expect(map.has(name), `duplicate directive ${name}`).toBe(false)
    map.set(name, directive)
  }
  return map
}

function scriptSources(policy: string): string[] {
  const directive = directives(policy).get('script-src')
  expect(directive).toBeDefined()
  return directive!.split(/\s+/).slice(1)
}

const HOSTED: CspOrigins = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseWsUrl: 'wss://abcdefgh.supabase.co',
  turnstile: false,
}
// The generic Docker image: sentinels, Turnstile origin always present.
const DOCKER: CspOrigins = {
  supabaseUrl: '__NEXT_PUBLIC_SUPABASE_URL__',
  supabaseWsUrl: '__NEXT_PUBLIC_SUPABASE_WS_URL__',
  turnstile: true,
}
const UNCONFIGURED: CspOrigins = { supabaseUrl: '', supabaseWsUrl: '', turnstile: false }

const NONCE = 'q7Yl0bJk3vS2Zt6Hn1Xw9A=='

describe('buildContentSecurityPolicy', () => {
  describe.each([
    ['hosted', HOSTED],
    ['docker sentinels', DOCKER],
    ['unconfigured', UNCONFIGURED],
  ] as const)('%s origins', (_label, origins) => {
    it.each([false, true])(
      'keeps every directive but script-src identical to the previous policy, plus base-uri (isDev=%s)',
      (isDev) => {
        const before = directives(previousPolicy(origins, isDev))
        for (const nonce of [NONCE, undefined]) {
          const after = directives(buildContentSecurityPolicy({ origins, nonce, isDev }))
          expect([...after.keys()]).toEqual([...before.keys(), 'base-uri'])
          for (const [name, value] of before) {
            if (name === 'script-src') continue
            expect(after.get(name), name).toBe(value)
          }
          // Without it an injected <base> would re-point the nonce-carrying
          // relative script URLs at another host.
          expect(after.get('base-uri')).toBe("base-uri 'self'")
        }
      },
    )

    it("nonce policy: the request's nonce plus 'strict-dynamic', never 'unsafe-inline'", () => {
      const sources = scriptSources(buildContentSecurityPolicy({ origins, nonce: NONCE, isDev: false }))
      expect(sources).toContain(`'nonce-${NONCE}'`)
      expect(sources).toContain("'strict-dynamic'")
      expect(sources).not.toContain("'unsafe-inline'")
      expect(sources).not.toContain("'unsafe-eval'")
    })

    it("static policy: no inline script at all, and no 'strict-dynamic' without a nonce", () => {
      const sources = scriptSources(buildContentSecurityPolicy({ origins, isDev: false }))
      expect(sources[0]).toBe("'self'")
      expect(sources.some((s) => s.startsWith("'nonce-"))).toBe(false)
      expect(sources).not.toContain("'strict-dynamic'")
      expect(sources).not.toContain("'unsafe-inline'")
    })
  })

  it("adds 'unsafe-eval' in development only", () => {
    for (const nonce of [NONCE, undefined]) {
      expect(scriptSources(buildContentSecurityPolicy({ origins: HOSTED, nonce, isDev: true }))).toContain(
        "'unsafe-eval'",
      )
      expect(
        scriptSources(buildContentSecurityPolicy({ origins: HOSTED, nonce, isDev: false })),
      ).not.toContain("'unsafe-eval'")
    }
  })

  it('pins the exact script-src of both variants', () => {
    expect(directives(buildContentSecurityPolicy({ origins: DOCKER, nonce: NONCE, isDev: false })).get('script-src')).toBe(
      `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' https://*.enablebanking.com https://challenges.cloudflare.com`,
    )
    expect(directives(buildContentSecurityPolicy({ origins: HOSTED, isDev: false })).get('script-src')).toBe(
      "script-src 'self' https://*.enablebanking.com",
    )
  })

  it("keeps style-src on 'unsafe-inline' without a nonce (a nonce would disable it for style attributes)", () => {
    const style = directives(buildContentSecurityPolicy({ origins: HOSTED, nonce: NONCE, isDev: false })).get('style-src')
    expect(style).toBe("style-src 'self' 'unsafe-inline' https://*.enablebanking.com")
  })

  it('carries a nonce Next.js can read back out of the header, so it stamps its own scripts', () => {
    const nonce = generateCspNonce()
    const policy = buildContentSecurityPolicy({ origins: HOSTED, nonce, isDev: false })
    expect(getScriptNonceFromHeader(policy)).toBe(nonce)
    expect(getScriptNonceFromHeader(buildContentSecurityPolicy({ origins: HOSTED, isDev: false }))).toBeUndefined()
  })
})

describe('generateCspNonce', () => {
  it('is 128 bits of base64 and unique per call', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const nonce = generateCspNonce()
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
      seen.add(nonce)
    }
    expect(seen.size).toBe(1000)
  })
})

describe('requestCspNonce', () => {
  it("returns the proxy's nonce from the forwarded request header", () => {
    const headers = new Headers({ [CSP_NONCE_HEADER]: NONCE })
    expect(requestCspNonce(headers)).toBe(NONCE)
  })

  it.each([undefined, '', 'abc" onload="x', "abc' 'unsafe-inline", 'a b'])(
    'mints a fresh nonce instead of trusting %j',
    (value) => {
      const headers = new Headers(value === undefined ? {} : { [CSP_NONCE_HEADER]: value })
      const nonce = requestCspNonce(headers)
      expect(nonce).not.toBe(value)
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    },
  )
})

describe('proxyOwnsContentSecurityPolicy', () => {
  it.each([
    '/',
    '/login',
    '/invoices/6f1c2a3e-1234-4bcd-9abc-0123456789ab',
    '/llms.txt',
    '/api/settings',
    '/api/mcp-oauth/authorize',
    '/api/extensions/enable-banking/callback',
    '/api/documents/abc',
    '/api/documents/abc/inline/extra',
    '/api/storagefoo',
  ])('stamps %s', (path) => {
    expect(proxyOwnsContentSecurityPolicy(path)).toBe(true)
  })

  it.each([
    '/api/storage',
    '/api/storage/v1/object/sign/documents/a.pdf',
    '/api/documents/6f1c2a3e-1234-4bcd-9abc-0123456789ab/inline',
  ])('leaves %s to its headers() rule', (path) => {
    expect(proxyOwnsContentSecurityPolicy(path)).toBe(false)
  })
})

describe('cspOriginsFromEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('derives the Realtime origin from the Supabase URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_WS_URL', undefined)
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '')
    expect(cspOriginsFromEnv()).toEqual(HOSTED)

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://192.168.1.20:8000')
    expect(cspOriginsFromEnv().supabaseWsUrl).toBe('ws://192.168.1.20:8000')
  })

  it('takes an explicit Realtime origin and the Turnstile site key as given', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '__NEXT_PUBLIC_SUPABASE_URL__')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_WS_URL', '__NEXT_PUBLIC_SUPABASE_WS_URL__')
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '__NEXT_PUBLIC_TURNSTILE_SITE_KEY__')
    expect(cspOriginsFromEnv()).toEqual(DOCKER)
  })
})
