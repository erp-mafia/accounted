import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: vi.fn() }
})

// /connect validates the starting host against the brands table.
const resolveBrandByHost = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({ resolveBrandByHost }))

// Disconnect asks the service role whether another company shares the grant.
const sharedLookup = vi.hoisted(() => ({
  result: { count: 0 as number | null, error: null as { message: string } | null },
  calls: [] as unknown[][],
}))
vi.mock('@/lib/supabase/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase/server')>()
  const query: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => resolve(sharedLookup.result),
  }
  for (const method of ['from', 'select', 'eq', 'neq']) {
    query[method] = (...args: unknown[]) => {
      sharedLookup.calls.push([method, ...args])
      return query
    }
  }
  return { ...actual, createServiceClient: () => query }
})

import { cloudBackupExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { CloudBackupStatus } from '../types'
import { createOAuthState, encryptToken, verifyOAuthState } from '../lib/crypto'
import { googleDriveProvider } from '../lib/google-provider'
import { dropboxProvider } from '../lib/dropbox-provider'
import { CloudScopeMissingError } from '../lib/cloud-provider'

const BASE = 'https://test.local/api/extensions/ext/cloud-backup'

function findRoute(method: string, path: string) {
  const route = cloudBackupExtension.apiRoutes?.find(
    (r) => r.method === method && r.path === path
  )
  expect(route, `${method} ${path} must be registered`).toBeDefined()
  return route!
}

function makeRequest(path: string, method = 'POST', body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
}

/** Settings backed by a map, so a test can assert which keys were touched. */
function makeContext(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed))
  const set = vi.fn().mockImplementation(async (key: string, value: unknown) => {
    store.set(key, value)
  })
  const clear = vi.fn().mockImplementation(async (key: string) => {
    store.delete(key)
  })
  const ctx = {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'cloud-backup',
    requestId: 'req_test',
    supabase: {},
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      set,
      clear,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ExtensionContext
  return { ctx, store, set, clear }
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    refresh_token_encrypted: 'enc',
    account_email: 'user@example.com',
    connected_at: '2026-01-01T00:00:00.000Z',
    root_folder_id: null,
    company_folder_id: null,
    ...overrides,
  }
}

const ENV_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'DROPBOX_APP_KEY',
  'DROPBOX_APP_SECRET',
  // The OAuth state parameter is encrypted with a key derived from this.
  'SUPABASE_SERVICE_ROLE_KEY',
  // Canonical app origin. Cleared so request-origin fallback tests remain
  // deterministic regardless of the runner's environment.
  'NEXT_PUBLIC_APP_URL',
] as const
const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key]
  process.env.GOOGLE_CLIENT_ID = 'google-id'
  process.env.GOOGLE_CLIENT_SECRET = 'google-secret'
  process.env.DROPBOX_APP_KEY = 'dropbox-key'
  process.env.DROPBOX_APP_SECRET = 'dropbox-secret'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
  delete process.env.NEXT_PUBLIC_APP_URL
  resolveBrandByHost.mockResolvedValue(null)
  sharedLookup.result = { count: 0, error: null }
  sharedLookup.calls = []
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

