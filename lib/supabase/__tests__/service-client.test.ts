import { describe, it, expect, vi, beforeEach } from 'vitest'

const createClientMock = vi.fn(() => ({ from: vi.fn() }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createClientMock(...(args as [])),
}))

import { createServiceRoleClient, SERVER_AUTH_OPTIONS } from '../service-client'

/** The auth block supabase-js was actually constructed with. */
function authArg() {
  const [, , options] = createClientMock.mock.calls[0] as unknown as [
    string,
    string,
    { auth?: Record<string, unknown> } | undefined,
  ]
  return options?.auth
}

describe('createServiceRoleClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('disables the auth refresh ticker', () => {
    // The whole point: autoRefreshToken defaults to true, and off-browser
    // auth-js starts a 30 s setInterval that is never cleared. unref() keeps
    // the process exitable but leaves the timer a GC root, so every client
    // retains its request scope until the heap is gone.
    createServiceRoleClient('https://example.supabase.co', 'service-key')

    expect(authArg()).toMatchObject({ autoRefreshToken: false, persistSession: false })
  })

  it('passes url and key through unchanged', () => {
    createServiceRoleClient('https://example.supabase.co', 'service-key')

    const [url, key] = createClientMock.mock.calls[0] as unknown as [string, string]
    expect(url).toBe('https://example.supabase.co')
    expect(key).toBe('service-key')
  })

  it('keeps caller options that are not auth', () => {
    createServiceRoleClient('https://example.supabase.co', 'service-key', {
      db: { schema: 'public' },
      global: { headers: { 'x-test': '1' } },
    })

    const [, , options] = createClientMock.mock.calls[0] as unknown as [
      string,
      string,
      { db?: unknown; global?: unknown },
    ]
    expect(options.db).toEqual({ schema: 'public' })
    expect(options.global).toEqual({ headers: { 'x-test': '1' } })
  })

  it('refuses to let a caller re-enable the ticker', () => {
    // SERVER_AUTH_OPTIONS is spread last precisely so this cannot happen: a
    // caller copying an old snippet must not be able to reintroduce the leak.
    createServiceRoleClient('https://example.supabase.co', 'service-key', {
      auth: { autoRefreshToken: true, persistSession: true },
    })

    expect(authArg()).toMatchObject({ autoRefreshToken: false, persistSession: false })
  })

  it('keeps unrelated auth options the caller set', () => {
    createServiceRoleClient('https://example.supabase.co', 'service-key', {
      auth: { storageKey: 'custom-key' },
    })

    expect(authArg()).toMatchObject({
      storageKey: 'custom-key',
      autoRefreshToken: false,
      persistSession: false,
    })
  })

  it('exports the options it applies', () => {
    expect(SERVER_AUTH_OPTIONS).toEqual({ persistSession: false, autoRefreshToken: false })
  })
})
