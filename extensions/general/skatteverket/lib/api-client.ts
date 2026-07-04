import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { refreshAccessToken } from './oauth'
import { getTokens, storeTokens, deleteTokens } from './token-store'
import type { SkatteverketTokens } from '../types'

const log = createLogger('skatteverket-api-client')

// Cap diagnostic-body logging at 200 chars and redact any Bearer token
// patterns. The audit (V16.1 / A.8.15) flagged that raw 401/403 bodies were
// being concatenated into user-facing error messages and written to logs
// without redaction. Diagnostic data still belongs in server-side logs, but
// not in unbounded form and not in anything that reaches the user.
const MAX_LOG_BODY_LEN = 200
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/=]+/gi

function safeBodyForLog(body: string): string {
  const redacted = body.replace(BEARER_PATTERN, 'Bearer [REDACTED]')
  return redacted.length > MAX_LOG_BODY_LEN
    ? redacted.slice(0, MAX_LOG_BODY_LEN) + '…'
    : redacted
}

/**
 * Skatteverket API client.
 *
 * Handles:
 * - Automatic token refresh (transparent to callers)
 * - Required API gateway headers
 * - Rate limiting (4 req/sec per consumer)
 * - Correlation ID generation
 */

const DEFAULT_API_BASE_URL = 'https://api.test.skatteverket.se/momsdeklaration/v1'
const MAX_REFRESH_COUNT = 10
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000 // Refresh 5 min before expiry

// Simple in-memory token bucket for 4 req/sec rate limit
let lastRequestTime = 0
const MIN_REQUEST_INTERVAL_MS = 250 // 1000ms / 4 = 250ms

function getApiBaseUrl(): string {
  return process.env.SKATTEVERKET_API_BASE_URL || DEFAULT_API_BASE_URL
}

function getApiGwClientId(): string {
  const id = process.env.SKATTEVERKET_APIGW_CLIENT_ID
  if (!id) throw new Error('SKATTEVERKET_APIGW_CLIENT_ID is required')
  return id
}

function getApiGwClientSecret(): string {
  const secret = process.env.SKATTEVERKET_APIGW_CLIENT_SECRET
  if (!secret) throw new Error('SKATTEVERKET_APIGW_CLIENT_SECRET is required')
  return secret
}

/**
 * Kill switch: when SKATTEVERKET_DISABLED=true, all SKV API calls fail with a
 * single, clear Swedish error. Useful during incidents (provider outage, key
 * rotation, suspended access) to surface a graceful failure mode instead of
 * letting requests hang or leak partial state.
 */
function isDisabled(): boolean {
  const v = (process.env.SKATTEVERKET_DISABLED ?? '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/**
 * Detect whether we're pointed at SKV's test or prod environment.
 * Used by the UI to surface an obvious badge so the user knows whether their
 * filings will hit Skatteverket's production system.
 */
export function getSkatteverketEnvironment(): 'test' | 'prod' {
  const baseUrl =
    process.env.SKATTEVERKET_API_BASE_URL ||
    process.env.SKATTEVERKET_AGD_INLAMNING_API_BASE_URL ||
    process.env.SKATTEVERKET_SKATTEKONTO_API_BASE_URL ||
    DEFAULT_API_BASE_URL
  return baseUrl.includes('api.test.skatteverket.se') ? 'test' : 'prod'
}

/**
 * Ensure rate limit compliance (4 req/sec).
 * Delays if the last request was too recent.
 */
async function enforceRateLimit(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  lastRequestTime = now // Claim the slot immediately to prevent concurrent bypass
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed))
  }
}

// Coalesce concurrent refresh attempts within this Node.js process. Without
// this, two parallel SKV requests from the same user (e.g. rapid UI clicks)
// would both call SKV's /token endpoint with the same refresh_token; SKV
// rotates that token on first use, so the second call would fail with 401.
// Cross-process races (separate Vercel function instances) are mitigated by
// the re-read inside the critical section: if another process refreshed
// while we waited on the network, we just use that newer token.
const refreshInFlight = new Map<string, Promise<string>>()

/**
 * Get a valid access token, refreshing if needed.
 * Throws if no tokens exist or refresh is exhausted.
 */