describe('provider routing', () => {
  it('rejects an unknown provider rather than defaulting to a destination', async () => {
    const route = findRoute('POST', '/connect')
    const { ctx } = makeContext()

    const res = await route.handler(makeRequest('/connect?provider=onedrive'), ctx)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'unknown_provider' })
  })

  it('treats a missing provider as Google Drive, as pre-Dropbox clients meant', async () => {
    const route = findRoute('POST', '/connect')
    const { ctx } = makeContext()

    const res = await route.handler(makeRequest('/connect'), ctx)

    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url).toContain('accounts.google.com')
  })

  it('sends the user to Dropbox with an app-folder scope set', async () => {
    const route = findRoute('POST', '/connect')
    const { ctx } = makeContext()

    const res = await route.handler(makeRequest('/connect?provider=dropbox'), ctx)

    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://www.dropbox.com/oauth2/authorize')
    // Without offline access Dropbox issues no refresh token and the nightly
    // cron dies a few hours after connecting.
    expect(parsed.searchParams.get('token_access_type')).toBe('offline')
    expect(parsed.searchParams.get('scope')).toBe(
      'files.content.write files.content.read account_info.read'
    )
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://test.local/api/extensions/ext/cloud-backup/oauth/dropbox/callback'
    )
    expect(parsed.searchParams.get('state')).toBeTruthy()
  })

  it('refuses to start a flow the deployment has no credentials for', async () => {
    delete process.env.DROPBOX_APP_KEY
    delete process.env.DROPBOX_APP_SECRET
    const route = findRoute('POST', '/connect')
    const { ctx } = makeContext()

    const res = await route.handler(makeRequest('/connect?provider=dropbox'), ctx)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'provider_not_configured' })
  })

  it('registers a separate OAuth callback per provider', () => {
    expect(findRoute('GET', '/oauth/callback')).toBeDefined()
    expect(findRoute('GET', '/oauth/dropbox/callback')).toBeDefined()
  })
})

describe('canonical redirect URI', () => {
  it('builds the Google callback from NEXT_PUBLIC_APP_URL, not the request host', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.se'
    const route = findRoute('POST', '/connect')
    const { ctx } = makeContext()

    const res = await route.handler(makeRequest('/connect?provider=google_drive'), ctx)

    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(
      'https://app.accounted.se/api/extensions/ext/cloud-backup/oauth/callback'
    )
  })

  it('builds the Dropbox callback from NEXT_PUBLIC_APP_URL, not the request host', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.se'
    const route = findRoute('POST', '/connect')
    const { ctx } = makeContext()

    const res = await route.handler(makeRequest('/connect?provider=dropbox'), ctx)

    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(
      'https://app.accounted.se/api/extensions/ext/cloud-backup/oauth/dropbox/callback'
    )
  })

  it('uses the same canonical origin for the callback token exchange', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.se'
    const route = findRoute('GET', '/oauth/complete')
    const { ctx } = makeContext()
    const exchange = vi.spyOn(googleDriveProvider, 'exchangeCode').mockResolvedValue({
      refreshToken: 'refresh-token',
      accountLabel: 'backup@example.com',
    })
    const callbackUrl = new URL(`${BASE}/oauth/complete?provider=google_drive`)
    callbackUrl.searchParams.set('code', 'provider-code')
    callbackUrl.searchParams.set('state', createOAuthState(ctx.userId, ctx.companyId))

    const res = await route.handler(new Request(callbackUrl), ctx)

    expect(exchange).toHaveBeenCalledWith('https://app.accounted.se', 'provider-code')
    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe('https://app.accounted.se')
    expect(location.pathname).toBe('/settings/backup')
    expect(location.searchParams.get('cloud_backup')).toBe('connected_first')
  })
})

