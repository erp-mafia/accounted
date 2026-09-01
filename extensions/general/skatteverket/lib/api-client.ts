import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import {
  CONNECTOR_UPSTREAM_AUTH_HEADER,
  CONNECTOR_UPSTREAM_CONTENT_TYPE_HEADER,
} from '@/lib/connect/instance/upstreams'
import { baseUrlToService, parseConnectorCode, skatteverketConnectorMode } from './connector-mode'
import { refreshAccessToken } from './oauth'
import { getTokens, storeTokens, deleteTokens } from './token-store'
import { getSystemAccessToken, invalidateSystemToken } from './system-auth/token-provider'
import type { SkatteverketTokens } from '../types'

/**
 * Credential selector for SKV API calls.
 *
 * 'user'   : the personal BankID OAuth token (per-user, 65-minute refresh
 *            chain). The only mode that existed before the hybrid model.
 * 'system' : Accounted's own Client Credentials token (org certificate),
 *            authorized per company via an ombud grant at Skatteverket.
 *            Used by background reads; carries no user session at all.
 *            NEVER brokered through the connector: the org certificate and
 *            ombud grants are a hosted-only feature, so system mode always
 *            takes the direct path and fails with SYSTEM_AUTH_FAILED on a
 *            credential-less self-host (deliberate, PR6b-2).
 */
export type SkvAuth =
  | { mode: 'user'; supabase: SupabaseClient; userId: string; companyId: string }
  | { mode: 'system' }

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
  // Connector mode: the actual upstream environment is resolved from the
  // HOSTED broker's env, not this instance's (whose base URLs are usually
  // unset and default to test). Reporting 'test' here would show a Testmiljö
  // badge on real filings, so report 'prod', the hosted upstream's
  // environment once connector keys are sold. (Reporting hosted's actual env
  // through /api/connector/status is a #2090 follow-up.)
  if (skatteverketConnectorMode()) return 'prod'
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
  userId: string,
  companyId: string
): Promise<string> {
  const tokens = await getTokens(supabase, userId, companyId)
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

  // Need refresh: coalesce concurrent attempts per (user, company) row.
  const flightKey = `${userId}:${companyId}`
  const inFlight = refreshInFlight.get(flightKey)
  if (inFlight) return inFlight

  const promise = refreshTokenForUser(supabase, userId, companyId)
    .finally(() => refreshInFlight.delete(flightKey))
  refreshInFlight.set(flightKey, promise)
  return promise
}

async function refreshTokenForUser(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
): Promise<string> {
  // Re-read after entering the critical section. Another process may have
  // refreshed while we were waiting; if so, the row now has a new
  // refresh_token and a future expiry: just hand it back.
  const tokens = await getTokens(supabase, userId, companyId)
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

  let refreshed
  try {
    refreshed = await refreshAccessToken(tokens.refresh_token, tokens.refresh_count)
  } catch (err) {
    // SKV's `per`-flow refresh tokens live 65 minutes. Any daily cron (or a
    // user returning the next day) therefore always finds a dead token and
    // gets 404 id_not_found back — that's ordinary session expiry, not a
    // runtime error. Classify it so the crons' quiet buckets and the UI's
    // reconnect flow catch it instead of a raw Error escaping to the logs.
    // SKV speaks several dialects for the same terminal state: 404 with
    // id_not_found / "refresh token is not found", 400 access_denied with
    // "Refresh Token status is expired", and OAuth2's standard 400
    // invalid_grant. Config-shaped 400s (invalid_client, invalid_scope)
    // deliberately stay raw errors: telling the user to reconnect cannot
    // fix those, and mislabeling them re-creates the self-perpetuating
    // reconnect banner from the 2026-07 MISSING_SCOPE incident.
    const message = err instanceof Error ? err.message : String(err)
    const deadRefreshToken =
      (/\b404\b/.test(message) && /id_not_found|refresh token is not found/i.test(message)) ||
      (/\b400\b/.test(message) &&
        (/refresh token status is expired/i.test(message) ||
          /"error"\s*:\s*"invalid_grant"/i.test(message))) ||
      // Broker dialects (connector mode): CONNECTOR_SKV_REFRESH_DEAD is the
      // broker's classification of SKV's own dead-token dialects (the
      // dominant refresh outcome: per-flow refresh tokens live 65 minutes),
      // and 404 CONNECTOR_NOT_OWNED means the hosted ledger no longer
      // vouches for this refresh token (rotated away or revoked). Both are
      // terminal: only a fresh BankID consent recovers. The broker's generic
      // 502 (CONNECTOR_SKV_TOKEN_FAILED) deliberately stays a raw error: a
      // transient SKV outage must not flag the row for reconnect (#1155).
      /CONNECTOR_SKV_REFRESH_DEAD/.test(message) ||
      (/\b404\b/.test(message) && /CONNECTOR_NOT_OWNED/.test(message))
    if (deadRefreshToken) {
      throw new SkatteverketAuthError(
        'Sessionen har gått ut. Logga in med BankID igen.',
        'SESSION_EXPIRED'
      )
    }
    throw err
  }
  const updatedTokens: SkatteverketTokens = {
    ...refreshed,
    scope: tokens.scope,
  }
  await storeTokens(supabase, userId, updatedTokens, companyId)
  return updatedTokens.access_token
}

