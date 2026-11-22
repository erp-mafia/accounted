import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createServerClientMock, cookiesMock, headersMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(),
  cookiesMock: vi.fn(),
  headersMock: vi.fn(),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: createServerClientMock,
}))

vi.mock('next/headers', () => ({
  cookies: cookiesMock,
  headers: headersMock,
}))

const REST_URL = 'https://project.supabase.co/rest/v1/companies?select=id'
/** A Cloudflare error page, abridged (gateway-error-page.test.ts has the full shape). */
const GATEWAY_PAGE =
  '<!DOCTYPE html><html><head><title>Script not found | project.supabase.co | Cloudflare</title></head>' +
  '<body><span class="cf-error-code">1104</span><small>Ray ID: a5b6e815fc10d8e1</small></body></html>'

describe('createServiceClient', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the service-role key with a cookie-free client', async () => {
    const serviceClient = { kind: 'service' }
    createServerClientMock.mockReturnValue(serviceClient)
    const { createServiceClient } = await import('../server')

    expect(createServiceClient()).toBe(serviceClient)
    expect(createServerClientMock).toHaveBeenCalledWith(
      'https://project.supabase.co',
      'service-role-key',
      expect.objectContaining({ cookies: expect.any(Object) }),
    )
    const options = createServerClientMock.mock.calls[0][2] as {
      cookies: { getAll: () => unknown[]; setAll: () => void }
      global?: { fetch?: unknown }
    }
    expect(options.cookies.getAll()).toEqual([])
    expect(() => options.cookies.setAll()).not.toThrow()
    expect(cookiesMock).not.toHaveBeenCalled()
    // Its PostgREST requests name the scope's actor (lib/supabase/actor-header.ts).
    expect(options.global?.fetch).toEqual(expect.any(Function))
  })

  it("answers a gateway's HTML 5xx with one short message (lib/supabase/gateway-error-page.ts)", async () => {
    createServerClientMock.mockReturnValue({ kind: 'service' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(GATEWAY_PAGE, { status: 500 })))
    const { createServiceClient } = await import('../server')

    createServiceClient()

    const options = createServerClientMock.mock.calls[0][2] as { global: { fetch: typeof fetch } }
    const response = await options.global.fetch(REST_URL)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ message: 'Supabase answered HTTP 500 without JSON: Script not found | project.supabase.co | Cloudflare' })
    vi.unstubAllGlobals()
  })
})

describe('createClient (cookie session)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key')
    cookiesMock.mockResolvedValue({ getAll: () => [], set: vi.fn() })
    createServerClientMock.mockReturnValue({ kind: 'session' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('writes the session cookie HttpOnly, and Secure for a request that arrived over https', async () => {
    headersMock.mockResolvedValue(new Headers({ 'x-forwarded-proto': 'https' }))
    const { createClient } = await import('../server')

    await createClient()

    const options = createServerClientMock.mock.calls[0][2] as {
      cookieOptions: Record<string, unknown>
    }
    expect(options.cookieOptions).toEqual({
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
      secure: true,
    })
  })

  it('still builds the client outside a request scope (headers() throws)', async () => {
    headersMock.mockRejectedValue(new Error('outside request scope'))
    vi.stubEnv('NODE_ENV', 'development')
    const { createClient } = await import('../server')

    await expect(createClient()).resolves.toEqual({ kind: 'session' })
    const options = createServerClientMock.mock.calls[0][2] as {
      cookieOptions: Record<string, unknown>
    }
    expect(options.cookieOptions).toMatchObject({ httpOnly: true, secure: false })
  })

  // The client's fetch is the page-past-end one (lib/supabase/page-past-end.ts)
  // around the forwarding fetch, or around the default fetch when forwarding is off.
  const AUTH_URL = 'https://project.supabase.co/auth/v1/token?grant_type=password'

  it('gives GoTrue calls the forwarding fetch when a secret key is configured', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test-key')
    headersMock.mockResolvedValue(new Headers({ 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' }))
    const defaultFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', defaultFetch)
    const { createClient } = await import('../server')

    await createClient()

    const options = createServerClientMock.mock.calls[0][2] as { global: { fetch: typeof fetch } }
    await options.global.fetch(AUTH_URL, { method: 'POST', headers: { apikey: 'anon-key' } })
    const sent = new Headers(defaultFetch.mock.calls[0][1]?.headers)
    expect(sent.get('apikey')).toBe('sb_secret_test-key')
    vi.unstubAllGlobals()
  })

  it('sends GoTrue calls unchanged without a secret key (local dev, self-hosted, CI)', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', '')
    headersMock.mockResolvedValue(new Headers({ 'x-forwarded-for': '203.0.113.7' }))
    const defaultFetch = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', defaultFetch)
    const { createClient } = await import('../server')

    await createClient()

    const options = createServerClientMock.mock.calls[0][2] as { global: { fetch: typeof fetch } }
    const init = { method: 'POST', headers: { apikey: 'anon-key' } }
    await options.global.fetch(AUTH_URL, init)
    expect(defaultFetch).toHaveBeenCalledWith(AUTH_URL, init)
    vi.unstubAllGlobals()
  })

  it("answers a gateway's HTML 5xx to a PostgREST read with one short message", async () => {
    headersMock.mockResolvedValue(new Headers())
    vi.stubGlobal('fetch', vi.fn(async () => new Response(GATEWAY_PAGE, { status: 500 })))
    const { createClient } = await import('../server')

    await createClient()

    const options = createServerClientMock.mock.calls[0][2] as { global: { fetch: typeof fetch } }
    const response = await options.global.fetch(REST_URL)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ message: 'Supabase answered HTTP 500 without JSON: Script not found | project.supabase.co | Cloudflare' })
    vi.unstubAllGlobals()
  })
})