describe('connecting from a brand domain', () => {
  const BRAND = 'https://byra.example.se'
  const APP = 'https://app.accounted.se'

  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = APP
    resolveBrandByHost.mockImplementation(async (host: string) =>
      host === 'byra.example.se' ? { domain: 'byra.example.se' } : null
    )
  })

  it('records the brand origin in the state and keeps the registered redirect URI', async () => {
    const route = findRoute('POST', '/connect')
    const { ctx } = makeContext()
    const request = new Request(`${BRAND}/api/extensions/ext/cloud-backup/connect`, {
      method: 'POST',
    })

    const res = await route.handler(request, ctx)

    const { url } = (await res.json()) as { url: string }
    const params = new URL(url).searchParams
    expect(params.get('redirect_uri')).toBe(
      `${APP}/api/extensions/ext/cloud-backup/oauth/callback`
    )
    expect(verifyOAuthState(params.get('state')!)?.origin).toBe(BRAND)
  })

  it('records the app origin for a host that is not a brand', async () => {
    const route = findRoute('POST', '/connect')
    const { ctx } = makeContext()
    const request = new Request('https://evil.example.com/api/extensions/ext/cloud-backup/connect', {
      method: 'POST',
    })

    const res = await route.handler(request, ctx)

    const { url } = (await res.json()) as { url: string }
    const state = new URL(url).searchParams.get('state')!
    expect(verifyOAuthState(state)?.origin).toBe(APP)
  })

  it.each([
    ['/oauth/callback', 'google_drive'],
    ['/oauth/dropbox/callback', 'dropbox'],
  ])('%s needs no session and forwards the answer to the brand domain', (path, providerId) => {
    const route = findRoute('GET', path)
    expect(route.skipAuth).toBe(true)
    const state = createOAuthState('user-1', 'company-1', BRAND)
    const callbackUrl = new URL(`${APP}/api/extensions/ext/cloud-backup${path}`)
    callbackUrl.searchParams.set('code', 'provider-code')
    callbackUrl.searchParams.set('state', state)

    return (route.handler as (r: Request) => Promise<Response>)(new Request(callbackUrl)).then(
      (res) => {
        const location = new URL(res.headers.get('location')!)
        expect(location.origin).toBe(BRAND)
        expect(location.pathname).toBe('/api/extensions/ext/cloud-backup/oauth/complete')
        expect(location.searchParams.get('code')).toBe('provider-code')
        expect(location.searchParams.get('state')).toBe(state)
        expect(location.searchParams.get('provider')).toBe(providerId)
      }
    )
  })

  it('forwards a state that does not verify to the app, never elsewhere', async () => {
    const route = findRoute('GET', '/oauth/callback')
    const callbackUrl = new URL(`${APP}/api/extensions/ext/cloud-backup/oauth/callback`)
    callbackUrl.searchParams.set('code', 'provider-code')
    callbackUrl.searchParams.set('state', 'forged')

    const res = await (route.handler as (r: Request) => Promise<Response>)(
      new Request(callbackUrl)
    )

    expect(new URL(res.headers.get('location')!).origin).toBe(APP)
  })

  it('finishes on the brand domain and exchanges against the registered URI', async () => {
    const route = findRoute('GET', '/oauth/complete')
    const { ctx, set } = makeContext()
    const exchange = vi.spyOn(dropboxProvider, 'exchangeCode').mockResolvedValue({
      refreshToken: 'refresh-token',
      accountLabel: 'backup@example.com',
    })
    const completeUrl = new URL(
      `${BRAND}/api/extensions/ext/cloud-backup/oauth/complete?provider=dropbox`
    )
    completeUrl.searchParams.set('code', 'provider-code')
    completeUrl.searchParams.set('state', createOAuthState(ctx.userId, ctx.companyId, BRAND))

    const res = await route.handler(new Request(completeUrl), ctx)

    expect(exchange).toHaveBeenCalledWith(APP, 'provider-code')
    expect(set).toHaveBeenCalledWith('dropbox_connection', expect.anything())
    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe(BRAND)
    expect(location.pathname).toBe('/settings/backup')
    expect(location.searchParams.get('cloud_backup')).toBe('connected_first')
  })
})

describe('OAuth callback with the storage box unticked (B12)', () => {
  it('stores nothing and sends the user back with reason missing_scope', async () => {
    const route = findRoute('GET', '/oauth/complete')
    const { ctx, set } = makeContext()
    vi.spyOn(googleDriveProvider, 'exchangeCode').mockRejectedValue(
      new CloudScopeMissingError('Google Drive', 'granted: openid email')
    )
    const callbackUrl = new URL(`${BASE}/oauth/complete?provider=google_drive`)
    callbackUrl.searchParams.set('code', 'provider-code')
    callbackUrl.searchParams.set('state', createOAuthState(ctx.userId, ctx.companyId))

    const res = await route.handler(new Request(callbackUrl), ctx)

    const location = new URL(res.headers.get('location')!)
    expect(location.searchParams.get('cloud_backup')).toBe('error')
    expect(location.searchParams.get('reason')).toBe('missing_scope')
    expect(location.searchParams.get('provider')).toBe('google_drive')
    expect(set).not.toHaveBeenCalled()
    // The person's choice, not our failure: no error-level log.
    expect(ctx.log.error).not.toHaveBeenCalled()
  })
})

