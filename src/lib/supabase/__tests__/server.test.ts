import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createServerClientMock, cookiesMock } = vi.hoisted(() => ({
  createServerClientMock: vi.fn(),
  cookiesMock: vi.fn(),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: createServerClientMock,
}))

vi.mock('next/headers', () => ({
  cookies: cookiesMock,
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