async function getValidToken(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const tokens = await getTokens(supabase, userId)
  if (!tokens) {
    throw new SkatteverketAuthError(
      'Inte ansluten till Skatteverket. Anslut med BankID först.',
      'NOT_CONNECTED'
    )
  }

  // Token still valid (with 5-min margin)
  if (tokens.expires_at > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return tokens.access_token
  }

  // Need refresh: coalesce concurrent attempts.
  const inFlight = refreshInFlight.get(userId)
  if (inFlight) return inFlight

  const promise = refreshTokenForUser(supabase, userId)
    .finally(() => refreshInFlight.delete(userId))
  refreshInFlight.set(userId, promise)
  return promise
}

async function refreshTokenForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  // Re-read after entering the critical section. Another process may have
  // refreshed while we were waiting; if so, the row now has a new
  // refresh_token and a future expiry: just hand it back.
  const tokens = await getTokens(supabase, userId)
  if (!tokens) {
    throw new SkatteverketAuthError(
      'Inte ansluten till Skatteverket. Anslut med BankID först.',
      'NOT_CONNECTED'
    )
  }
  if (tokens.expires_at > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return tokens.access_token
  }
  if (!tokens.refresh_token) {
    throw new SkatteverketAuthError(
      'Sessionen har gått ut. Logga in med BankID igen.',
      'SESSION_EXPIRED'
    )
  }
  if (tokens.refresh_count >= MAX_REFRESH_COUNT) {
    throw new SkatteverketAuthError(
      'Maximalt antal förnyelser uppnått. Logga in med BankID igen.',
      'REFRESH_EXHAUSTED'
    )
  }

  const refreshed = await refreshAccessToken(tokens.refresh_token, tokens.refresh_count)
  const updatedTokens: SkatteverketTokens = {
    ...refreshed,
    scope: tokens.scope,
  }
  await storeTokens(supabase, userId, updatedTokens)
  return updatedTokens.access_token
}

/**
 * Make an authenticated request to the Skatteverket API.
 *
 * Automatically handles:
 * - Token refresh if expired
 * - Required headers (Client_Id, Client_Secret, correlation ID)
 * - Rate limiting
 */