describe('GET /status', () => {
  it('says why a connection needs reconnecting', async () => {
    const route = findRoute('GET', '/status')
    const { ctx } = makeContext({
      google_drive_connection: makeConnection({
        status: 'needs_reauth',
        needs_reauth_reason: 'missing_scope',
      }),
      // Flagged before the reason existed: read as a dead token.
      dropbox_connection: makeConnection({ status: 'needs_reauth' }),
    })

    const res = await route.handler(makeRequest('/status', 'GET'), ctx)
    const { data } = (await res.json()) as { data: CloudBackupStatus }

    expect(data.providers[0]).toMatchObject({ needs_reauth: true, reauth_reason: 'missing_scope' })
    expect(data.providers[1]).toMatchObject({ needs_reauth: true, reauth_reason: 'token_revoked' })
  })

  it('reports no reason for a healthy connection', async () => {
    const route = findRoute('GET', '/status')
    const { ctx } = makeContext({ google_drive_connection: makeConnection() })

    const res = await route.handler(makeRequest('/status', 'GET'), ctx)
    const { data } = (await res.json()) as { data: CloudBackupStatus }

    expect(data.providers[0].reauth_reason).toBeNull()
  })

  it('reports every provider independently', async () => {
    const route = findRoute('GET', '/status')
    const { ctx } = makeContext({
      google_drive_connection: makeConnection({ account_email: 'a@example.com' }),
      dropbox_connection: makeConnection({
        account_email: 'b@example.com',
        status: 'needs_reauth',
      }),
    })

    const res = await route.handler(makeRequest('/status', 'GET'), ctx)
    const { data } = (await res.json()) as { data: CloudBackupStatus }

    expect(data.providers.map((p) => p.provider)).toEqual(['google_drive', 'dropbox'])
    const google = data.providers[0]
    const dropbox = data.providers[1]
    expect(google).toMatchObject({
      connected: true,
      needs_reauth: false,
      account_email: 'a@example.com',
    })
    expect(dropbox).toMatchObject({
      connected: true,
      needs_reauth: true,
      account_email: 'b@example.com',
    })
  })

  it('flags a provider the deployment cannot use so the UI can disable the row', async () => {
    delete process.env.DROPBOX_APP_KEY
    delete process.env.DROPBOX_APP_SECRET
    const route = findRoute('GET', '/status')
    const { ctx } = makeContext()

    const res = await route.handler(makeRequest('/status', 'GET'), ctx)
    const { data } = (await res.json()) as { data: CloudBackupStatus }

    expect(data.providers.find((p) => p.provider === 'google_drive')?.configured).toBe(true)
    expect(data.providers.find((p) => p.provider === 'dropbox')?.configured).toBe(false)
  })

  it('keeps mirroring Google Drive at the top level for pre-Dropbox clients', async () => {
    const route = findRoute('GET', '/status')
    const { ctx } = makeContext({
      google_drive_connection: makeConnection({ account_email: 'a@example.com' }),
    })

    const res = await route.handler(makeRequest('/status', 'GET'), ctx)
    const { data } = (await res.json()) as { data: CloudBackupStatus }

    expect(data.connected).toBe(true)
    expect(data.account_email).toBe('a@example.com')
  })

  it('does not report a Dropbox connection as a Google one at the top level', async () => {
    const route = findRoute('GET', '/status')
    const { ctx } = makeContext({ dropbox_connection: makeConnection() })

    const res = await route.handler(makeRequest('/status', 'GET'), ctx)
    const { data } = (await res.json()) as { data: CloudBackupStatus }

    // The legacy fields describe Google Drive alone: a dashboard banner reading
    // them must not claim the Drive backup is healthy because Dropbox is.
    expect(data.connected).toBe(false)
    expect(data.account_email).toBeNull()
  })
})

