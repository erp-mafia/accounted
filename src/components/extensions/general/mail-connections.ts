import { notifySessionExpired } from '@/lib/auth/session-timeout-shared'

/**
 * The Gmail connections, as the browser sees them.
 *
 * Three surfaces show a mailbox: its own settings page (connect, list,
 * disconnect), the Kopplingar hub row (its state) and the Gmail door in
 * Underlag (what is searched, and whether a mailbox has stopped working).
 * What counts as connected, as needing reconnection, or as worth offering at
 * all is decided here once, so the three can never disagree about the same
 * mailbox.
 *
 * The routes answer a safe projection and never a token: see
 * extensions/general/mail/lib/connections.ts.
 */

export const MAIL_ROUTE_BASE = '/api/extensions/ext/mail'

/** Kopplingar > Gmail: where a mailbox is connected, reconnected and disconnected. */
export const MAIL_SETTINGS_HREF = '/settings/mail'

/** Google's consent screen. The only place a connect may navigate to. */
const GOOGLE_CONSENT_ORIGIN = 'https://accounts.google.com'

export type MailConnectionStatus = 'active' | 'needs_reconsent' | 'revoked'

const STATUSES: ReadonlySet<string> = new Set(['active', 'needs_reconsent', 'revoked'])

export interface MailConnection {
  id: string
  provider: 'gmail' | 'microsoft'
  emailAddress: string
  scopeLabel: string | null
  status: MailConnectionStatus
  lastSearchedAt: string | null
  lastErrorCode: string | null
}

export interface MailConnectionsView {
  connections: MailConnection[]
  /** The installation has Google OAuth credentials at all. */
  configured: boolean
  /**
   * This company may start a NEW consent. False on hosted while Google's
   * restricted-scope review is open, except for allowlisted companies.
   * Listing and disconnecting existing mailboxes never depend on it.
   */
  connectEnabled: boolean
}

function isMailConnection(value: unknown): value is MailConnection {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.emailAddress === 'string' &&
    typeof row.status === 'string' &&
    STATUSES.has(row.status)
  )
}

/**
 * Read the connections route's body. Null when it is not the shape the
 * contract promises: a surface then says it could not read the mailboxes
 * rather than listing a half-parsed one.
 */
export function parseMailConnections(body: unknown): MailConnectionsView | null {
  const data = (body as { data?: unknown } | null)?.data
  if (!data || typeof data !== 'object') return null
  const raw = data as { connections?: unknown; configured?: unknown; connectEnabled?: unknown }
  if (!Array.isArray(raw.connections)) return null
  return {
    connections: raw.connections.filter(isMailConnection).map((row) => ({
      id: row.id,
      provider: row.provider === 'microsoft' ? 'microsoft' : 'gmail',
      emailAddress: row.emailAddress,
      scopeLabel: typeof row.scopeLabel === 'string' ? row.scopeLabel : null,
      status: row.status,
      lastSearchedAt: typeof row.lastSearchedAt === 'string' ? row.lastSearchedAt : null,
      lastErrorCode: typeof row.lastErrorCode === 'string' ? row.lastErrorCode : null,
    })),
    // Fail closed: an answer that does not say it may connect offers no
    // connect button.
    configured: raw.configured === true,
    connectEnabled: raw.connectEnabled === true,
  }
}

/** GET the company's mailboxes. Throws on anything but a well-formed answer. */
export async function fetchMailConnections(): Promise<MailConnectionsView> {
  const response = await fetch(`${MAIL_ROUTE_BASE}/connections`, { cache: 'no-store' })
  if (!response.ok) {
    notifySessionExpired(response)
    throw new Error(`mail connections answered ${response.status}`)
  }
  const view = parseMailConnections(await response.json())
  if (!view) throw new Error('mail connections answered an unexpected body')
  return view
}

/**
 * Why a mailbox cannot be read until its owner connects it again, or null
 * while it can be. `scope_missing`: the Gmail box was left unticked on
 * Google's consent screen. `access_ended`: Google refused the refresh token
 * (revoked, expired or a changed password). Anything else is not a state the
 * person can act on differently, so it gets the plain "reconnect" line.
 */