/**
 * MuleSoft APIGW scope enforcement, observed verbatim in production:
 *
 *   { "error": "The required scopes are not authorized" }
 *
 * TWO different misconfigurations produce this one body, and they are fixed
 * with different knobs:
 *
 *   1. Our APIGW client (SKATTEVERKET_APIGW_CLIENT_ID) has no subscription for
 *      the API being called (#973). Fixed in Utvecklarportalen.
 *   2. The token is missing the scope that API requires, because the SKV
 *      application was never registered for it, or because we never asked for
 *      it. AGI needs `agd` for inlamning AND `agdredovisningperiod` for
 *      hanteraredovisningsperiod; a token holding only the first files and
 *      signs perfectly, then dies on the kvittens read. `ska` behaved the same
 *      way for skattekonto (#431). Fixed by registering/requesting the scope
 *      and reconnecting.
 *
 * The gateway will not tell us which, so neither can we: the message names
 * both, and callers still classify it as ACCESS_DENIED. That verdict is about
 * blast radius, not about cause. ACCESS_DENIED is deliberately NOT in
 * RECONSENT_ERROR_CODES: guessing "reconnect" is what made a successful
 * reconnect (runPostConnectRefresh -> syncSkattekonto -> 403) instantly
 * re-flag the token row, so the banner perpetuated itself (#1155). Case 2 does
 * need a reconnect, but only AFTER the scope exists, so an automatic reconsent
 * loop would still be wrong.
 *
 * It also has to be ruled out before isTokenScopeRejection, which matches the
 * substring "required scope".
 *
 * To tell the two apart, call the API with a deliberately invalid bearer and
 * the same Client_Id/Client_Secret. Case 1 fails at the gateway with this same
 * body; case 2 reaches the bearer check and answers 401 invalid/revoked token.
 * Compare against an API the client is known to be subscribed to.
 */
function isApigwScopeContractError(body: string): boolean {
  return /required scopes?\s+are\s+not\s+authorized/i.test(body)
}

/**
 * The API segment of a SKV URL ("arbetsgivardeklaration/inlamning/v1"), for
 * error messages that have to say WHICH service refused. Without it the user
 * cannot tell which subscription or scope to go check, which is exactly the
 * dead end the 403 message used to leave them in.
 */
function apiHintFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return parts.length >= 1 ? parts.slice(0, 3).join('/') : url
  } catch {
    return url
  }
}

/**
 * User-facing message for the ambiguous gateway/scope refusal. Single-sourced
 * so the 401 and 403 paths cannot drift apart.
 */
function apigwOrScopeMessage(url: string): string {
  return (
    `Skatteverket nekade anropet till tjänsten "${apiHintFromUrl(url)}". ` +
    'Två saker ger samma svar: APIGW-klienten (SKATTEVERKET_APIGW_CLIENT_ID) ' +
    'saknar prenumeration på tjänsten, eller så saknar anslutningen det scope ' +
    'tjänsten kräver. Kontrollera båda i Utvecklarportalen: prenumerationen på ' +
    'API:et, och att applikationens scope-lista täcker det. Om ett scope har ' +
    'lagts till behöver du koppla bort och ansluta igen via Inställningar → ' +
    'Skatteverket för att få en ny token.'
  )
}

/**
 * Connector-mode variant of the gateway-refusal guidance: the APIGW client
 * and its subscriptions belong to the HOSTED broker (Arcim), so telling a
 * self-host operator to check SKATTEVERKET_APIGW_CLIENT_ID or visit
 * Utvecklarportalen points at knobs their instance does not have. The token
 * they hold was also minted by the broker, so the only local actions are
 * checking the connector status and contacting support.
 */
