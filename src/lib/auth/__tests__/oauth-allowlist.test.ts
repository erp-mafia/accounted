import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  builtInRedirectProvider,
  capScopesForRole,
  isAllowedRedirectUri,
  isBuiltInRedirectUri,
  lookupCompanyRole,
  resolveRedirectUri,
} from '../oauth-allowlist'
import { ALL_SCOPES, type ApiKeyScope } from '../scope-catalog'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FLYTT_EXTENSION_ID, FLYTT_EXTENSION_REDIRECT_URI } from '../flytt-extension'

describe('isBuiltInRedirectUri', () => {
  it.each([
    ['https://claude.ai/api/oauth/callback', true],
    ['https://claude.com/api/oauth/callback', true],
    ['https://chatgpt.com/connector/oauth/abc123', true],
    ['https://chatgpt.com/connector_platform_oauth_redirect', true],
    ['https://chatgpt.com/connector_platform_oauth_redirect/extra', false],
    ['https://chatgpt.com/other/path', false],
    ['https://chatgpt.com.evil.com/connector/oauth/x', false],
    ['https://grok.com/connectors-oauth-exchange-code/', true],
    ['https://grok.com/connectors-oauth-exchange-code', true],
    ['https://grok.com/connectors-oauth-exchange-code/extra', false],
    ['https://grok.com/connectors-oauth-exchange-code/?next=x', false],
    ['https://grok.com/other/path', false],
    ['https://grok.com.evil.com/connectors-oauth-exchange-code/', false],
    ['http://grok.com/connectors-oauth-exchange-code/', false],
    ['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1234567890-app_accounted_se', true],
    // Google's relay forwards /r/<id> to a Cloud project of that id: only
    // Gemini's user_bound_ form, which no project id can take, is admitted.
    ['https://oauth-redirect.googleusercontent.com/r/some-cloud-project', false],
    ['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-', false],
    ['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1-x/extra', false],
    ['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1-x?next=x', false],
    ['https://oauth-redirect.googleusercontent.com/user_bound_custom-mcp-1-x', false],
    ['https://oauth-redirect-sandbox.googleusercontent.com/r/user_bound_custom-mcp-1-x', false],
    ['https://oauth-redirect.googleusercontent.com.evil.com/r/user_bound_custom-mcp-1-x', false],
    ['https://evil.googleusercontent.com/r/user_bound_custom-mcp-1-x', false],
    ['http://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1-x', false],
    ['cursor://anysphere.cursor-mcp/oauth/callback', true],
    ['cursor://anysphere.cursor-mcp/oauth/callback/', false],
    ['cursor://anysphere.cursor-mcp/oauth/callback?x=1', false],
    ['cursor://anysphere.cursor-mcp/oauth/callback/extra', false],
    ['cursor://evil.extension/oauth/callback', false],
    ['https://www.cursor.com/agents/mcp/oauth/callback', true],
    ['https://www.cursor.com/agents/mcp/oauth/callback/', false],
    ['https://www.cursor.com/agents/mcp/oauth/callback2', false],
    ['https://cursor.com/agents/mcp/oauth/callback', false],
    ['https://www.cursor.com.evil.com/agents/mcp/oauth/callback', false],
    ['http://www.cursor.com/agents/mcp/oauth/callback', false],
    ['https://squidler.io/api/oauth/callback/accounted', true],
    ['https://dev.squidler.io/api/oauth/callback/accounted', true],
    // Exact paths on Squidler's own two hosts: nothing else on the domain,
    // no other subdomain and no look-alike host rides on the entry.
    ['https://squidler.io/api/oauth/callback/accounted/', false],
    ['https://squidler.io/api/oauth/callback/accounted?next=x', false],
    ['https://squidler.io/api/oauth/callback/accounted/extra', false],
    ['https://squidler.io/api/oauth/callback/other', false],
    ['https://squidler.io/', false],
    ['https://www.squidler.io/api/oauth/callback/accounted', false],
    ['https://staging.squidler.io/api/oauth/callback/accounted', false],
    ['https://squidler.io.evil.com/api/oauth/callback/accounted', false],
    ['https://evilsquidler.io/api/oauth/callback/accounted', false],
    ['http://squidler.io/api/oauth/callback/accounted', false],
    ['http://dev.squidler.io/api/oauth/callback/accounted', false],
    ['https://celemine.com/upstream/accounted/callback', true],
    ['https://celemine.com/upstream/3f2c9a1e-8b4d-4c2a-9e7f-1a2b3c4d5e6f/oauth/callback', true],
    ['https://celemine.com/upstream/callback', true],
    ['https://celemine.com/upstream/callback/', true],
    ['https://celemine.com/upstream/v1.2/cb_x-y', true],
    // A prefix on Celemine's own host, hardened: the bare prefix, dot
    // segments, percent-encoding, query, fragment, empty segments, a
    // backslash, other paths, subdomains, ports, userinfo, look-alike hosts
    // and plain http never match.
    ['https://celemine.com/upstream', false],
    ['https://celemine.com/upstream/', false],
    ['https://celemine.com/upstream/../evil', false],
    ['https://celemine.com/upstream/a/../../evil', false],
    ['https://celemine.com/upstream/./a', false],
    ['https://celemine.com/upstream/%2e%2e/evil', false],
    ['https://celemine.com/upstream/a%2Fb', false],
    ['https://celemine.com/upstream/callback?next=https://evil.com', false],
    ['https://celemine.com/upstream/callback#x', false],
    ['https://celemine.com/upstream//evil.com', false],
    ['https://celemine.com/upstream/a\\evil', false],
    ['https://celemine.com/upstreamx/callback', false],
    ['https://celemine.com/callback', false],
    ['https://www.celemine.com/upstream/callback', false],
    ['https://app.celemine.com/upstream/callback', false],
    ['https://celemine.com:8443/upstream/callback', false],
    ['https://user@celemine.com/upstream/callback', false],
    ['https://celemine.com@evil.com/upstream/callback', false],
    ['https://celemine.com.evil.com/upstream/callback', false],
    ['https://evilcelemine.com/upstream/callback', false],
    ['http://celemine.com/upstream/callback', false],
    // The browser extension's chrome.identity redirect: the one id, the
    // exact root path, https only.
    [FLYTT_EXTENSION_REDIRECT_URI, true],
    [`${FLYTT_EXTENSION_REDIRECT_URI}oauth`, false],
    [`${FLYTT_EXTENSION_REDIRECT_URI}?next=x`, false],
    [FLYTT_EXTENSION_REDIRECT_URI.replace(/\/$/, ''), false],
    [FLYTT_EXTENSION_REDIRECT_URI.replace('https://', 'http://'), false],
    ['https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/', false],
    [`https://x${FLYTT_EXTENSION_ID}.chromiumapp.org/`, false],
    [`https://${FLYTT_EXTENSION_ID}.chromiumapp.org.evil.com/`, false],
    ['http://localhost:8787/callback', true],
    ['http://localhost:3000/cb', true],
    ['http://localhost/cb', true],
    ['http://127.0.0.1:8080/cb', true],
    ['https://evil.com/cb', false],
    ['https://example.com/api/foo', false],
    ['ftp://localhost/cb', false],
    ['', false],
  ])('classifies %s as %s', (uri, expected) => {
    expect(isBuiltInRedirectUri(uri)).toBe(expected)
  })
})

