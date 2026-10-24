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
    }
    expect(options.cookies.getAll()).toEqual([])
    expect(() => options.cookies.setAll()).not.toThrow()
    expect(cookiesMock).not.toHaveBeenCalled()
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

  it('gives GoTrue calls the forwarding fetch when a secret key is configured', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test-key')
    headersMock.mockResolvedValue(new Headers({ 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' }))
    const { createClient } = await import('../server')

    await createClient()

    const options = createServerClientMock.mock.calls[0][2] as { global?: { fetch?: unknown } }
    expect(typeof options.global?.fetch).toBe('function')
  })

  it('keeps the default fetch without a secret key (local dev, self-hosted, CI)', async () => {
    vi.stubEnv('SUPABASE_SECRET_KEY', '')
    headersMock.mockResolvedValue(new Headers({ 'x-forwarded-for': '203.0.113.7' }))
    const { createClient } = await import('../server')

    await createClient()

    const options = createServerClientMock.mock.calls[0][2] as { global?: unknown }
    expect(options.global).toBeUndefined()
  })
})