function connectorGatewayMessage(url: string): string {
  return (
    `Skatteverkets API-gateway nekade anropet till tjänsten "${apiHintFromUrl(url)}" via connectorn. ` +
    'Detta är ett konfigurationsproblem på värdtjänstens sida (gateway-prenumeration eller scope), ' +
    'inte på din instans: kontakta supporten. Anslutningsläget syns på /api/connector/status.'
  )
}

/**
 * A genuine token-scope rejection: the stored access token predates a scope
 * the service now requires, and only a fresh consent can widen it.
 *
 * Matches the two documented shapes and nothing else: the OAuth `invalid_scope`
 * error code (RFC 6749), and the sentence from SKV's AGI service description
 * (Tjänstebeskrivning v1.7 §4.1.2.2), "The required scope agd has been
 * requested for that access token."
 */
function isTokenScopeRejection(body: string): boolean {
  return (
    /invalid_scope/i.test(body) ||
    /required scope\s+\S+\s+has been requested/i.test(body)
  )
}

/**
 * Make an authenticated request to the Skatteverket API with the user's
 * personal BankID token. Thin wrapper kept for the ~40 existing call sites;
 * new auth-aware code calls skvRequestWithAuth directly.
 */
export async function skvRequest(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  method: string,
  path: string,
  body?: unknown,
  options?: { baseUrl?: string; contentType?: string }
): Promise<Response> {
  return skvRequestWithAuth({ mode: 'user', supabase, userId, companyId }, method, path, body, options)
}

/**
 * Make an authenticated request to the Skatteverket API.
 *
 * Automatically handles:
 * - Credential resolution per auth mode (user token refresh, or the cached
 *   system CCG token)
 * - Required headers (Client_Id, Client_Secret, correlation ID)
 * - Rate limiting
 *
 * Error semantics differ by mode: user-mode 401/403s map to the reconnect
 * codes (SESSION_EXPIRED, TOKEN_REVOKED, ...); system-mode failures never
 * touch skatteverket_tokens and map to SYSTEM_AUTH_FAILED (run-level
 * credential problem) or OMBUD_GRANT_MISSING (this company has not granted,
 * or has revoked, the behorighet).
 */