describe('builtInRedirectProvider', () => {
  it.each([
    ['https://claude.ai/api/oauth/callback', 'claude'],
    ['https://claude.com/api/oauth/callback', 'claude'],
    ['https://chatgpt.com/connector/oauth/abc123', 'chatgpt'],
    ['https://chatgpt.com/connector_platform_oauth_redirect', 'chatgpt'],
    ['https://grok.com/connectors-oauth-exchange-code/', 'grok'],
    ['https://grok.com/connectors-oauth-exchange-code/extra', null],
    ['https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1234567890-app_accounted_se', 'gemini'],
    ['https://oauth-redirect.googleusercontent.com/r/some-cloud-project', null],
    ['cursor://anysphere.cursor-mcp/oauth/callback', 'cursor_deeplink'],
    ['https://www.cursor.com/agents/mcp/oauth/callback', 'cursor'],
    ['https://squidler.io/api/oauth/callback/accounted', 'squidler'],
    ['https://dev.squidler.io/api/oauth/callback/accounted', 'squidler'],
    ['https://squidler.io/api/oauth/callback/other', null],
    ['https://celemine.com/upstream/accounted/callback', 'celemine'],
    ['https://celemine.com/upstream/../evil', null],
    [FLYTT_EXTENSION_REDIRECT_URI, 'flytt_extension'],
    ['http://localhost:8787/callback', 'local'],
    ['http://localhost:3000/cb', 'local'],
    ['http://127.0.0.1:8080/cb', 'local'],
    ['https://claude-login.example/cb', null],
    ['', null],
  ])('maps %s to %s', (uri, expected) => {
    expect(builtInRedirectProvider(uri)).toBe(expected)
  })
})