export async function skvRequest(
  supabase: SupabaseClient,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  options?: { baseUrl?: string; contentType?: string }
): Promise<Response> {
  if (isDisabled()) {
    throw new SkatteverketAuthError(
      'Skatteverket-integrationen är tillfälligt avstängd. Kontakta support.',
      'ACCESS_DENIED'
    )
  }
  const accessToken = await getValidToken(supabase, userId)

  await enforceRateLimit()

  const url = `${options?.baseUrl || getApiBaseUrl()}${path}`
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Client_Id': getApiGwClientId(),
    'Client_Secret': getApiGwClientSecret(),
    'skv_client_correlation_id': crypto.randomUUID(),
  }

  // contentType defaults to application/json, which is right for moms +
  // skattekonto. AGI's POST /underlag takes application/xml: callers pass
  // the XML as a string body and override contentType.
  let serializedBody: string | undefined
  if (body !== undefined) {
    const contentType = options?.contentType ?? 'application/json'
    headers['Content-Type'] = contentType
    serializedBody = typeof body === 'string' ? body : JSON.stringify(body)
  }

  const response = await fetch(url, {
    method,
    headers,
    body: serializedBody,
    signal: AbortSignal.timeout(15_000),
  })

  // Handle Skatteverket-specific auth/throttle errors uniformly so callers
  // can catch a single error type rather than parsing status codes inline.
  if (response.status === 401) {
    // SKV returns 401 for two distinct reasons that need different remedies:
    //   1. Genuine token expiry / invalid bearer (user must re-auth)
    //   2. APIGW client lacks subscription for this API (developer portal fix):
    //      the bearer is valid but the gateway rejects the call.
    // Read the body and gateway-side headers so we can distinguish and
    // surface a useful message.
    const text = await response.text().catch(() => '')

    // WWW-Authenticate carries OAuth's machine-readable failure reason
    // (insufficient_scope / invalid_token). The x-skv-* / x-amzn-* / x-api-*
    // families are gateway-side hints SKV's APIGW emits when it rejects the
    // call before reaching the application: the body is often empty in
    // that case so the headers are the only signal.
    const wwwAuth = response.headers.get('WWW-Authenticate') ?? ''
    const skvHeaders: Record<string, string> = {}
    response.headers.forEach((v, k) => {
      const lk = k.toLowerCase()
      if (
        lk === 'www-authenticate' ||
        lk.startsWith('x-skv-') ||
        lk.startsWith('x-amzn-') ||
        lk.startsWith('x-api-')
      ) {
        skvHeaders[k] = v
      }
    })
    // Diagnostic detail (headers, body) belongs in server-side logs only,
    // not in user-facing error messages. The structured logger redacts
    // sensitive keys and we further cap body length and strip Bearer tokens
    // so the diagnostic is bounded.
    log.error('401 from Skatteverket API', {
      url,
      statusCode: 401,
      body: safeBodyForLog(text),
      headers: skvHeaders,
    })

    const lower = text.toLowerCase()

    // OAuth's standard insufficient_scope marker. SKV sometimes emits this
    // as 401 (rather than 403) when the AGI APIGW evaluates scope before
    // the application sees the token. The remedy is the same as MISSING_SCOPE:
    // disconnect + reconnect to mint a token covering the AGI scope.
    const wwwLower = wwwAuth.toLowerCase()
    if (
      wwwLower.includes('insufficient_scope') ||
      wwwLower.includes('invalid_scope')
    ) {
      throw new SkatteverketAuthError(
        'Anslutningen mot Skatteverket saknar nödvändig behörighet för denna ' +
        'tjänst. Koppla bort och anslut igen via Inställningar → Skatteverket ' +
        'för att förnya tokenen med rätt scope.',
        'MISSING_SCOPE'
      )
    }

    // SKV explicitly declares the token revoked. Body shape observed in
    // production: { "error": "Token has been revoked." } with a generic
    // `Bearer realm="OAuth2 Client Realm"` challenge header. This is a
    // terminal state: the bearer will never come back to life, regardless
    // of refresh attempts (refresh_token from the same family is also dead).
    // Auto-clear the local row so /status stops claiming we're connected
    // and the next interaction forces a clean reconnect. We swallow any
    // delete error: even if cleanup fails we still want to surface the
    // primary auth error to the user.
    if (lower.includes('revoked') || lower.includes('token has been revoked')) {
      try {
        await deleteTokens(supabase, userId)
      } catch (cleanupErr) {
        log.error('failed to clear revoked token row', cleanupErr as Error, { userId })
      }
      throw new SkatteverketAuthError(
        'Skatteverket har återkallat anslutningen. Detta händer t.ex. om ' +
        'BankID-sessionen avslutats eller om en ny anslutning gjorts från ' +
        'en annan enhet. Anslut igen med BankID för att fortsätta.',
        'TOKEN_REVOKED'
      )
    }

    // APIGW subscription / client-credential problems: the gateway responds
    // before the bearer is ever evaluated. The user reconnecting won't help
    // here: it's an Utvecklarportalen / APIGW configuration issue.
    const looksLikeApigwIssue =
      lower.includes('client_id') ||
      lower.includes('client id') ||
      lower.includes('subscription') ||
      lower.includes('not subscribed') ||
      lower.includes('apigw') ||
      lower.includes('api key') ||
      lower.includes('consumer')
    if (looksLikeApigwIssue) {
      throw new SkatteverketAuthError(
        'Skatteverkets API-gateway nekade anropet. Kontrollera att din ' +
        'APIGW-klient (SKATTEVERKET_APIGW_CLIENT_ID) har prenumeration på ' +
        'denna tjänst i Utvecklarportalen.',
        'ACCESS_DENIED'
      )
    }

    // (B) Empty 401 with no diagnostic header → almost always a gateway/
    // subscription issue rather than a real session expiry. We refreshed
    // the local bearer immediately above, so an empty body with no
    // WWW-Authenticate means SKV's APIGW rejected the call before it
    // reached the application: typically because the APIGW client isn't
    // subscribed to the API at the URL we just hit. Telling the user to
    // "log in again" sends them down a dead end; be explicit about the
    // likely fix instead.
    if (!text) {
      // Extract the API segment of the URL so the message tells the user
      // exactly which subscription is missing. Falls back to the raw URL
      // if parsing fails.
      let apiHint = url
      try {
        const u = new URL(url)
        const parts = u.pathname.split('/').filter(Boolean)
        // Take the first 3 segments, e.g. arbetsgivardeklaration/inlamning/v1
        if (parts.length >= 1) apiHint = parts.slice(0, 3).join('/')
      } catch {
        // keep raw url
      }
      throw new SkatteverketAuthError(
        'Skatteverkets API-gateway nekade anropet utan motivering. ' +
        'Trolig orsak: APIGW-klienten (SKATTEVERKET_APIGW_CLIENT_ID) har ' +
        `inte prenumeration på tjänsten "${apiHint}" i Utvecklarportalen, ` +
        'eller den lagrade tokenen saknar rätt scope. Kontrollera ' +
        'prenumerationen, koppla annars bort och anslut igen via ' +
        'Inställningar → Skatteverket.',
        'ACCESS_DENIED'
      )
    }

    throw new SkatteverketAuthError(
      'Sessionen har gått ut. Logga in med BankID igen.',
      'SESSION_EXPIRED'
    )
  }

  if (response.status === 403) {
    const text = await response.text().catch(() => '')
    // Same diagnostic-vs-user-message split as the 401 path: log the body
    // server-side, surface only the actionable Swedish guidance.
    log.error('403 from Skatteverket API', {
      url,
      statusCode: 403,
      body: safeBodyForLog(text),
    })
    // Missing scope on the access token: fires when an existing connection
    // pre-dates an extension that needed a new scope (the AGI/`agd` rollout
    // is the canonical example). The user has to disconnect + reconnect to
    // re-issue a token with the broader scope set; we want to say so
    // explicitly instead of letting it surface as a generic 403.
    // Body shape per SKV's AGI service description (Tjänstebeskrivning v1.7
    // §4.1.2.2): { "error": "invalid_scope", "description": "The required
    // scope agd has been requested for that access token." }
    if (text.includes('invalid_scope') || text.includes('required scope')) {
      throw new SkatteverketAuthError(
        'Anslutningen mot Skatteverket saknar nödvändig behörighet för denna ' +
        'tjänst. Koppla bort och anslut igen via Inställningar → Skatteverket ' +
        'för att förnya tokenen med rätt scope.',
        'MISSING_SCOPE'
      )
    }
    // Behörighet saknas: user is authenticated but not authorized for this company
    if (text.includes('Behörighet') || text.includes('behörighet')) {
      throw new SkatteverketAuthError(
        'Du har inte behörighet att agera för detta företag hos Skatteverket. ' +
        'Kontrollera att du är registrerad som firmatecknare eller deklarationsombud.',
        'BEHORIGHET_SAKNAS'
      )
    }
    throw new SkatteverketAuthError(
      'Åtkomst nekad av Skatteverket (403). Kontakta support om problemet kvarstår.',
      'ACCESS_DENIED'
    )
  }

  if (response.status === 429) {
    // Skatteverket may include a Retry-After header. We surface a generic
    // Swedish message: callers can inspect the header on the thrown error
    // if they need to schedule a retry. The 4 req/sec local rate limiter
    // should normally prevent this; a 429 here implies the per-consumer
    // gateway quota was exceeded.
    throw new SkatteverketAuthError(
      'Skatteverket är överbelastat eller har strypt anropen. Försök igen om en stund.',
      'RATE_LIMITED'
    )
  }

  return response
}

