import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  disconnectMailbox,
  isGoogleConsentUrl,
  parseMailCallback,
  parseMailConnections,
  reconnectReason,
  requestMailConnect,
  summarizeMailboxes,
  type MailConnection,
  type MailConnectionsView,
} from '@/components/extensions/general/mail-connections'

function mailbox(overrides: Partial<MailConnection> = {}): MailConnection {
  return {
    id: 'c1',
    provider: 'gmail',
    emailAddress: 'kvitton@example.se',
    scopeLabel: 'gmail.readonly',
    status: 'active',
    lastSearchedAt: null,
    lastErrorCode: null,
    ...overrides,
  }
}

function view(overrides: Partial<MailConnectionsView> = {}): MailConnectionsView {
  return { connections: [], configured: true, connectEnabled: true, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseMailConnections', () => {
  it('reads the contract shape', () => {
    const parsed = parseMailConnections({
      data: {
        connections: [mailbox({ lastSearchedAt: '2026-09-20T10:00:00Z' })],
        configured: true,
        connectEnabled: true,
      },
    })
    expect(parsed).toEqual(view({ connections: [mailbox({ lastSearchedAt: '2026-09-20T10:00:00Z' })] }))
  })

  it('drops rows that are not mailboxes instead of rendering them half', () => {
    const parsed = parseMailConnections({
      data: {
        connections: [mailbox(), { id: 'c2', status: 'active' }, mailbox({ id: 'c3', status: 'unknown' as never })],
        configured: true,
        connectEnabled: false,
      },
    })
    expect(parsed?.connections.map((c) => c.id)).toEqual(['c1'])
  })

  it('offers no connect unless the answer says so', () => {
    const parsed = parseMailConnections({ data: { connections: [] } })
    expect(parsed).toEqual(view({ configured: false, connectEnabled: false }))
  })

  it('returns null for anything but the contract', () => {
    expect(parseMailConnections(null)).toBeNull()
    expect(parseMailConnections({ data: { connections: 'none' } })).toBeNull()
    expect(parseMailConnections({ error: 'Missing context' })).toBeNull()
  })
})

describe('reconnectReason', () => {
  it('is null while the mailbox can be read', () => {
    expect(reconnectReason(mailbox())).toBeNull()
  })

  it('names the unticked Gmail box and the ended grant, and nothing else', () => {
    expect(reconnectReason(mailbox({ status: 'needs_reconsent', lastErrorCode: 'scope_missing' }))).toBe('scope_missing')
    expect(reconnectReason(mailbox({ status: 'needs_reconsent', lastErrorCode: 'invalid_grant' }))).toBe('access_ended')
    expect(reconnectReason(mailbox({ status: 'needs_reconsent', lastErrorCode: null }))).toBe('other')
    expect(reconnectReason(mailbox({ status: 'revoked', lastErrorCode: null }))).toBe('other')
  })
})

describe('summarizeMailboxes', () => {
  it('counts only the mailboxes the hunt reads as active', () => {
    const summary = summarizeMailboxes(
      view({
        connections: [
          mailbox({ id: 'a' }),
          mailbox({ id: 'b', status: 'needs_reconsent', lastErrorCode: 'scope_missing' }),
          mailbox({ id: 'c', status: 'revoked' }),
        ],
      }),
    )
    expect(summary.active.map((c) => c.id)).toEqual(['a'])
    expect(summary.needsReconnect.map((c) => c.id)).toEqual(['b', 'c'])
  })

  it('needs both credentials and the review allowlist to connect', () => {
    expect(summarizeMailboxes(view()).canConnect).toBe(true)
    expect(summarizeMailboxes(view({ connectEnabled: false })).canConnect).toBe(false)
    expect(summarizeMailboxes(view({ configured: false })).canConnect).toBe(false)
  })

  it('is not offered while connecting is closed and nothing is connected', () => {
    // A row or door leading to a page with no connect button is a dead end.
    expect(summarizeMailboxes(view({ connectEnabled: false })).available).toBe(false)
    expect(summarizeMailboxes(null).available).toBe(false)
  })

  it('stays offered for an existing mailbox even while connecting is closed', () => {
    const summary = summarizeMailboxes(view({ connectEnabled: false, connections: [mailbox()] }))
    expect(summary.available).toBe(true)
    expect(summary.canConnect).toBe(false)
  })
})