type Row = Record<string, unknown>

/**
 * Minimal PostgREST-shaped fake over in-memory tables: eq/is/in filters are
 * applied, everything else is a no-op, and the chain resolves to the filtered
 * rows (all rows when awaited, first row via maybeSingle). `failTable` makes
 * every query against that table return a DB error.
 */
function fakeClient(tables: Record<string, Row[]>, failTable?: string) {
  const from = vi.fn((table: string) => {
    const filters: [string, unknown][] = []
    const inFilters: [string, unknown[]][] = []
    const run = () =>
      (tables[table] ?? []).filter(
        (row) =>
          filters.every(([col, val]) => (val === null ? row[col] == null : row[col] === val)) &&
          inFilters.every(([col, vals]) => vals.includes(row[col])),
      )
    const result = () =>
      table === failTable
        ? { data: null, error: { message: 'db down' } }
        : { data: run(), error: null }
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'order', 'range', 'limit']) chain[method] = () => chain
    chain.eq = (col: string, val: unknown) => {
      filters.push([col, val])
      return chain
    }
    chain.is = (col: string, val: unknown) => {
      filters.push([col, val])
      return chain
    }
    chain.in = (col: string, vals: unknown[]) => {
      inFilters.push([col, vals])
      return chain
    }
    chain.maybeSingle = async () => {
      const r = result()
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error }
    }
    chain.then = (resolve: (v: unknown) => void) => resolve(result())
    return chain
  })
  return { from } as unknown as SupabaseClient & { from: ReturnType<typeof vi.fn> }
}

const REGISTRATIONS: Row[] = [
  { id: 'reg-1', user_id: 'user-2', client_name: 'Byråns bot', redirect_uri: 'https://app.example.com/cb', revoked_at: null },
  { id: 'reg-2', user_id: 'user-9', client_name: 'Evil', redirect_uri: 'https://evil.example/cb', revoked_at: null },
  { id: 'reg-3', user_id: 'user-1', client_name: 'Min egen app', redirect_uri: 'https://mine.example/cb', revoked_at: null },
  { id: 'reg-4', user_id: 'user-1', client_name: 'Gammal app', redirect_uri: 'https://old.example/cb', revoked_at: '2026-01-01T00:00:00Z' },
  // One fixed callback shared by a third-party tool, registered by two
  // unrelated customers (crm#1654), oldest first.
  { id: 'reg-5', user_id: 'user-9', client_name: 'Verktyg (kund 9)', redirect_uri: 'https://tool.example/cb', revoked_at: null },
  { id: 'reg-6', user_id: 'user-2', client_name: 'Verktyg (byrån)', redirect_uri: 'https://tool.example/cb', revoked_at: null },
  { id: 'reg-7', user_id: 'user-1', client_name: 'Verktyg (mitt)', redirect_uri: 'https://tool.example/cb', revoked_at: null },
]

const MEMBERSHIPS: Row[] = [
  { id: 'm1', user_id: 'user-1', company_id: 'company-1', role: 'owner' },
  { id: 'm2', user_id: 'user-2', company_id: 'company-1', role: 'member' },
  { id: 'm3', user_id: 'user-2', company_id: 'company-2', role: 'owner' },
  { id: 'm4', user_id: 'user-9', company_id: 'company-9', role: 'owner' },
]

const DB = { oauth_client_registrations: REGISTRATIONS, company_members: MEMBERSHIPS }