export async function skvRequestWithAuth(
  auth: SkvAuth,
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

  let accessToken: string
  if (auth.mode === 'user') {
    accessToken = await getValidToken(auth.supabase, auth.userId, auth.companyId)
  } else {
    try {
      accessToken = await getSystemAccessToken()
    } catch (err) {
      throw new SkatteverketAuthError(
        err instanceof Error ? err.message : 'Systemtoken kunde inte hämtas.',
        'SYSTEM_AUTH_FAILED'
      )
    }
  }

  await enforceRateLimit()

  // Connector mode (self-host with GNUBOK_CONNECTOR_KEY and no own SKV
  // credentials): route through the hosted data proxy. The base URL only
  // selects the SERVICE segment (the proxy resolves the real upstream from
  // hosted's env); the user's SKV Bearer moves to the upstream-auth header,
  // the connector key becomes the proxy auth, and the gateway
  // Client_Id/Client_Secret are omitted entirely (the proxy adds Arcim's;
  // this instance has none, which is precisely why it is in connector mode).
  // System (CCG) auth is deliberately NOT brokered: background ombud reads
  // are a hosted-only feature and stay on the direct path, where a
  // credential-less self-host fails with SYSTEM_AUTH_FAILED.
  const connector = auth.mode === 'user' ? skatteverketConnectorMode() : null
  const effectiveBase = options?.baseUrl || getApiBaseUrl()
  let url: string
  const headers: Record<string, string> = {}
  if (connector) {
    url = `${connector.baseUrl}/api/${baseUrlToService(effectiveBase)}${path}`
    headers['Authorization'] = `Bearer ${connector.key}`
    headers[CONNECTOR_UPSTREAM_AUTH_HEADER] = `Bearer ${accessToken}`
  } else {
    url = `${effectiveBase}${path}`
    headers['Authorization'] = `Bearer ${accessToken}`
    headers['Client_Id'] = getApiGwClientId()
    headers['Client_Secret'] = getApiGwClientSecret()
    headers['skv_client_correlation_id'] = crypto.randomUUID()
  }

  // contentType defaults to application/json, which is right for moms +
  // skattekonto. AGI's POST /underlag takes application/xml: callers pass
  // the XML as a string body and override contentType.
  let serializedBody: string | undefined
  if (body !== undefined) {
    const contentType = options?.contentType ?? 'application/json'
    headers['Content-Type'] = contentType
    if (connector) headers[CONNECTOR_UPSTREAM_CONTENT_TYPE_HEADER] = contentType
    serializedBody = typeof body === 'string' ? body : JSON.stringify(body)
  }

  let response = await fetch(url, {
    method,
    headers,
    body: serializedBody,
    signal: AbortSignal.timeout(15_000),
  })

  // Connector-layer refusals FIRST: a 4xx here can come from the broker
  // itself, not Skatteverket, and the SKV-shaped sniffing below would then
  // misdiagnose it (an empty connector 401 would tell the operator to check
  // SKATTEVERKET_APIGW_CLIENT_ID, which does not exist on their instance).
  // Bodies without a CONNECTOR_* code are upstream SKV responses passed
  // through the proxy: re-wrap and fall through to the normal mapping.
  if (connector && [400, 401, 403, 404, 429].includes(response.status)) {
    const text = await response.text().catch(() => '')
    const connectorCode = parseConnectorCode(text)
    if (connectorCode) {
      log.warn('connector broker rejected SKV call', {
        url,
        statusCode: response.status,
        code: connectorCode,
      })
      if (connectorCode === 'CONNECTOR_RATE_LIMITED') {
        throw new SkatteverketAuthError(
          'Skatteverket-connectorn är upptagen. Försök igen om en stund.',
          'RATE_LIMITED'
        )
      }
      if (connectorCode === 'CONNECTOR_NOT_OWNED') {
        // The hosted ledger no longer vouches for this token (rotated away
        // or revoked); only a fresh BankID consent recovers.
        throw new SkatteverketAuthError(
          'Sessionen har gått ut. Logga in med BankID igen.',
          'SESSION_EXPIRED'
        )
      }
      throw new SkatteverketAuthError(
        `Connectorn nekade anropet (${connectorCode}). Kontrollera instansens ` +
        'connector-nyckel (GNUBOK_CONNECTOR_KEY) och att abonnemanget omfattar ' +
        'Skatteverket. Se /api/connector/status för anslutningsläget.',
        'ACCESS_DENIED'
      )
    }
    response = new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

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
    // so the diagnostic is bounded. warn, not error: auth rejections are
    // expected states (expired sessions, stale scopes) and the thrown
    // SkatteverketAuthError below carries the signal to the caller.
    log.warn('401 from Skatteverket API', {
      url,
      statusCode: 401,
      authMode: auth.mode,
      body: safeBodyForLog(text),
      headers: skvHeaders,
    })

    if (auth.mode === 'system') {
      // A rejected system token is a run-level credential problem (cert,
      // token endpoint, APIGW subscription): drop the cache so the next
      // call mints fresh, and never touch the user token table from here.
      invalidateSystemToken()
      throw new SkatteverketAuthError(
        'Skatteverket avvisade systemautentiseringen. Kontrollera certifikatet ' +
        'och APIGW-prenumerationerna för systemklienten.',
        'SYSTEM_AUTH_FAILED'
      )
    }

    const lower = text.toLowerCase()

    // Gateway signature first, mirroring the 403 path. MuleSoft can pair its
    // contract-enforcement body with an OAuth-shaped challenge header, and the
    // scope branch below would then claim a token problem that reconnecting
    // cannot fix: SESSION_EXPIRED and MISSING_SCOPE are both reconsent codes,
    // so either verdict re-arms the banner the user just tried to clear.
    if (isApigwScopeContractError(text)) {
      throw new SkatteverketAuthError(
        connector ? connectorGatewayMessage(url) : apigwOrScopeMessage(url),
        'ACCESS_DENIED'
      )
    }

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
        await deleteTokens(auth.supabase, auth.userId, auth.companyId)
      } catch (cleanupErr) {
        log.error('failed to clear revoked token row', cleanupErr as Error, { userId: auth.userId })
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
    // (the APIGW scope-contract body is already handled above)
    const looksLikeApigwIssue =
      lower.includes('client_id') ||
      lower.includes('client id') ||
      lower.includes('subscription') ||
      lower.includes('not subscribed') ||
      lower.includes('apigw') ||
      lower.includes('api key') ||
      lower.includes('consumer')
    if (looksLikeApigwIssue) {
      // Named the subscription outright: unlike the scope-contract body above,
      // these shapes (client_id, consumer, subscription) point at the gateway
      // client alone, so the message must not muddy it with the scope story.
      // Connector mode: the gateway client is the broker's, not the instance's.
      throw new SkatteverketAuthError(
        connector
          ? connectorGatewayMessage(url)
          : `Skatteverkets API-gateway nekade anropet till "${apiHintFromUrl(url)}". ` +
            'Kontrollera att din APIGW-klient (SKATTEVERKET_APIGW_CLIENT_ID) har ' +
            'prenumeration på denna tjänst i Utvecklarportalen.',
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
      if (connector) {
        throw new SkatteverketAuthError(connectorGatewayMessage(url), 'ACCESS_DENIED')
      }
      const apiHint = apiHintFromUrl(url)
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
    log.warn('403 from Skatteverket API', {
      url,
      statusCode: 403,
      authMode: auth.mode,
      body: safeBodyForLog(text),
    })

    if (auth.mode === 'system') {
      // Both cases are run-level configuration problems (SYSTEM_AUTH_FAILED),
      // but they are fixed with different knobs, so the message must not
      // point at the scope list when the gateway is what refused.
      if (isApigwScopeContractError(text)) {
        throw new SkatteverketAuthError(
          'Skatteverket nekade systemanropet till tjänsten ' +
          `"${apiHintFromUrl(url)}": antingen saknar APIGW-klienten ` +
          '(SKATTEVERKET_APIGW_CLIENT_ID) prenumeration på tjänsten, eller så ' +
          'täcker inte SKATTEVERKET_SYSTEM_SCOPES det scope tjänsten kräver.',
          'SYSTEM_AUTH_FAILED'
        )
      }
      if (isTokenScopeRejection(text)) {
        throw new SkatteverketAuthError(
          'Systemtokenens scope räcker inte för denna tjänst. Kontrollera ' +
          'SKATTEVERKET_SYSTEM_SCOPES mot tjänstens krav.',
          'SYSTEM_AUTH_FAILED'
        )
      }
      // With valid system credentials, a 403 means this company has not
      // granted (or has revoked) the behorighet for Accounted's org number.
      // Company-level: the caller downgrades the connection row, other
      // companies in the same run are unaffected.
      throw new SkatteverketAuthError(
        'Företaget har inte gett Accounted behörighet hos Skatteverket, ' +
        'eller så har behörigheten återkallats i Ombud och behörigheter.',
        'OMBUD_GRANT_MISSING'
      )
    }
    // Gateway scope enforcement, checked first: the body wears token-scope
    // wording but names neither cause, so it must not reach
    // isTokenScopeRejection below. ACCESS_DENIED is deliberately not in
    // RECONSENT_ERROR_CODES (#1155): a reconnect is only the fix once the
    // scope actually exists, so it can never be automatic.
    if (isApigwScopeContractError(text)) {
      throw new SkatteverketAuthError(
        connector ? connectorGatewayMessage(url) : apigwOrScopeMessage(url),
        'ACCESS_DENIED'
      )
    }
    // Missing scope on the access token: fires when an existing connection
    // pre-dates an extension that needed a new scope (the AGI/`agd` rollout
    // is the canonical example). The user has to disconnect + reconnect to
    // re-issue a token with the broader scope set; we want to say so
    // explicitly instead of letting it surface as a generic 403.
    // Body shape per SKV's AGI service description (Tjänstebeskrivning v1.7
    // §4.1.2.2): { "error": "invalid_scope", "description": "The required
    // scope agd has been requested for that access token." }
    if (isTokenScopeRejection(text)) {
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
 *                        User must disconnect + reconnect. NOT emitted for
 *                        the APIGW's "The required scopes are not authorized"
 *                        contract error: that is our subscription gap, and
 *                        treating it as a token problem made every reconnect
 *                        re-flag the row (#1155).
 *   ACCESS_DENIED      : generic 403, and the APIGW contract error above
 *   RATE_LIMITED       : 429 from SKV API gateway
 *   TOKEN_CORRUPTED    : stored tokens cannot be decrypted (key rotated
 *                        or row tampered with); user must reconnect
 *   SYSTEM_AUTH_FAILED : system (CCG) credential problem: token could not
 *                        be minted, was rejected, or lacks scope. Run-level:
 *                        affects every company, fix is configuration-side.
 *   OMBUD_GRANT_MISSING: 403 on a system-mode call: this company has not
 *                        granted (or has revoked) Accounted's behorighet at
 *                        Skatteverket. Company-level.
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
      | 'SYSTEM_AUTH_FAILED'
      | 'OMBUD_GRANT_MISSING'
  ) {
    super(message)
    this.name = 'SkatteverketAuthError'
  }
}
