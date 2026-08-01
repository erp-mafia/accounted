import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: vi.fn() }
})

import { cloudBackupExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { CloudBackupStatus } from '../types'
import { createOAuthState } from '../lib/crypto'
import { googleDriveProvider } from '../lib/google-provider'

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
    const route = findRoute('GET', '/oauth/callback')
    const { ctx } = makeContext()
    const exchange = vi.spyOn(googleDriveProvider, 'exchangeCode').mockResolvedValue({
      refreshToken: 'refresh-token',
      accountLabel: 'backup@example.com',
    })
    const callbackUrl = new URL(`${BASE}/oauth/callback`)
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

describe('GET /status', () => {
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

  it('reads each provider schedule separately', async () => {
    const route = findRoute('GET', '/schedule')
    const { ctx } = makeContext({
      google_drive_schedule: { enabled: true, hour_utc: 3, hour_local: 5 },
      dropbox_schedule: { enabled: false, hour_utc: 9, hour_local: 11 },
    })

    const google = await route.handler(makeRequest('/schedule', 'GET'), ctx)
    const dropbox = await route.handler(
      makeRequest('/schedule?provider=dropbox', 'GET'),
      ctx
    )

    await expect(google.json()).resolves.toMatchObject({
      data: { enabled: true, hour_local: 5 },
    })
    await expect(dropbox.json()).resolves.toMatchObject({
      data: { enabled: false, hour_local: 11 },
    })
  })
})