describe('resolveRedirectUri', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('short-circuits to the built-in provider without touching the DB', async () => {
    const sb = {
      from: vi.fn(() => {
        throw new Error('should not be called')
      }),
    } as unknown as SupabaseClient
    expect(await resolveRedirectUri('https://claude.ai/api/cb', sb, { consentingUserId: 'user-1' })).toEqual({
      allowed: true,
      kind: 'built_in',
      provider: 'claude',
    })
    expect(await resolveRedirectUri('http://localhost:3000/cb', sb)).toEqual({
      allowed: true,
      kind: 'built_in',
      provider: 'local',
    })
  })

  it("accepts the consenting user's own registration", async () => {
    const result = await resolveRedirectUri('https://mine.example/cb', fakeClient(DB), {
      consentingUserId: 'user-1',
    })
    expect(result).toEqual({
      allowed: true,
      kind: 'registered',
      registrationId: 'reg-3',
      clientName: 'Min egen app',
      registeredByConsentingUser: true,
    })
  })

  it('accepts a registration by a colleague who shares a company', async () => {
    const result = await resolveRedirectUri('https://app.example.com/cb', fakeClient(DB), {
      consentingUserId: 'user-1',
    })
    expect(result).toEqual({
      allowed: true,
      kind: 'registered',
      registrationId: 'reg-1',
      clientName: 'Byråns bot',
      registeredByConsentingUser: false,
    })
  })

  it('rejects a registration by an unrelated user', async () => {
    // user-9 is a real member of the instance, just not of any company user-1
    // belongs to: their registration must not be a valid target for user-1.
    const result = await resolveRedirectUri('https://evil.example/cb', fakeClient(DB), {
      consentingUserId: 'user-1',
    })
    expect(result).toEqual({ allowed: false })
  })

  it('accepts any active registration when no consenting user is given (anonymous /register)', async () => {
    const result = await resolveRedirectUri('https://evil.example/cb', fakeClient(DB))
    expect(result).toEqual({
      allowed: true,
      kind: 'registered',
      registrationId: 'reg-2',
      clientName: 'Evil',
      registeredByConsentingUser: false,
    })
  })

  describe('one URI registered by several users (crm#1654)', () => {
    const URI = 'https://tool.example/cb'

    it("takes the consenting user's own registration over older ones by others", async () => {
      expect(await resolveRedirectUri(URI, fakeClient(DB), { consentingUserId: 'user-1' })).toMatchObject({
        allowed: true, registrationId: 'reg-7', registeredByConsentingUser: true,
      })
      expect(await resolveRedirectUri(URI, fakeClient(DB), { consentingUserId: 'user-9' })).toMatchObject({
        allowed: true, registrationId: 'reg-5', registeredByConsentingUser: true,
      })
    })

    it("falls back to a colleague's registration, never an unrelated user's", async () => {
      // user-3 shares company-2 with user-2 only: user-9's older row must not count.
      const db = {
        oauth_client_registrations: REGISTRATIONS.filter((r) => r.id !== 'reg-7'),
        company_members: [...MEMBERSHIPS, { id: 'm5', user_id: 'user-3', company_id: 'company-2', role: 'member' }],
      }
      expect(await resolveRedirectUri(URI, fakeClient(db), { consentingUserId: 'user-3' })).toMatchObject({
        allowed: true, registrationId: 'reg-6', registeredByConsentingUser: false,
      })
    })

    it('rejects a user with no registration and no colleague among the registrants', async () => {
      const db = {
        oauth_client_registrations: REGISTRATIONS,
        company_members: [...MEMBERSHIPS, { id: 'm6', user_id: 'user-4', company_id: 'company-4', role: 'owner' }],
      }
      expect(await resolveRedirectUri(URI, fakeClient(db), { consentingUserId: 'user-4' })).toEqual({ allowed: false })
    })

    it('accepts the oldest registration for the anonymous /register lookup', async () => {
      expect(await resolveRedirectUri(URI, fakeClient(DB))).toMatchObject({ allowed: true, registrationId: 'reg-5' })
    })
  })

  it('rejects a revoked registration, even the user’s own', async () => {
    const result = await resolveRedirectUri('https://old.example/cb', fakeClient(DB), {
      consentingUserId: 'user-1',
    })
    expect(result).toEqual({ allowed: false })
  })

  it('rejects an unknown URI', async () => {
    expect(await resolveRedirectUri('https://nowhere.example/cb', fakeClient(DB))).toEqual({ allowed: false })
  })

  it('fails closed when the registration lookup errors', async () => {
    const result = await resolveRedirectUri(
      'https://mine.example/cb',
      fakeClient(DB, 'oauth_client_registrations'),
      { consentingUserId: 'user-1' },
    )
    expect(result).toEqual({ allowed: false })
  })

  it('fails closed when the shared-company check errors', async () => {
    const result = await resolveRedirectUri('https://app.example.com/cb', fakeClient(DB, 'company_members'), {
      consentingUserId: 'user-1',
    })
    expect(result).toEqual({ allowed: false })
  })

  it('fails closed when no client is given and none can be constructed', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(await resolveRedirectUri('https://mine.example/cb', undefined, { consentingUserId: 'user-1' })).toEqual({
      allowed: false,
    })
  })

  it('returns not allowed for empty / non-string inputs', async () => {
    expect(await resolveRedirectUri('')).toEqual({ allowed: false })
    expect(await resolveRedirectUri(undefined as unknown as string)).toEqual({ allowed: false })
  })
})

