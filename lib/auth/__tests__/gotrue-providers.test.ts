import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAuthSettings, type GoTrueSettingsResponse } from '@/lib/auth/gotrue-providers'

function fakeSettings(overrides: Partial<GoTrueSettingsResponse> = {}): GoTrueSettingsResponse {
  return {
    external: {},
    disable_signup: false,
    mailer_autoconfirm: true,
    phone_autoconfirm: true,
    sms_provider: 'twilio',
    saml_enabled: false,
    passkeys_enabled: false,
    ...overrides,
  }
}

function mockFetch(body: GoTrueSettingsResponse, status = 200) {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }),
  )
}

describe('fetchAuthSettings', () => {
  const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const savedKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  afterEach(() => {
    vi.restoreAllMocks()
    if (savedUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl
    else delete process.env.NEXT_PUBLIC_SUPABASE_URL
    if (savedKey !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = savedKey
    else delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  })

  it('returns empty providers and defaults when env vars are missing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    const spy = vi.spyOn(global, 'fetch')
    const result = await fetchAuthSettings()
    expect(result).toEqual({
      providers: [],
      passwordLoginEnabled: true,
      registrationEnabled: true,
    })
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns safe defaults on non-200 response', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings(), 500)
    const result = await fetchAuthSettings()
    expect(result).toEqual({
      providers: [],
      passwordLoginEnabled: true,
      registrationEnabled: true,
    })
  })

  it('returns safe defaults on fetch error', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network'))
    const result = await fetchAuthSettings()
    expect(result).toEqual({
      providers: [],
      passwordLoginEnabled: true,
      registrationEnabled: true,
    })
  })

  it('calls GoTrue settings endpoint with apikey header', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    const spy = mockFetch(fakeSettings())
    await fetchAuthSettings()
    expect(spy).toHaveBeenCalledWith(
      'https://project.supabase.co/auth/v1/settings',
      expect.objectContaining({
        headers: { apikey: 'anon-key-123' },
      }),
    )
  })

  it('returns passwordLoginEnabled=true when email is enabled', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ external: { email: true } }))
    const result = await fetchAuthSettings()
    expect(result.passwordLoginEnabled).toBe(true)
  })

  it('returns passwordLoginEnabled=false when email is disabled', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ external: { email: false } }))
    const result = await fetchAuthSettings()
    expect(result.passwordLoginEnabled).toBe(false)
  })

  it('returns registrationEnabled=true when disable_signup is false', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ disable_signup: false }))
    const result = await fetchAuthSettings()
    expect(result.registrationEnabled).toBe(true)
  })

  it('returns registrationEnabled=false when disable_signup is true', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ disable_signup: true }))
    const result = await fetchAuthSettings()
    expect(result.registrationEnabled).toBe(false)
  })

  it('resolves known providers with brand labels', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ external: { google: true, github: true, email: true } }))
    const result = await fetchAuthSettings()
    expect(result.providers).toEqual([
      { id: 'google', label: 'Google', isCustom: false },
      { id: 'github', label: 'GitHub', isCustom: false },
    ])
  })

  it('marks unknown providers as custom with their name as label', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ external: { 'my-oidc': true } }))
    const result = await fetchAuthSettings()
    expect(result.providers).toEqual([
      { id: 'my-oidc', label: 'my-oidc', isCustom: true },
    ])
  })

  it('excludes disabled providers', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ external: { google: false, github: true } }))
    const result = await fetchAuthSettings()
    expect(result.providers).toEqual([
      { id: 'github', label: 'GitHub', isCustom: false },
    ])
  })

  it('excludes the email provider from the provider list', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ external: { email: true, google: true } }))
    const result = await fetchAuthSettings()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].id).toBe('google')
  })

  it('excludes the phone provider from the provider list', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ external: { phone: true, google: true } }))
    const result = await fetchAuthSettings()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].id).toBe('google')
  })

  it('returns empty providers when no external providers are enabled', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'
    mockFetch(fakeSettings({ external: { email: true } }))
    const result = await fetchAuthSettings()
    expect(result.providers).toEqual([])
  })
})
