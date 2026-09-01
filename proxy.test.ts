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
const ANON_KEY = 'anon-key'

// Both vars are stubbed explicitly in every suite below. The unit project has
// no setup file and loads no dotenv, so leaning on a developer's exported
// shell environment is a test that passes locally and fails in CI.
function stubConfiguredEnvironment(supabaseUrl: string): void {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', supabaseUrl)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY)
}

describe('supabase environment proxy guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubConfiguredEnvironment(PRODUCTION_URL)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns a non-cacheable empty 503 when the Supabase URL is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined)

    const response = await proxy(new NextRequest('https://app.accounted.se/login'))

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('')
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(loggerErrorMock).toHaveBeenCalledOnce()
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Refused request without Supabase configuration',
      {
        alert: true,
        operation: 'supabase_env_missing',
        requestHostname: 'app.accounted.se',
        missing: ['NEXT_PUBLIC_SUPABASE_URL'],
      },
    )
  })

  it('returns the same 503 when the anon key is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')

    const response = await proxy(new NextRequest('https://app.accounted.se/robots.txt'))

    expect(response.status).toBe(503)
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Refused request without Supabase configuration',
      expect.objectContaining({ missing: ['NEXT_PUBLIC_SUPABASE_ANON_KEY'] }),
    )
  })

  it('treats an unsubstituted Docker sentinel as unconfigured', async () => {
    stubConfiguredEnvironment('__NEXT_PUBLIC_SUPABASE_URL__')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '__NEXT_PUBLIC_SUPABASE_ANON_KEY__')

    expect(
      (await proxy(new NextRequest('https://app.accounted.se/login'))).status,
    ).toBe(503)
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Refused request without Supabase configuration',
      expect.objectContaining({
        missing: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
      }),
    )
  })

  it('runs before the white-label guard on a customer host', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', undefined)

    expect(
      (await proxy(new NextRequest('https://willem.accounted.se/login'))).status,
    ).toBe(503)
    expect(loggerErrorMock).toHaveBeenCalledOnce()
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Refused request without Supabase configuration',
      expect.objectContaining({ operation: 'supabase_env_missing' }),
    )
  })

  it('delegates to session handling once the environment is configured', async () => {
    const request = new NextRequest('https://app.accounted.se/login')

    expect((await proxy(request)).status).toBe(204)
    expect(loggerErrorMock).not.toHaveBeenCalled()
    expect(updateSessionMock).toHaveBeenCalledOnce()
    expect(updateSessionMock).toHaveBeenCalledWith(request)
  })
})

describe('production white-label proxy guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubConfiguredEnvironment(STAGING_URL)
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
      'Blocked production white-label host from a non-production backend',
      {
        alert: true,
        operation: 'white_label_backend_guard',
        requestHostname: 'acount.accounted.se',
        backendClassification: 'non_production',
      },
    )
  })

  // The message says non-production rather than staging because the guard
  // asserts the production project: a project it has never heard of fails the
  // same way, and an alert rule keys on `operation`, which does not move.
  it('logs the same guard event for a project it has never heard of', async () => {
    stubConfiguredEnvironment('https://qqqqqqqqqqqqqqqqqqqq.supabase.co')

    const response = await proxy(
      new NextRequest('https://willem.accounted.se/login'),
    )

    expect(response.status).toBe(503)
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Blocked production white-label host from a non-production backend',
      {
        alert: true,
        operation: 'white_label_backend_guard',
        requestHostname: 'willem.accounted.se',
        backendClassification: 'non_production',
      },
    )
  })

  // The 2026-08-26 incident. This host was served by a branch preview wired to
  // staging and was missing from the protected-host list, so the guard used to
  // let it through.
  it('blocks a hosted brand nobody remembered to classify', async () => {
    const response = await proxy(
      new NextRequest('https://improveone.accounted.se/login'),
    )

    expect(response.status).toBe(503)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  // Deliberate reversal of the earlier assertion that the canonical app host
  // passes on the staging project. app.accounted.se is the production host: if
  // the build serving it is wired to another project, it fails closed too.
  it('blocks the canonical app host on the same backend', async () => {
    const response = await proxy(new NextRequest('https://app.accounted.se/login'))

    expect(response.status).toBe(503)
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it('does not treat the callback allowlist as a production classification', async () => {
    vi.stubEnv('NEXT_PUBLIC_WHITELABEL_DOMAINS', 'demo.partner-brand.se')
    const request = new NextRequest('https://demo.partner-brand.se/login')

    expect((await proxy(request)).status).toBe(204)
    expect(updateSessionMock).toHaveBeenCalledOnce()
  })

  it.each([
    'https://erp-base-git-add-white-label-infra.vercel.app/login',
    'http://localhost:3000/login',
  ])('leaves the preview or local request %s alone', async url => {
    expect((await proxy(new NextRequest(url))).status).toBe(204)
    expect(updateSessionMock).toHaveBeenCalledOnce()
    expect(loggerErrorMock).not.toHaveBeenCalled()
  })

  it('allows the production host once it is on the production backend', async () => {
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