describe('parseMailCallback', () => {
  it('accepts every code the OAuth callback sends, scope_missing included', () => {
    for (const code of ['connected', 'denied', 'invalid', 'expired', 'mismatch', 'no_refresh_token', 'no_address', 'failed', 'scope_missing']) {
      expect(parseMailCallback(code)).toBe(code)
    }
  })

  it('ignores anything else', () => {
    expect(parseMailCallback(null)).toBeNull()
    expect(parseMailCallback('')).toBeNull()
    expect(parseMailCallback('<script>')).toBeNull()
  })
})

describe('isGoogleConsentUrl', () => {
  it('accepts only Google accounts over https', () => {
    expect(isGoogleConsentUrl('https://accounts.google.com/o/oauth2/v2/auth?scope=x')).toBe(true)
    expect(isGoogleConsentUrl('http://accounts.google.com/o/oauth2/v2/auth')).toBe(false)
    expect(isGoogleConsentUrl('https://accounts.google.com.evil.example/o/oauth2')).toBe(false)
    expect(isGoogleConsentUrl('https://evil.example/?next=https://accounts.google.com')).toBe(false)
    expect(isGoogleConsentUrl('/settings/mail')).toBe(false)
  })
})

describe('requestMailConnect', () => {
  function stubFetch(response: Response | Error) {
    const fetchMock = vi.fn(async () => {
      if (response instanceof Error) throw response
      return response
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('hands back the consent URL from a POST to the start route', async () => {
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'
    const fetchMock = stubFetch(new Response(JSON.stringify({ url }), { status: 200 }))

    await expect(requestMailConnect()).resolves.toEqual({ ok: true, url })
    expect(fetchMock).toHaveBeenCalledWith('/api/extensions/ext/mail/oauth/start', { method: 'POST' })
  })

  it('refuses to follow a URL that is not Google consent', async () => {
    stubFetch(new Response(JSON.stringify({ url: 'https://evil.example/login' }), { status: 200 }))
    await expect(requestMailConnect()).resolves.toEqual({ ok: false, reason: 'failed' })
  })

  it('names the closed review gate and the missing credentials', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'connect_disabled' }), { status: 403 }))
    await expect(requestMailConnect()).resolves.toEqual({ ok: false, reason: 'connect_disabled' })

    stubFetch(new Response(JSON.stringify({ error: 'provider_not_configured' }), { status: 400 }))
    await expect(requestMailConnect()).resolves.toEqual({ ok: false, reason: 'not_configured' })
  })

  it('never throws', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    await expect(requestMailConnect()).resolves.toEqual({ ok: false, reason: 'failed' })

    stubFetch(new Response('<html>500</html>', { status: 500 }))
    await expect(requestMailConnect()).resolves.toEqual({ ok: false, reason: 'failed' })
  })
})

describe('disconnectMailbox', () => {
  it('deletes by encoded id and reports the outcome', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { disconnected: true } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(disconnectMailbox('a b&c')).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/extensions/ext/mail/connections?id=a%20b%26c', { method: 'DELETE' })
  })

  it('tells a refusal by role apart from a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'disconnect_not_allowed' }), { status: 403 })),
    )
    await expect(disconnectMailbox('c1')).resolves.toEqual({ ok: false, reason: 'not_allowed' })
  })

  it('is a failure on any other refusal or a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    await expect(disconnectMailbox('c1')).resolves.toEqual({ ok: false, reason: 'failed' })

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    await expect(disconnectMailbox('c1')).resolves.toEqual({ ok: false, reason: 'failed' })
  })
})
