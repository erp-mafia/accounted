import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest, NextResponse } from 'next/server'

const updateSessionMock = vi.hoisted(() =>
  vi.fn(async () => new NextResponse(null, { status: 204 })),
)
const loggerErrorMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/middleware', () => ({
  updateSession: updateSessionMock,
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: loggerErrorMock }),
}))

import { config, proxy } from './proxy'

const STAGING_URL = 'https://metjnjrhvujscngnpzdv.supabase.co'
const PRODUCTION_URL = 'https://pwxtzglxptnnvjrpixpg.supabase.co'

describe('production white-label proxy guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', STAGING_URL)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['/login', '/auth/callback', '/api/health'])(
    'covers the application request path %s',
    pathname => {
      expect(
        unstable_doesMiddlewareMatch({
          config,
          nextConfig: {},
          url: `https://acount.accounted.se${pathname}`,
        }),
      ).toBe(true)
    },
  )

  it('returns a non-cacheable empty 503 before session handling', async () => {
    const response = await proxy(
      new NextRequest('https://acount.accounted.se/login'),
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('')
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(loggerErrorMock).toHaveBeenCalledOnce()
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Blocked production white-label host from staging backend',
      {
        alert: true,
        operation: 'white_label_backend_guard',
        requestHostname: 'acount.accounted.se',
        backendClassification: 'staging',
      },
    )
  })

  it('preserves canonical app behavior with the same backend', async () => {
    const request = new NextRequest('https://app.accounted.se/login')

    expect((await proxy(request)).status).toBe(204)
    expect(updateSessionMock).toHaveBeenCalledOnce()
    expect(updateSessionMock).toHaveBeenCalledWith(request)
  })

  it('does not treat the callback allowlist as a production classification', async () => {
    vi.stubEnv('NEXT_PUBLIC_WHITELABEL_DOMAINS', 'internal-demo.accounted.test')
    const request = new NextRequest('https://internal-demo.accounted.test/login')

    expect((await proxy(request)).status).toBe(204)
    expect(updateSessionMock).toHaveBeenCalledOnce()
  })

  it('allows the production host after it moves to a different backend', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', PRODUCTION_URL)
    const request = new NextRequest('https://acount.accounted.se/login')

    expect((await proxy(request)).status).toBe(204)
    expect(updateSessionMock).toHaveBeenCalledOnce()
  })

  it('uses the request URL host and ignores x-forwarded-host', async () => {
    const spoofedForwardedHost = new NextRequest(
      'https://preview.vercel.app/login',
      { headers: { 'x-forwarded-host': 'acount.accounted.se' } },
    )
    expect((await proxy(spoofedForwardedHost)).status).toBe(204)

    const productionHost = new NextRequest(
      'https://acount.accounted.se/login',
      { headers: { 'x-forwarded-host': 'preview.vercel.app' } },
    )
    expect((await proxy(productionHost)).status).toBe(503)
    expect(updateSessionMock).toHaveBeenCalledTimes(1)
  })
})