export type ReconnectReason = 'scope_missing' | 'access_ended' | 'other'

export function reconnectReason(
  connection: Pick<MailConnection, 'status' | 'lastErrorCode'>,
): ReconnectReason | null {
  if (connection.status === 'active') return null
  if (connection.lastErrorCode === 'scope_missing') return 'scope_missing'
  if (connection.lastErrorCode === 'invalid_grant') return 'access_ended'
  return 'other'
}

export interface MailboxSummary {
  /** Mailboxes the hunt reads. A row that needs a new consent is not one. */
  active: MailConnection[]
  needsReconnect: MailConnection[]
  /** A consent (connect or reconnect) can be started for this company. */
  canConnect: boolean
  /**
   * Worth offering at all: a mailbox exists, or this company can connect one.
   * While Google's review keeps connecting closed, a row or a door that only
   * leads to a page without a connect button is a dead end.
   */
  available: boolean
}

export function summarizeMailboxes(view: MailConnectionsView | null): MailboxSummary {
  const connections = view?.connections ?? []
  const canConnect = !!view && view.configured && view.connectEnabled
  return {
    active: connections.filter((c) => c.status === 'active'),
    needsReconnect: connections.filter((c) => c.status !== 'active'),
    canConnect,
    available: connections.length > 0 || canConnect,
  }
}

/** Where the OAuth callback sends the browser back: /settings/mail?mail=<code>. */
export const MAIL_CALLBACK_CODES = [
  'connected',
  'denied',
  'invalid',
  'expired',
  'mismatch',
  'no_refresh_token',
  'no_address',
  'failed',
  'scope_missing',
] as const

export type MailCallbackCode = (typeof MAIL_CALLBACK_CODES)[number]

export function parseMailCallback(raw: string | null): MailCallbackCode | null {
  return raw && (MAIL_CALLBACK_CODES as readonly string[]).includes(raw) ? (raw as MailCallbackCode) : null
}

/**
 * Only Google's own consent screen. The route builds the URL, but the browser
 * following whatever an answer contains would turn a compromised or proxied
 * response into an open redirect on the page that hands out mailbox access.
 */
export function isGoogleConsentUrl(url: string): boolean {
  try {
    return new URL(url).origin === GOOGLE_CONSENT_ORIGIN
  } catch {
    return false
  }
}

export type MailConnectStart =
  | { ok: true; url: string }
  | { ok: false; reason: 'connect_disabled' | 'not_configured' | 'failed' }

/** Ask the route for Google's consent URL. Never throws. */
export async function requestMailConnect(): Promise<MailConnectStart> {
  try {
    const response = await fetch(`${MAIL_ROUTE_BASE}/oauth/start`, { method: 'POST' })
    const body = (await response.json().catch(() => null)) as { url?: unknown; error?: unknown } | null
    if (response.ok && typeof body?.url === 'string' && isGoogleConsentUrl(body.url)) {
      return { ok: true, url: body.url }
    }
    if (response.status === 403 && body?.error === 'connect_disabled') {
      return { ok: false, reason: 'connect_disabled' }
    }
    if (response.status === 400 && body?.error === 'provider_not_configured') {
      return { ok: false, reason: 'not_configured' }
    }
    notifySessionExpired(response)
    return { ok: false, reason: 'failed' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

export type MailDisconnectResult = { ok: true } | { ok: false; reason: 'not_allowed' | 'failed' }

/**
 * DELETE one mailbox. The route also revokes the grant at Google. Never throws.
 *
 * `not_allowed` is the route saying this person neither connected the
 * mailbox nor is an owner or admin: trying again cannot help, so the panel
 * says who can instead.
 */
export async function disconnectMailbox(id: string): Promise<MailDisconnectResult> {
  try {
    const response = await fetch(`${MAIL_ROUTE_BASE}/connections?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    if (response.ok) return { ok: true }
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    if (response.status === 403 && body?.error === 'disconnect_not_allowed') {
      return { ok: false, reason: 'not_allowed' }
    }
    notifySessionExpired(response)
    return { ok: false, reason: 'failed' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