describe('isAllowedRedirectUri', () => {
  it('is the boolean view of resolveRedirectUri', async () => {
    expect(await isAllowedRedirectUri('https://claude.ai/api/cb')).toBe(true)
    expect(await isAllowedRedirectUri('https://mine.example/cb', fakeClient(DB), { consentingUserId: 'user-1' })).toBe(true)
    expect(await isAllowedRedirectUri('https://evil.example/cb', fakeClient(DB), { consentingUserId: 'user-1' })).toBe(false)
    expect(await isAllowedRedirectUri('https://evil.example/cb', fakeClient(DB))).toBe(true)
    expect(await isAllowedRedirectUri('', fakeClient(DB))).toBe(false)
  })
})

describe('capScopesForRole', () => {
  const mixed: ApiKeyScope[] = [
    'transactions:read',
    'transactions:write',
    'pending_operations:approve',
    'webhooks:manage',
    'reconciliation:signoff',
    'reports:read',
  ]

  it('keeps every scope for owner, admin and member', () => {
    for (const role of ['owner', 'admin', 'member']) {
      expect(capScopesForRole(mixed, role)).toEqual(mixed)
    }
  })

  it('caps a viewer to :read scopes only', () => {
    expect(capScopesForRole(mixed, 'viewer')).toEqual(['transactions:read', 'reports:read'])
  })

  it('caps an invoicer to the customer, invoice and article scopes, read and write', () => {
    expect([...capScopesForRole(ALL_SCOPES, 'invoicer')].sort()).toEqual([
      'articles:read',
      'articles:write',
      'customers:read',
      'customers:write',
      'invoices:draft',
      'invoices:read',
      'invoices:write',
    ])
    expect(capScopesForRole(mixed, 'invoicer')).toEqual([])
  })

  it('caps an unknown role and a missing membership to :read scopes', () => {
    expect(capScopesForRole(mixed, 'superuser')).toEqual(['transactions:read', 'reports:read'])
    expect(capScopesForRole(mixed, null)).toEqual(['transactions:read', 'reports:read'])
  })

  it('leaves no write-kind scope in a capped set for the full catalogue', () => {
    const capped = capScopesForRole(ALL_SCOPES, 'viewer')
    expect(capped.length).toBeGreaterThan(0)
    expect(capped.every((s) => s.endsWith(':read'))).toBe(true)
    expect(capped).not.toContain('pending_operations:approve')
  })

  it('returns a copy, never the caller’s array', () => {
    const result = capScopesForRole(mixed, 'owner')
    expect(result).not.toBe(mixed)
  })
})

describe('lookupCompanyRole', () => {
  it('returns the role for an existing membership', async () => {
    expect(await lookupCompanyRole(fakeClient(DB), 'user-2', 'company-1')).toEqual({ role: 'member', error: null })
    expect(await lookupCompanyRole(fakeClient(DB), 'user-2', 'company-2')).toEqual({ role: 'owner', error: null })
  })

  it('returns a null role when no membership row exists', async () => {
    expect(await lookupCompanyRole(fakeClient(DB), 'user-9', 'company-1')).toEqual({ role: null, error: null })
  })

  it('surfaces a query error instead of guessing', async () => {
    const result = await lookupCompanyRole(fakeClient(DB, 'company_members'), 'user-1', 'company-1')
    expect(result.role).toBeNull()
    expect(result.error).toBe('db down')
  })
})

describe('builtInOnwardOrigins', () => {
  it("names cursor.com for Cursor's web callback, which forwards there", async () => {
    const { builtInOnwardOrigins } = await import('../oauth-allowlist')
    expect(builtInOnwardOrigins('https://www.cursor.com/agents/mcp/oauth/callback')).toEqual(['https://cursor.com'])
  })

  it('names nothing for other callbacks, or for a www.cursor.com path that is not allowlisted', async () => {
    const { builtInOnwardOrigins } = await import('../oauth-allowlist')
    expect(builtInOnwardOrigins('https://claude.ai/api/mcp/auth_callback')).toEqual([])
    expect(builtInOnwardOrigins('cursor://anysphere.cursor-mcp/oauth/callback')).toEqual([])
    expect(builtInOnwardOrigins('https://www.cursor.com/other')).toEqual([])
    expect(builtInOnwardOrigins('not a url')).toEqual([])
  })
})
