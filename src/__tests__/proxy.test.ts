import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import * as pageStaticInfo from 'next/dist/build/analysis/get-page-static-info'
import { buildCustomRoute } from 'next/dist/lib/build-custom-route'
import { getScriptNonceFromHeader } from 'next/dist/server/app-render/get-script-nonce-from-header'
import {
  CSP_NONCE_HEADER,
  PROXY_MATCHER_EXCLUSIONS,
  STATIC_POLICY_SOURCE,
  proxyOwnsContentSecurityPolicy,
} from '@/lib/security/csp'

/**
 * The proxy's half of the Content-Security-Policy contract
 * (lib/security/csp.ts): a fresh nonce per request, forwarded upstream where
 * Next.js and the root layout read it, and the same policy on whatever
 * response the proxy returns. The auth work itself (updateSession) has its
 * own suite; here it is a stub that forwards the request the way the real
 * one does.
 */

const updateSession = vi.fn(async (request: NextRequest) => NextResponse.next({ request }))

vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: (request: NextRequest) => updateSession(request),
}))

vi.mock('@/lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger }
  return { createLogger: () => logger }
})

import { config, proxy } from '../proxy'

// The function Next.js compiles a proxy matcher with at build time. It is a
// runtime export its type declarations leave out.
const { getMiddlewareMatchers } = pageStaticInfo as unknown as {
  getMiddlewareMatchers: (
    matchers: string[],
    nextConfig: { basePath: string; i18n: null },
  ) => Array<{ regexp: string }>
}

function run(path: string, init: { host?: string; headers?: Record<string, string> } = {}) {
  const url = new URL(path, `http://${init.host ?? 'localhost:3000'}`)
  return proxy(new NextRequest(url, { headers: init.headers }))
}

function cspNonce(policy: string | null): string | undefined {
  return policy ? getScriptNonceFromHeader(policy) : undefined
}