/**
 * Structured error for Skatteverket auth/access/throttle issues.
 * The `code` field helps the frontend show appropriate UI.
 *
 * Codes:
 *   NOT_CONNECTED      : no tokens stored; user needs to run BankID flow
 *   SESSION_EXPIRED    : 401 from SKV; refresh exhausted or token rejected
 *   REFRESH_EXHAUSTED  : refresh count hit cap (10) before user re-auth
 *   TOKEN_REVOKED      : 401 with "Token has been revoked." body; SKV killed
 *                        the bearer (BankID session ended, parallel connect
 *                        from another device, or auth-code reuse). Local row
 *                        is auto-cleared; user must reconnect with BankID.
 *   BEHORIGHET_SAKNAS  : 403 with "Behörighet" body; user not authorized
 *                        for this company at SKV (firmatecknare / ombud)
 *   MISSING_SCOPE      : 403 with "invalid_scope" body; the stored token
 *                        was issued before the required scope existed.
 *                        User must disconnect + reconnect.
 *   ACCESS_DENIED      : generic 403
 *   RATE_LIMITED       : 429 from SKV API gateway
 *   TOKEN_CORRUPTED    : stored tokens cannot be decrypted (key rotated
 *                        or row tampered with); user must reconnect
 */
export class SkatteverketAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_CONNECTED'
      | 'SESSION_EXPIRED'
      | 'REFRESH_EXHAUSTED'
      | 'TOKEN_REVOKED'
      | 'BEHORIGHET_SAKNAS'
      | 'MISSING_SCOPE'
      | 'ACCESS_DENIED'
      | 'RATE_LIMITED'
      | 'TOKEN_CORRUPTED'
  ) {
    super(message)
    this.name = 'SkatteverketAuthError'
  }
}