describe('POST /disconnect', () => {
  it('clears only the targeted provider records', async () => {
    const route = findRoute('POST', '/disconnect')
    const { ctx, store } = makeContext({
      google_drive_connection: makeConnection(),
      google_drive_last_sync: { at: 'x', folder_id: 'f' },
      google_drive_schedule: { enabled: true },
      dropbox_connection: makeConnection(),
      dropbox_last_sync: { at: 'y', folder_id: '/g' },
      dropbox_schedule: { enabled: true },
    })

    const res = await route.handler(makeRequest('/disconnect?provider=dropbox'), ctx)

    expect(res.status).toBe(200)
    expect([...store.keys()].sort()).toEqual([
      'google_drive_connection',
      'google_drive_last_sync',
      'google_drive_schedule',
    ])
  })

  it('does not revoke a Google grant another company still uses', async () => {
    const route = findRoute('POST', '/disconnect')
    const revoke = vi.spyOn(googleDriveProvider, 'revoke').mockResolvedValue()
    sharedLookup.result = { count: 1, error: null }
    const { ctx, store } = makeContext({
      google_drive_connection: makeConnection({ refresh_token_encrypted: encryptToken('rt') }),
    })

    const res = await route.handler(makeRequest('/disconnect?provider=google_drive'), ctx)

    expect(res.status).toBe(200)
    expect(revoke).not.toHaveBeenCalled()
    expect(store.has('google_drive_connection')).toBe(false)
    expect(sharedLookup.calls).toContainEqual(['eq', 'value->>account_email', 'user@example.com'])
    expect(sharedLookup.calls).toContainEqual(['neq', 'company_id', 'company-1'])
  })

  it('does not revoke a connection with no account to compare', async () => {
    const route = findRoute('POST', '/disconnect')
    const revoke = vi.spyOn(googleDriveProvider, 'revoke').mockResolvedValue()
    const { ctx } = makeContext({
      google_drive_connection: makeConnection({
        account_email: '',
        refresh_token_encrypted: encryptToken('rt'),
      }),
    })

    await route.handler(makeRequest('/disconnect?provider=google_drive'), ctx)

    expect(revoke).not.toHaveBeenCalled()
  })

  it('revokes a grant no other company uses', async () => {
    const route = findRoute('POST', '/disconnect')
    const revoke = vi.spyOn(googleDriveProvider, 'revoke').mockResolvedValue()
    const { ctx } = makeContext({
      google_drive_connection: makeConnection({ refresh_token_encrypted: encryptToken('rt') }),
    })

    await route.handler(makeRequest('/disconnect?provider=google_drive'), ctx)

    expect(revoke).toHaveBeenCalledWith('rt', expect.any(String))
  })

  it('does not revoke when it cannot tell whether the grant is shared', async () => {
    const route = findRoute('POST', '/disconnect')
    const revoke = vi.spyOn(googleDriveProvider, 'revoke').mockResolvedValue()
    sharedLookup.result = { count: null, error: { message: 'timeout' } }
    const { ctx, store } = makeContext({
      google_drive_connection: makeConnection({ refresh_token_encrypted: encryptToken('rt') }),
    })

    const res = await route.handler(makeRequest('/disconnect?provider=google_drive'), ctx)

    expect(res.status).toBe(200)
    expect(revoke).not.toHaveBeenCalled()
    expect(store.has('google_drive_connection')).toBe(false)
  })

  it('still works when the deployment lost its credentials', async () => {
    // A user must never be trapped with a connection they cannot remove.
    delete process.env.DROPBOX_APP_KEY
    delete process.env.DROPBOX_APP_SECRET
    const route = findRoute('POST', '/disconnect')
    const { ctx, store } = makeContext({ dropbox_connection: makeConnection() })

    const res = await route.handler(makeRequest('/disconnect?provider=dropbox'), ctx)

    expect(res.status).toBe(200)
    expect(store.has('dropbox_connection')).toBe(false)
  })
})

describe('schedule routes are per provider', () => {
  it('writes the schedule under the targeted provider key', async () => {
    const route = findRoute('PUT', '/schedule')
    const { ctx, store } = makeContext()

    const res = await route.handler(
      makeRequest('/schedule?provider=dropbox', 'PUT', { enabled: true, hour_local: 4 }),
      ctx
    )

    expect(res.status).toBe(200)
    expect(store.has('dropbox_schedule')).toBe(true)
    expect(store.has('google_drive_schedule')).toBe(false)
  })
})