/** A request header the proxy forwards upstream with NextResponse.next(). */
function forwarded(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`)
}

beforeEach(() => {
  updateSession.mockClear()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('proxy: per-request CSP nonce', () => {
  it('sets the nonce policy on the response and forwards the same policy and nonce upstream', async () => {
    const response = await run('/login')

    const policy = response.headers.get('content-security-policy')
    const nonce = cspNonce(policy)
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(policy).toContain("'strict-dynamic'")
    expect(policy!.split('; ').find((d) => d.startsWith('script-src'))).not.toContain("'unsafe-inline'")

    // What Next.js reads to stamp its own scripts, and what the root layout reads.
    expect(forwarded(response, 'content-security-policy')).toBe(policy)
    expect(forwarded(response, CSP_NONCE_HEADER)).toBe(nonce)
    // The request updateSession saw carried them too.
    const seen = updateSession.mock.calls[0][0]
    expect(seen.headers.get(CSP_NONCE_HEADER)).toBe(nonce)
    expect(seen.headers.get('content-security-policy')).toBe(policy)
  })

  it('mints a different nonce for every request', async () => {
    const nonces = new Set<string | undefined>()
    for (let i = 0; i < 20; i++) {
      nonces.add(cspNonce((await run('/login')).headers.get('content-security-policy')))
    }
    expect(nonces.size).toBe(20)
    expect(nonces.has(undefined)).toBe(false)
  })

  it('overwrites a nonce or policy the client sent itself', async () => {
    const response = await run('/login', {
      headers: {
        [CSP_NONCE_HEADER]: 'attacker-chosen',
        'content-security-policy': "script-src 'nonce-attacker-chosen'",
      },
    })
    const nonce = cspNonce(response.headers.get('content-security-policy'))
    expect(nonce).not.toBe('attacker-chosen')
    expect(forwarded(response, CSP_NONCE_HEADER)).toBe(nonce)
    expect(cspNonce(forwarded(response, 'content-security-policy'))).toBe(nonce)
  })

  it('stamps /api responses too (route handlers that render HTML share the nonce)', async () => {
    const response = await run('/api/mcp-oauth/authorize')
    const nonce = cspNonce(response.headers.get('content-security-policy'))
    expect(nonce).toBeDefined()
    expect(forwarded(response, CSP_NONCE_HEADER)).toBe(nonce)
  })

  it('stamps responses updateSession builds itself (redirects, JSON errors)', async () => {
    updateSession.mockImplementationOnce(async (request: NextRequest) =>
      NextResponse.redirect(new URL('/login', request.url)),
    )
    const redirect = await run('/invoices')
    expect(redirect.status).toBe(307)
    expect(cspNonce(redirect.headers.get('content-security-policy'))).toBeDefined()

    updateSession.mockImplementationOnce(async () => NextResponse.json({ error: 'x' }, { status: 401 }))
    const unauthorized = await run('/api/settings')
    expect(unauthorized.status).toBe(401)
    expect(cspNonce(unauthorized.headers.get('content-security-policy'))).toBeDefined()
  })

  it("stamps the proxy's own 503s", async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    const response = await run('/login')
    expect(response.status).toBe(503)
    expect(updateSession).not.toHaveBeenCalled()
    expect(cspNonce(response.headers.get('content-security-policy'))).toBeDefined()
  })

  it.each([
    '/api/documents/6f1c2a3e-1234-4bcd-9abc-0123456789ab/inline',
    '/api/storage/v1/object/sign/documents/a.pdf',
  ])('leaves the document route %s to its headers() rule', async (path) => {
    const response = await run(path)
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(forwarded(response, CSP_NONCE_HEADER)).toBeNull()
    expect(forwarded(response, 'content-security-policy')).toBeNull()
  })
})

describe('proxy matcher and the static CSP rule partition the path space', () => {
  it('spells the matcher from the shared exclusion list', () => {
    expect(config.matcher).toEqual([`/((?!${PROXY_MATCHER_EXCLUSIONS}).*)`])
  })

  // Compiled exactly as Next.js compiles them: the proxy matcher as the
  // middleware manifest regexp (tested case-sensitively, as next start does),
  // the headers() sources as routes-manifest regexes (case-insensitive).
  const [proxyMatcher] = getMiddlewareMatchers(config.matcher, { basePath: '', i18n: null })
  const proxyRe = new RegExp(proxyMatcher.regexp)
  const staticRe = new RegExp(
    buildCustomRoute('header', { source: STATIC_POLICY_SOURCE, headers: [] }).regex,
    'i',
  )
  const inlineRe = new RegExp(
    buildCustomRoute('header', { source: '/api/documents/:id/inline', headers: [] }).regex,
    'i',
  )

  it.each([
    '/',
    '/login',
    '/login.rsc',
    '/invoices/6f1c2a3e-1234-4bcd-9abc-0123456789ab',
    '/auth/callback',
    '/llms.txt',
    '/docs/api.md',
    '/robots.txt',
    '/does/not/exist',
    '/api/settings',
    '/api/nonexistent',
    '/api/mcp-oauth/authorize',
    '/api/extensions/ext/arcim-migration/callback',
    '/api/v1/openapi.json',
    '/api/storage',
    '/api/storage/v1/object/sign/documents/a.pdf',
    '/api/storagefoo',
    '/api/documents/6f1c2a3e-1234-4bcd-9abc-0123456789ab',
    '/api/documents/6f1c2a3e-1234-4bcd-9abc-0123456789ab/inline',
    '/_next/static/chunks/abc.js',
    '/_next/static/media/font.woff2',
    '/_next/image',
    '/_next/data/build-id/page',
    '/_next/data/build-id/page.json',
    '/favicon.ico',
    '/.well-known/oauth-authorization-server',
    '/.well-known/skills/index.json',
    '/rl/static/array.js',
    '/rl/e/',
    '/sw.js',
    '/sw-register.js',
    '/manifest.webmanifest',
    '/manifest.json',
    '/icons/icon-192.png',
    '/logo.svg',
    '/deep/path/photo.jpeg',
  ])('%s gets exactly one Content-Security-Policy source', (path) => {
    const fromProxy = proxyRe.test(path) && proxyOwnsContentSecurityPolicy(path)
    const fromStaticRule = staticRe.test(path)
    const fromInlineRule = inlineRe.test(path)
    expect([fromProxy, fromStaticRule, fromInlineRule].filter(Boolean)).toHaveLength(1)
  })
})
