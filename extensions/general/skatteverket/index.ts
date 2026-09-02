import { sleep } from '@/lib/utils'
import crypto from 'crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse, after } from 'next/server'
import {
  AGIKontrolleraHUSchema,
  AGIKontrolleraIUSchema,
  AGI_KONTROLLERA_MAX_BYTES,
} from '@/lib/salary/agi/kontrollera-schemas'
import { TimeoutError } from '@/lib/http/fetch-with-timeout'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { buildAuthorizeUrl, exchangeCodeForTokens, generatePkcePair } from './lib/oauth'
import { skatteverketConnectorMode, startConnectorAuthorization } from './lib/connector-mode'
import { isConnectorState, verifyConnectorState } from '@/lib/connect/hosted/state'
import { storeTokens, getTokens, deleteTokens, getTokenHealth } from './lib/token-store'
import { skvRequest, skvRequestWithAuth, SkatteverketAuthError, getSkatteverketEnvironment } from './lib/api-client'
import { writeSkatteverketAudit } from './lib/audit'
import { skvAuthCodeToStructured } from './lib/error-map'
import {
  buildMomsuppgift,
  buildAgiUnderlag,
  type VatDeclarationPrep,
  type AgiUnderlagPrep,
} from './lib/declaration-prep'
import { submitVatDeclarationChain } from './lib/vat-submit'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import { getSystemAuthMode, isSystemAuthConfigured, getOmbudOrgNumber, getSystemCertInfo } from './lib/system-auth/config'
import {
  getConnection,
  isOrgNumberContested,
  markConnectionRevoked,
  recordProbeResult,
} from './lib/connection-store'
import { currentSkvEnvironment, resolveReadAuth } from './lib/resolve-auth'
import { probeCompanyGrants } from './lib/grant-probe'
import { formatRedovisare } from '@/lib/skatteverket/format'
import { isSkvSessionRefreshable } from '@/lib/skatteverket/session-lifetime'
import { createUtseOmbudDeepLink, OMBUD_ROLE_KEYS, OmbudApiError } from './lib/ombud-client'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import type {
  SkvSubmitResult,
  SkattekontoBookCommitResult,
} from '@/lib/pending-operations/skatteverket-commit'
import {
  agiPostUnderlag,
  agiGetKontrollresultat,
  agiSparaUnderlag,
  agiAvbrytUnderlag,
  agiTaBortSparadInlamning,
  agiSkapaGranskningsunderlag,
  agiGetKvittenser,
  agiLasPeriod,
  agiLasUppPeriod,
  agiKontrolleraHU,
  agiKontrolleraIU,
} from './lib/agi-client'
import { syncSkattekonto, SKATTEKONTO_BALANCE_SNAPSHOT_KEY, SKATTEKONTO_LAST_SYNCED_AT_KEY } from './lib/skattekonto-sync'
import { fetchVatDeclarationStatus } from './lib/declaration-status'
import { runPostConnectRefresh } from './lib/post-connect-refresh'
import { readAgiSubmissionStatus } from './lib/agi-submission-status'
import {
  attachBookingSuggestions,
  bokforSkattekontoTransaction,
  bokforSkattekontoTransactionsBatch,
  SkattekontoBookingError,
} from './lib/skattekonto-booking'
import {
  findMatchCandidates,
  findMatchSuggestionsBulk,
  matchSkattekontoToEntry,
  SkattekontoMatchError,
} from './lib/skattekonto-match'
import { splitTransactions } from './lib/skattekonto-buckets'
import type { SkattekontoBalanceSnapshot } from './types'
import type { VatPeriodType } from '@/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('skatteverket')

// Body for POST /skattekonto/transaktioner/bokfor-batch. Capped at 200 ids:
// a full year of skattekonto events fits comfortably, and the sequential
// draft+commit loop stays well inside the dispatcher's time budget.
const SkattekontoBokforBatchSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
})

/**
 * Skatteverket integration extension.
 *
 * Enables filing momsdeklaration (VAT declaration) and arbetsgivardeklaration
 * (AGI), plus Skattekonto saldo sync. Users authenticate with BankID via the
 * `per` (e-legitimation) OAuth2 flow.
 *
 * Required environment variables:
 * - SKATTEVERKET_OAUTH2_CLIENT_ID
 * - SKATTEVERKET_OAUTH2_CLIENT_SECRET
 * - SKATTEVERKET_APIGW_CLIENT_ID
 * - SKATTEVERKET_APIGW_CLIENT_SECRET
 * - SKATTEVERKET_TOKEN_ENCRYPTION_KEY (openssl rand -base64 32; never reuse
 *   the test-env key in prod)
 *
 * Optional:
 * - SKATTEVERKET_ENV                            : 'test' | 'production'.
 *                                                 Drives security-relevant
 *                                                 limits (AGI payload size:
 *                                                 100 MB test vs 300 MB prod).
 *                                                 Defaults to 'test' (stricter)
 *                                                 when unset or unrecognised.
 *                                                 MUST be set explicitly in
 *                                                 every deployment manifest.
 * - SKATTEVERKET_OAUTH_BASE_URL                 : defaults to test
 * - SKATTEVERKET_API_BASE_URL                   : momsdeklaration; defaults to test
 * - SKATTEVERKET_AGD_INLAMNING_API_BASE_URL     : AGI inlämning; defaults to test
 * - SKATTEVERKET_AGD_PERIOD_API_BASE_URL        : AGI period mgmt; defaults to test
 * - SKATTEVERKET_SKATTEKONTO_API_BASE_URL       : Skattekonto; defaults to test
 * - SKATTEVERKET_DISABLED=true                  : emergency kill switch
 *
 * ─── Production cutover checklist ─────────────────────────────────────────
 * Before flipping the env URLs to prod, the following has to land first
 * (most are external blockers):
 *
 *   1. Register a prod OAuth2 client in Skatteverket's developer portal
 *      (separate from the test client). Requires a signed integrationsavtal.
 *   2. Order APIGW prod credentials (separate ärende).
 *   3. Register the prod redirect URI:
 *      `${NEXT_PUBLIC_APP_URL}/api/extensions/ext/skatteverket/callback`.
 *   4. Request scopes: agd:skicka, agd:lasa, skattekonto:lasa, moms:skicka.
 *   5. Pass Skatteverket's godkännandetest (they validate a few real AGI
 *      submissions in their test tenant before granting prod access).
 *   6. Generate a fresh SKATTEVERKET_TOKEN_ENCRYPTION_KEY (rotate from test).
 *   7. Set the prod base URLs:
 *        SKATTEVERKET_API_BASE_URL=https://api.skatteverket.se/momsdeklaration/v1
 *        SKATTEVERKET_AGD_INLAMNING_API_BASE_URL=https://api.skatteverket.se/arbetsgivardeklaration/inlamning/v1
 *        SKATTEVERKET_AGD_PERIOD_API_BASE_URL=https://api.skatteverket.se/arbetsgivardeklaration/hanteraredovisningsperiod/v1
 *        SKATTEVERKET_SKATTEKONTO_API_BASE_URL=https://api.skatteverket.se/beskattning/skattekonto/v2
 *        SKATTEVERKET_OAUTH_BASE_URL=https://peroauth2.skatteverket.se/oauth2/v1/per
 *        (per-flow prod host, verified resolving; oauth2.skatteverket.se does not exist)
 *   8. Wire an observability provider (lib/observability has the sink but no
 *      adapter is registered yet) and verify it alerts on
 *      /api/extensions/ext/skatteverket/* 5xx.
 *   9. Verify 7-year retention of `agi_declarations.xml_content` +
 *      `kvittensnummer` (BFL 7 kap.).
 *  10. Run a single AGI end-to-end against test on a real client before
 *      switching that client over.
 *
 * ─── System auth (ombud + org certificate) cutover checklist ──────────────
 * The hybrid model's background-read credentials. All code ships behind
 * SKATTEVERKET_SYSTEM_AUTH_MODE=off; flipping to shadow/on requires:
 *
 *   1. Skatteverket's CCG/org-flow docs (token endpoint URL, mechanism
 *      mTLS vs private_key_jwt, scope names, whether APIGW headers persist,
 *      whether resource calls need the client cert).
 *   2. Organisationscertifikat from Expisoft (test + prod) for Accounted's
 *      org number, base64-wrapped into SKATTEVERKET_SYSTEM_CERT_PEM_B64 /
 *      _KEY_PEM_B64.
 *   3. Bilateral avtal per API for the org flow (skattekonto read, AGI read,
 *      momsdeklaration ombud) + APIGW subscriptions for the system client.
 *   4. Set SKATTEVERKET_SYSTEM_OAUTH_TOKEN_URL, _SCOPES, _CLIENT_ID,
 *      _AUTH_MECHANISM per the docs; SKATTEVERKET_OMBUD_ORG_NUMBER =
 *      Accounted's org number (shown to users in the grant instructions).
 *   5. First live call against Ombudshantering v2 in the test service
 *      (scope `obr` was added to application id arcimtechnologyab_gnubok_1
 *      on 2026-09-01): confirm the list envelope, read the rollbeteckning
 *      codes from GET /roller and pin them in SKATTEVERKET_OMBUD_ROLL_LASOMBUD
 *      / SKATTEVERKET_OMBUD_ROLL_MOMS (lib/ombud-client.ts). Grant
 *      verification then runs on the register; the read-service probes in
 *      grant-probe.ts stay as the fallback and still need their 403 bodies
 *      validated (shadow mode in the test environment first).
 *   6. Godkännandetest per API, then SKATTEVERKET_SYSTEM_AUTH_MODE=on in
 *      prod. User tokens remain the fallback indefinitely. The daily ombud
 *      sync cron (/api/extensions/skatteverket/ombud/sync/cron) runs from
 *      shadow mode on: it only records grant state.
 *
 * The /status endpoint reports which environment is active so the UI can
 * surface a Testmiljö / Produktion badge.
 */

const AGI_WRITE_ROLES = new Set(['owner', 'admin', 'member'])

/**
 * Paywall gate for routes that talk to Skatteverket's API. The declaration
 * FILE download is always free (manual filing is never blocked); the direct
 * API interaction (connect, validate, draft, lock, submit, sync) is the paid
 * convenience. Returns null when entitled, a 403 capability_blocked response
 * otherwise. Unlock (DELETE /declaration/lock) is deliberately NOT gated so a
 * lapsed company can always recover a draft it locked while entitled.
 */
async function requireSkvCapability(ctx: ExtensionContext): Promise<NextResponse | null> {
  return requireCapability(ctx.supabase, ctx.companyId, CAPABILITY.skatteverket)
}

/**
 * The ombud path binds Skatteverket system-credential access to an org
 * number, and org numbers are public and tenant-editable. While more than
 * one live company claims the same one, no company may verify a grant or
 * mint a deep link on it: a tenant that typed a victim's number must never
 * inherit the victim's grant. Returns the 409 to send, or null when clear.
 */
async function contestedOrgNumberResponse(orgNumber: string): Promise<NextResponse | null> {
  if (!(await isOrgNumberContested(orgNumber))) return null
  return NextResponse.json(
    {
      error:
        'Organisationsnumret används av fler än ett företag i Accounted. ' +
        'Kontakta support för att aktivera ombudsanslutningen.',
      code: 'ORG_NUMBER_CONTESTED',
    },
    { status: 409 }
  )
}

/**
 * Resolve auth for a company-scoped READ triggered from the UI: the caller's
 * own token if they connected, otherwise any active token another member of
 * the company connected (see resolve-auth.ts, #1673). Membership is the only
 * gate: ctx.companyId is resolved from the caller's own memberships and the
 * token table's SELECT policy is company-scoped, so this can never reach
 * another company's row.
 */
function resolveCompanyReadAuth(ctx: ExtensionContext) {
  return resolveReadAuth(ctx.supabase, ctx.companyId, { requires: 'lasombud', userId: ctx.userId })
}

/**
 * The 401 a read route answers when no usable company token exists.
 * NOT_CONNECTED keeps the "inte anslutet" empty state (no row at all);
 * SESSION_EXPIRED mirrors what the token refresh would have thrown for a row
 * already flagged needs_reconsent, so the UI shows its reconnect prompt
 * instead of pretending the company never connected.
 */
function readAuthFailureResponse(reason: 'no_token' | 'needs_reconsent'): NextResponse {
  if (reason === 'needs_reconsent') {
    return NextResponse.json(
      {
        error:
          'Anslutningen mot Skatteverket har gått ut. Skatteverkets inloggning gäller bara ca 1 timme, så detta är normalt. Anslut igen med BankID.',
        code: 'SESSION_EXPIRED',
      },
      { status: 401 },
    )
  }
  return NextResponse.json(
    { error: 'Inte ansluten till Skatteverket.', code: 'NOT_CONNECTED' },
    { status: 401 },
  )
}

/**
 * Defense-in-depth RBAC check for AGI write/validate endpoints. Ctx
 * presence alone (set by middleware) only confirms the user is signed in
 * and has a resolved company; it does NOT prove they are entitled to
 * submit tax declarations for that company. Viewers must be blocked.
 *
 * Returns null on success, a NextResponse on failure.
 */
async function requireAgiWriteRole(ctx: ExtensionContext): Promise<NextResponse | null> {
  const { data, error } = await ctx.supabase
    .from('company_members')
    .select('role')
    .eq('company_id', ctx.companyId)
    .eq('user_id', ctx.userId)
    .maybeSingle()

  if (error) {
    return NextResponse.json(
      { error: 'Behörighetskontroll misslyckades.' },
      { status: 500 },
    )
  }
  if (!data?.role || !AGI_WRITE_ROLES.has(data.role as string)) {
    return NextResponse.json(
      { error: 'Otillräcklig behörighet för att lämna in AGI för det här företaget.' },
      { status: 403 },
    )
  }
  return null
}

/**
 * Base URL for the OAuth redirect_uri registered with Skatteverket in
 * Utvecklarportalen. Registration changes there are slow, so after the
 * user-facing app moved to app.accounted.se the redirect_uri stays pinned
 * to the legacy domain via NEXT_PUBLIC_SKV_OAUTH_BASE_URL (hosted value:
 * https://app.gnubok.se). Self-hosted deployments leave it unset and the
 * regular app URL is used.
 */
function getSkvOauthBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SKV_OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000'
  )
}

export const skatteverketExtension: Extension = {
  id: 'skatteverket',
  name: 'Skatteverket Integration',
  version: '1.0.0',

  settingsPanel: {
    label: 'Skatteverket',
    path: '/settings/account',
  },

  apiRoutes: [
    // ── OAuth: Start authorization ──────────────────────────────────
    // Builds the Skatteverket OAuth2 authorize URL and redirects the user
    // to BankID login. Stores state token in extension settings for CSRF validation.
    {
      method: 'GET',
      path: '/authorize',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        const state = crypto.randomUUID()
        let redirectUri = `${getSkvOauthBaseUrl()}/api/extensions/ext/skatteverket/callback`

        // Optional: where to send the user after the BankID round-trip.
        // Allowlisted to internal in-app paths to avoid open-redirect abuse.
        const url = new URL(request.url)
        const requestedReturn = url.searchParams.get('return_to')
        const returnTo =
          requestedReturn && requestedReturn.startsWith('/') && !requestedReturn.startsWith('//')
            ? requestedReturn
            : null

        // Generate PKCE pair: verifier persisted server-side, challenge sent
        // to SKV. Some SKV per-flow client configurations issue revoked-on-use
        // tokens unless PKCE is present, so we always send it.
        const pkce = generatePkcePair()

        // Connector mode (self-host with a connector key and no own SKV
        // client): the broker builds the authorize URL against Arcim's
        // registered SKV client and OUR hosted redirect_uri; the hosted
        // callback bounces the browser back to THIS instance's /callback with
        // the code. The broker's redirect_uri replaces the local one (the
        // token exchange must repeat the redirect_uri SKV saw), and the
        // broker's signed connector_state is persisted for that exchange.
        const connector = skatteverketConnectorMode()
        let authorizeUrl: string
        let connectorState: string | null = null
        if (connector) {
          try {
            const started = await startConnectorAuthorization(connector, {
              companyRef: ctx.companyId,
              returnUrl: redirectUri,
              state,
              codeChallenge: pkce.challenge,
            })
            redirectUri = started.redirectUri
            connectorState = started.connectorState
            authorizeUrl = started.authorizeUrl
          } catch (err) {
            log.error('connector authorize-url failed', err as Error, { companyId: ctx.companyId })
            return NextResponse.json(
              {
                error:
                  'Kunde inte starta Skatteverket-anslutningen via connectorn. ' +
                  'Kontrollera GNUBOK_CONNECTOR_KEY och anslutningsläget på /api/connector/status.',
              },
              { status: 502 },
            )
          }
        } else {
          authorizeUrl = buildAuthorizeUrl(redirectUri, state, {
            codeChallenge: pkce.challenge,
          })
        }

        // Store state for CSRF validation in callback. The user id is stored
        // alongside it because the callback runs on the OAuth host (see
        // getSkvOauthBaseUrl), where the browser carries no session cookies
        // once the user-facing app lives on its own domain.
        await ctx.settings.set('oauth_state', state)
        await ctx.settings.set('oauth_user_id', ctx.userId)
        await ctx.settings.set('oauth_redirect_uri', redirectUri)
        await ctx.settings.set('oauth_code_verifier', pkce.verifier)
        if (connectorState) await ctx.settings.set('oauth_connector_state', connectorState)
        else await ctx.settings.clear('oauth_connector_state')
        if (returnTo) await ctx.settings.set('oauth_return_to', returnTo)
        else await ctx.settings.clear('oauth_return_to')

        return NextResponse.redirect(authorizeUrl)
      },
    },

    // ── OAuth: Callback ─────────────────────────────────────────────
    // Receives the auth code from Skatteverket after BankID login.
    // Exchanges code for tokens immediately (5-minute code expiry).
    // skipAuth: true; browser redirect from Skatteverket. We handle
    // user identification via the stored state token + Supabase session.
    {
      method: 'GET',
      path: '/callback',
      skipAuth: true,
      handler: async (request: Request) => {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        const url = new URL(request.url)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')

        // Connector branch: a self-hosted instance started this SKV consent
        // through the /api/connect/skv broker, which registered OUR redirect
        // uri and a signed connector state. We never exchange the code here
        // (the instance does, through the broker's /oauth/token): just bounce
        // the browser back to the instance with the code + its original
        // state, so no per-instance redirect uri is registered at SKV.
        if (isConnectorState(state)) {
          const verified = verifyConnectorState(state as string)
          if (!verified.ok || verified.payload.svc !== 'skv') {
            return NextResponse.redirect(`${appUrl}/?connector_error=${encodeURIComponent(verified.ok ? 'wrong_service' : verified.reason)}`)
          }
          const ret = new URL(verified.payload.ret)
          if (error) ret.searchParams.set('error', error)
          const errorDescription = url.searchParams.get('error_description')
          if (errorDescription) ret.searchParams.set('error_description', errorDescription)
          if (code) ret.searchParams.set('code', code)
          if (verified.payload.st) ret.searchParams.set('state', verified.payload.st)
          ret.searchParams.set('connector_state', state as string)
          return NextResponse.redirect(ret.toString())
        }

        // Injection-safety invariants: appUrl comes from NEXT_PUBLIC_APP_URL
        // (deployment configuration, never user input), and jsLiteral
        // JSON-encodes and escapes `<` so embedded values cannot break out of
        // the script context. The per-response CSP nonce below is defense in
        // depth on top of that: even injected markup could never execute.
        const jsLiteral = (value: unknown) =>
          JSON.stringify(value ?? '').replace(/</g, '\\u003c')

        // CSP allows only the nonce-carrying inline script; everything else
        // is blocked. Cache-Control: no-store because the callback URL
        // carries a one-shot authorization code and must never be cached.
        const responseHeaders = (nonce: string) => ({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
          'Cache-Control': 'no-store',
        })

        // Build an HTML response that detects whether we're running inside an
        // OAuth popup. If `window.opener` exists, post a message back to the
        // parent and close the popup. Otherwise fall back to a plain redirect
        // (preserves the legacy non-popup connect flow). The fallback uses
        // location.replace so this callback URL (whose code and state are
        // consumed) drops out of history: navigating Back from the landing
        // page must not re-run the callback into a guaranteed CSRF error.
        const respondWithSuccess = (fallbackPath: string) => {
          const nonce = crypto.randomUUID()
          const html = `<!DOCTYPE html><html><body><script nonce="${nonce}">
            if (window.opener) {
              window.opener.postMessage({ type: 'skatteverket-oauth-success' }, ${jsLiteral(appUrl)});
              window.close();
            } else {
              window.location.replace(${jsLiteral(`${appUrl}${fallbackPath}`)});
            }
          </script><p>Anslutningen lyckades. Du kan stänga denna flik.</p></body></html>`
          return new Response(html, {
            status: 200,
            headers: responseHeaders(nonce),
          })
        }

        const respondWithError = (reason: string, fallbackPath: string) => {
          const nonce = crypto.randomUUID()
          const escapedReason = reason
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
          const html = `<!DOCTYPE html><html><body><script nonce="${nonce}">
            if (window.opener) {
              window.opener.postMessage({ type: 'skatteverket-oauth-error', reason: ${jsLiteral(reason)} }, ${jsLiteral(appUrl)});
              window.close();
            } else {
              window.location.replace(${jsLiteral(`${appUrl}${fallbackPath}`)});
            }
          </script><p>Anslutningen misslyckades: ${escapedReason}</p></body></html>`
          return new Response(html, {
            status: 200,
            headers: responseHeaders(nonce),
          })
        }

        if (error) {
          const desc = url.searchParams.get('error_description') || 'Okänt fel'
          return respondWithError(
            desc,
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent(desc)}`,
          )
        }

        if (!code || !state) {
          return respondWithError(
            'Saknar auktoriseringskod',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Saknar auktoriseringskod')}`,
          )
        }

        // This callback is served on the OAuth host (see getSkvOauthBaseUrl),
        // where the browser has no session cookies once the user-facing app
        // lives on its own domain. The flow is resolved entirely from the
        // state token: /authorize stored state, user id, redirect_uri and
        // PKCE verifier keyed on company_id, and the state value is an
        // unguessable single-use UUID, so the bare lookup by value doubles
        // as the CSRF check.
        const { createClient, createServiceClient } = await import('@/lib/supabase/server')
        const db = createServiceClient()

        // States are single-use and short-lived: the recency bound both
        // caps how long a leaked/phished authorize URL stays completable
        // (the row expires ten minutes after /authorize refreshed it) and
        // keeps the row set far below PostgREST's silent 1000-row cap.
        // value is jsonb, so equality is matched in JS rather than in the
        // PostgREST filter, where JSON serialization rules would apply.
        const stateCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
        const { data: stateRows, error: stateError } = await db
          .from('extension_data')
          .select('company_id, value')
          .eq('extension_id', 'skatteverket')
          .eq('key', 'oauth_state')
          .gte('updated_at', stateCutoff)

        if (stateError) {
          log.error('oauth state lookup failed', stateError)
          return respondWithError(
            'Ett tekniskt fel uppstod. Försök igen.',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Ett tekniskt fel uppstod')}`,
          )
        }

        const stateMatch = (stateRows ?? []).find((row) => row.value === state)
        if (!stateMatch) {
          return respondWithError(
            'Ogiltig state-parameter (CSRF)',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Ogiltig state-parameter (CSRF)')}`,
          )
        }
        const companyId = stateMatch.company_id as string

        const readSetting = async (key: string): Promise<string | null> => {
          const { data } = await db
            .from('extension_data')
            .select('value')
            .eq('company_id', companyId)
            .eq('extension_id', 'skatteverket')
            .eq('key', key)
            .maybeSingle()
          return (data?.value as string | null) ?? null
        }

        // Flows that started before oauth_user_id shipped ran on the same
        // domain as the app and still carry session cookies; fall back to
        // those so in-flight connects survive the deploy boundary.
        let userId = await readSetting('oauth_user_id')
        if (!userId) {
          const cookieClient = await createClient()
          const { data: { user } } = await cookieClient.auth.getUser()
          userId = user?.id ?? null
        }
        if (!userId) {
          return respondWithError(
            'Sessionen har gått ut. Stäng fliken och försök ansluta igen.',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Sessionen har gått ut')}`,
          )
        }

        // Defense in depth for the service-role write below: the stored
        // user must still be a member of the company that initiated the
        // flow (membership can be revoked between /authorize and this
        // callback, and RLS no longer backstops the write). Checked before
        // the exchange so a rejected flow does not burn the one-shot
        // authorization code. (#1091)
        const { data: membership } = await db
          .from('company_members')
          .select('user_id')
          .eq('company_id', companyId)
          .eq('user_id', userId)
          .maybeSingle()
        if (!membership) {
          return respondWithError(
            'Behörighet saknas för företaget',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Behörighet saknas för företaget')}`,
          )
        }

        const redirectUri = (await readSetting('oauth_redirect_uri')) ||
          `${getSkvOauthBaseUrl()}/api/extensions/ext/skatteverket/callback`

        // Retrieve the PKCE verifier stored in /authorize. Optional only for
        // backward compatibility with in-flight flows that started before the
        // PKCE rollout: once those drain, this can be made required.
        const codeVerifier = (await readSetting('oauth_code_verifier')) || undefined

        // Connector mode: the broker's signed state, stored by /authorize
        // (authoritative) with the hosted callback's bounced query param as
        // fallback for a row written before the store landed. Required by the
        // broker's token exchange; undefined on the direct path.
        const connectorState =
          (await readSetting('oauth_connector_state')) ||
          url.searchParams.get('connector_state') ||
          undefined

        // Optional in-app destination set by /authorize?return_to=...
        const returnTo = await readSetting('oauth_return_to')
        const successPath = returnTo
          ? `${returnTo}${returnTo.includes('?') ? '&' : '?'}skv_connected=true`
          : `/reports?tab=vat-declaration&skv_connected=true`
        const errorPath = (msg: string) =>
          returnTo
            ? `${returnTo}${returnTo.includes('?') ? '&' : '?'}skv_error=${encodeURIComponent(msg)}`
            : `/reports?tab=vat-declaration&skv_error=${encodeURIComponent(msg)}`

        try {
          const tokens = await exchangeCodeForTokens(code, redirectUri, codeVerifier, connectorState)
          await storeTokens(db, userId, tokens, companyId)

          // Clean up CSRF state + the one-shot user id/return_to/PKCE verifier.
          await db
            .from('extension_data')
            .delete()
            .eq('company_id', companyId)
            .eq('extension_id', 'skatteverket')
            .in('key', ['oauth_state', 'oauth_user_id', 'oauth_return_to', 'oauth_code_verifier', 'oauth_connector_state'])

          // Refresh Skatteverket-derived data AFTER the response is sent.
          // Right-after-consent is still the one reliable window for a
          // personal-token fetch (SKV per-flow tokens live ~65 minutes), but
          // the sync (skattekonto fetch + AGI auto-settle + kvittens
          // re-checks) can take tens of seconds. This handler previously
          // awaited it, which held the redirect open while the popup kept
          // displaying SKV's already-consumed consent page; users read that
          // as "I approved and nothing happened". The eager promise +
          // after() pattern (mirrors the enable-banking finalize page) sends
          // the success page immediately and keeps the serverless function
          // alive until the refresh settles; the connect panels do a delayed
          // status refetch to pick up the synced data. Best-effort: a
          // refresh failure must never fail the connect that just succeeded.
          const refreshPromise = runPostConnectRefresh(db, userId, companyId)
            .then(() => undefined)
            .catch((refreshErr) => {
              log.error('post-connect refresh failed', refreshErr, { companyId, userId })
            })
          try {
            after(() => refreshPromise)
          } catch {
            // Outside a request scope (unit tests, plain node server): the
            // eager promise still drives the refresh to completion.
          }

          return respondWithSuccess(successPath)
        } catch (err) {
          console.error('[skatteverket] Token exchange failed:', err)
          // The ephemeral flow rows must not outlive the flow: oauth_user_id
          // in particular holds a user identity and serves no purpose once
          // the exchange has failed (#1090). Best-effort: a cleanup failure
          // must not mask the exchange error shown to the user.
          try {
            await db
              .from('extension_data')
              .delete()
              .eq('company_id', companyId)
              .eq('extension_id', 'skatteverket')
              .in('key', ['oauth_state', 'oauth_user_id', 'oauth_return_to', 'oauth_code_verifier', 'oauth_connector_state'])
          } catch (cleanupErr) {
            log.error('oauth state cleanup after failed exchange failed', cleanupErr, { companyId })
          }
          // BankID auth codes expire after 5 minutes. Surface timeouts distinctly
          // so the user retries quickly instead of exhausting the code window.
          const message = err instanceof TimeoutError
            ? 'Tidsgränsen mot Skatteverket överskreds: försök igen med BankID'
            : err instanceof Error
              ? err.message
              : 'Token exchange misslyckades'
          return respondWithError(message, errorPath(message))
        }
      },
    },

    // ── Connection status ───────────────────────────────────────────
    {
      method: 'GET',
      path: '/status',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        const tokens = await getTokens(ctx.supabase, ctx.userId, ctx.companyId)
        const environment = getSkatteverketEnvironment()
        const disabled = (process.env.SKATTEVERKET_DISABLED ?? '').toLowerCase() === 'true'

        if (!tokens) {
          return NextResponse.json({ connected: false, environment, disabled })
        }

        const expired = tokens.expires_at < Date.now()
        // Honest refreshability: SKV's per-flow refresh token dies 65 minutes
        // after issue, five minutes past access-token expiry. A stored
        // refresh token past that window is not "can refresh"; reporting it
        // as such kept the reconnect banner silent for days.
        const canRefresh = isSkvSessionRefreshable({
          expiresAt: tokens.expires_at,
          hasRefreshToken: tokens.refresh_token !== null,
          refreshCount: tokens.refresh_count,
        })

        // Persisted health, written by the crons when they hit a terminal
        // auth state. Lets the settings panel prompt for re-consent
        // proactively instead of only after a live failure.
        const health = await getTokenHealth(ctx.supabase, ctx.userId, ctx.companyId)

        return NextResponse.json({
          connected: true,
          expired,
          canRefresh,
          needsReconsent: health?.status === 'needs_reconsent',
          lastErrorCode: health?.last_error_code ?? null,
          scope: tokens.scope,
          expiresAt: new Date(tokens.expires_at).toISOString(),
          environment,
          disabled,
        })
      },
    },

    // ── Disconnect ──────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/disconnect',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        await deleteTokens(ctx.supabase, ctx.userId, ctx.companyId)
        return NextResponse.json({ success: true })
      },
    },

    // ══════════════════════════════════════════════════════════════
    // System connection (ombud + organization certificate)
    //
    // The hybrid auth model's per-company side: the user grants Accounted's
    // org number a behorighet at Skatteverket's Ombud och behorigheter
    // e-service (one-time BankID signature), we verify it with a probe on
    // SYSTEM credentials, and background reads stop depending on the
    // 65-minute personal token. All of it is inert until
    // SKATTEVERKET_SYSTEM_AUTH_MODE is switched on.
    // ══════════════════════════════════════════════════════════════

    // ── System connection: status + instructions ────────────────────
    {
      method: 'GET',
      path: '/system-connection',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        const mode = getSystemAuthMode()
        const available = mode !== 'off' && isSystemAuthConfigured()
        if (!available) {
          return NextResponse.json({ available: false, mode })
        }

        const connection = await getConnection(ctx.companyId, currentSkvEnvironment())
        return NextResponse.json({
          available: true,
          mode,
          environment: currentSkvEnvironment(),
          // What the user grants the behorigheter to, plus where.
          ombud_org_number: getOmbudOrgNumber(),
          grant_url: 'https://skatteverket.se/ombud',
          behorigheter: [
            { key: 'lasombud', label: 'Juridiskt läsombud' },
            { key: 'moms_ombud', label: 'Momsdeklaration, ombud' },
          ],
          cert: getSystemCertInfo(),
          connection,
        })
      },
    },

    // ── System connection: verify (probe the grants) ────────────────
    {
      method: 'POST',
      path: '/system-connection/verify',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireAgiWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        if (getSystemAuthMode() === 'off' || !isSystemAuthConfigured()) {
          return NextResponse.json(
            { error: 'Systemanslutningen är inte aktiverad i denna miljö.' },
            { status: 503 }
          )
        }

        // Manual probes are rate limited: one per minute per company.
        const existing = await getConnection(ctx.companyId, currentSkvEnvironment())
        if (existing?.last_probe_at && Date.now() - new Date(existing.last_probe_at).getTime() < 60_000) {
          return NextResponse.json(
            { error: 'Vänta en minut mellan verifieringar.', connection: existing },
            { status: 429 }
          )
        }

        const { data: settings } = await ctx.supabase
          .from('company_settings')
          .select('org_number, entity_type')
          .eq('company_id', ctx.companyId)
          .single()
        if (!settings?.org_number) {
          return NextResponse.json(
            { error: 'Organisationsnummer saknas. Ange det under Inställningar först.' },
            { status: 400 }
          )
        }
        const orgNumber = formatRedovisare(
          settings.org_number as string,
          settings.entity_type as 'enskild_firma' | 'aktiebolag'
        )

        const contestedForVerify = await contestedOrgNumberResponse(orgNumber)
        if (contestedForVerify) return contestedForVerify

        try {
          const result = await probeCompanyGrants(ctx.companyId, orgNumber, ctx.userId)
          await writeSkatteverketAudit(ctx, {
            endpoint: 'system-connection/verify',
            agRegistreradId: orgNumber,
            outcome: 'ok',
          })
          return NextResponse.json({
            data: {
              connection: result.connection,
              // Spelled-out per-behorighet outcome so the UI can say
              // "läsombud OK, momsbehörighet saknas fortfarande".
              lasombud: result.lasombud,
              moms_ombud: result.momsOmbud,
            },
          })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── System connection: deep link to appoint Accounted as ombud ──
    // Ombudshantering v2 mints a link into Skatteverket's e-service with
    // Accounted pre-filled as ombud and both roles pre-selected; the company
    // only signs with BankID there. Runs on the system identity (the link's
    // ombud is whoever holds the token), so it needs the same configuration
    // as verify.
    {
      method: 'POST',
      path: '/system-connection/deeplink',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireAgiWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        if (getSystemAuthMode() === 'off' || !isSystemAuthConfigured()) {
          return NextResponse.json(
            { error: 'Systemanslutningen är inte aktiverad i denna miljö.' },
            { status: 503 }
          )
        }

        const { data: settings } = await ctx.supabase
          .from('company_settings')
          .select('org_number, entity_type')
          .eq('company_id', ctx.companyId)
          .single()
        if (!settings?.org_number) {
          return NextResponse.json(
            { error: 'Organisationsnummer saknas. Ange det under Inställningar först.' },
            { status: 400 }
          )
        }
        const orgNumber = formatRedovisare(
          settings.org_number as string,
          settings.entity_type as 'enskild_firma' | 'aktiebolag'
        )

        const contestedForLink = await contestedOrgNumberResponse(orgNumber)
        if (contestedForLink) return contestedForLink

        try {
          const link = await createUtseOmbudDeepLink(orgNumber, OMBUD_ROLE_KEYS)
          // Minting the link is the tenant's opt-in: record a pending row
          // (no grant state yet) so the nightly ombud sync, which only ever
          // touches existing rows, picks the signed grant up on its own.
          const optIn = await recordProbeResult({
            companyId: ctx.companyId,
            environment: currentSkvEnvironment(),
            orgNumber,
            createdBy: ctx.userId,
            error: null,
          })
          if (!optIn) {
            // Handing out the link without the row would let the company
            // sign at Skatteverket and never be picked up by the sync.
            log.error('deep link minted but opt-in row could not be stored', { companyId: ctx.companyId })
            return NextResponse.json(
              { error: 'Anslutningen kunde inte sparas. Försök igen.' },
              { status: 500 }
            )
          }
          await writeSkatteverketAudit(ctx, {
            endpoint: 'system-connection/deeplink',
            agRegistreradId: orgNumber,
            outcome: 'ok',
          })
          return NextResponse.json({
            data: {
              djuplank: link.djuplank,
              roller: link.roller,
              expires_on: link.expiresOn,
            },
          })
        } catch (err) {
          if (err instanceof OmbudApiError) {
            log.warn('ombud deep link failed', { companyId: ctx.companyId, code: err.code, message: err.message })
            return NextResponse.json({ error: err.message, code: err.code }, { status: 502 })
          }
          return handleSkvError(err)
        }
      },
    },

    // ── System connection: revoke locally ───────────────────────────
    {
      method: 'DELETE',
      path: '/system-connection',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const roleBlocked = await requireAgiWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        // Marks the local row revoked (kept for history). Withdrawing the
        // actual behorighet happens at skatteverket.se; this only stops us
        // from using system credentials for the company.
        await markConnectionRevoked(ctx.companyId, currentSkvEnvironment())
        return NextResponse.json({ success: true })
      },
    },

    // ── Validate declaration (dry run) ──────────────────────────────
    // Sends momsuppgift to Skatteverket's /kontrollera endpoint.
    // Returns ERROR/WARNING/OK without saving anything.
    {
      method: 'POST',
      path: '/declaration/validate',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        try {
          const { redovisare, redovisningsperiod, momsuppgift } =
            await parseDeclarationRequest(request, ctx)

          console.log('[skatteverket] Validating:', {
            redovisare,
            redovisningsperiod,
            momsuppgift: JSON.stringify(momsuppgift),
          })

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'POST',
            `/kontrollera/${redovisare}/${redovisningsperiod}`,
            momsuppgift
          )

          if (!response.ok) {
            const text = await response.text()
            console.error('[skatteverket] Validate error:', response.status, text)
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()
          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Save draft ──────────────────────────────────────────────────
    // Saves momsuppgift to Skatteverket's "Eget utrymme".
    // Returns validation results. Optionally lock for signing.
    {
      method: 'POST',
      path: '/declaration/draft',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        try {
          const { redovisare, redovisningsperiod, momsuppgift } =
            await parseDeclarationRequest(request, ctx)

          console.log('[skatteverket] Sending draft:', {
            redovisare,
            redovisningsperiod,
            momsuppgift: JSON.stringify(momsuppgift),
          })

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'POST',
            `/utkast/${redovisare}/${redovisningsperiod}`,
            momsuppgift
          )

          if (!response.ok) {
            const text = await response.text()
            console.error('[skatteverket] Draft error:', response.status, text)
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          // Track submission status
          await ctx.settings.set(
            `submission_${redovisningsperiod}`,
            JSON.stringify({
              status: 'draft_saved',
              redovisare,
              redovisningsperiod,
              kontrollresultat: data.kontrollresultat,
              updatedAt: new Date().toISOString(),
            })
          )

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch draft ─────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/draft',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'GET',
            `/utkast/${redovisare}/${redovisningsperiod}`
          )

          if (response.status === 404) {
            return NextResponse.json({ data: null })
          }

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()
          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Delete draft ────────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/declaration/draft',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'DELETE',
            `/utkast/${redovisare}/${redovisningsperiod}`
          )

          if (response.status !== 204 && !response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          await ctx.settings.clear(`submission_${redovisningsperiod}`)
          return NextResponse.json({ success: true })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Lock draft for signing ──────────────────────────────────────
    // Returns a signeringslänk (deep link) that the user opens
    // in a new tab to sign with BankID on Skatteverket's site.
    {
      method: 'PUT',
      path: '/declaration/lock',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'PUT',
            `/las/${redovisare}/${redovisningsperiod}`
          )

          await writeSkatteverketAudit(ctx, {
            endpoint: 'declaration/lock',
            agRegistreradId: redovisare,
            redovisningsperiod,
            outcome: response.ok ? 'ok' : 'skv_error',
            responseStatus: response.status,
          })

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          await ctx.settings.set(
            `submission_${redovisningsperiod}`,
            JSON.stringify({
              status: 'draft_locked',
              redovisare,
              redovisningsperiod,
              signeringsLank: data.signeringsLank,
              updatedAt: new Date().toISOString(),
            })
          )

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Unlock draft ────────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/declaration/lock',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'DELETE',
            `/las/${redovisare}/${redovisningsperiod}`
          )

          if (response.status !== 204 && !response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          await ctx.settings.set(
            `submission_${redovisningsperiod}`,
            JSON.stringify({
              status: 'draft_saved',
              redovisare,
              redovisningsperiod,
              updatedAt: new Date().toISOString(),
            })
          )

          return NextResponse.json({ success: true })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── One-click submit (kontrollera -> utkast -> lås) ─────────────
    // The whole "skicka för signering" chain behind one button. Validation
    // errors abort before anything is written to Eget utrymme; a lock
    // failure leaves the saved draft in place and says so (draft_saved),
    // so the UI can offer a lock-only retry instead of a full re-submit.
    {
      method: 'POST',
      path: '/declaration/submit',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        try {
          const body = (await request.json()) as {
            periodType?: VatPeriodType
            year?: number
            period?: number
            fiscalPeriodId?: string
          }
          const { periodType, year, period, fiscalPeriodId } = body
          if (!periodType || !year || !period) {
            return NextResponse.json(
              { error: 'Saknar obligatoriska fält: periodType, year, period' },
              { status: 400 }
            )
          }

          const result = await submitVatDeclarationChain(
            ctx,
            { periodType, year, period, fiscalPeriodId },
            { validate: true }
          )

          if (!result.ok) {
            return NextResponse.json(
              {
                error: result.error,
                stage: result.stage,
                draft_saved: result.draftSaved,
                kontrollResultat: result.kontrollresultat,
              },
              { status: result.httpStatus }
            )
          }

          return NextResponse.json({
            data: {
              signeringsLank: result.signingUrl,
              redovisare: result.redovisare,
              redovisningsperiod: result.redovisningsperiod,
              kontrollResultat: result.kontrollresultat,
            },
          })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch submitted declaration ─────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/submitted',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          // resolveReadAuth: post-signing checks should outlive the user's
          // 65-minute session when the company has a moms_ombud grant, and
          // any member may read what another member's token fetches (#1673).
          const resolved = await resolveReadAuth(ctx.supabase, ctx.companyId, {
            requires: 'moms_ombud',
            userId: ctx.userId,
          })
          if (!resolved.ok) return readAuthFailureResponse(resolved.reason)
          const response = await skvRequestWithAuth(
            resolved.auth,
            'GET',
            `/inlamnat/${redovisare}/${redovisningsperiod}`
          )

          if (response.status === 404) {
            return NextResponse.json({ data: null })
          }

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          // A non-null inlamnat means the declaration is filed: complete the
          // period's moms deadline. Best-effort, gated on the caller passing
          // the picker params (older clients omit them).
          if (data) {
            await completeVatDeadlineFromRequest(request, ctx, 'submitted')
          }

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch decided declaration ───────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/decided',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const resolved = await resolveReadAuth(ctx.supabase, ctx.companyId, {
            requires: 'moms_ombud',
            userId: ctx.userId,
          })
          if (!resolved.ok) return readAuthFailureResponse(resolved.reason)
          const response = await skvRequestWithAuth(
            resolved.auth,
            'GET',
            `/beslutat/${redovisare}/${redovisningsperiod}`
          )

          if (response.status === 404) {
            return NextResponse.json({ data: null })
          }

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          // A beslut means Skatteverket has processed the filing: confirm
          // the period's moms deadline (terminal state).
          if (data) {
            await completeVatDeadlineFromRequest(request, ctx, 'confirmed')
          }

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },
    // ══════════════════════════════════════════════════════════════
    // AGI (Arbetsgivardeklaration) routes
    //
    // AGI submission is XML, not JSON. We feed agi_declarations.xml_content
    // (built by lib/salary/agi/xml-generator.ts) to POST /underlag, then poll
    // kontrollresultat, save into Eget utrymme, and return a Mina Sidor
    // signing link via skapaGranskningsunderlag. After the user signs we
    // observe the kvittenser endpoint to record kvittensnummer/signeradTid.
    //
    // The route surface mirrors the conceptual flow rather than the literal
    // SKV endpoints so the frontend stays simple. Two SKV APIs are involved:
    // inlamning (XML ingest + JSON status) and hanteraredovisningsperiod
    // (kvittenser + las/lasUpp). The agi-client encapsulates both.
    // ══════════════════════════════════════════════════════════════

    // ── AGI: Submit (POST /underlag with stored XML) ────────────────
    // Body: { salaryRunId }. Reads agi_declarations.xml_content for the run,
    // posts it to Skatteverket, returns { inlamningId } so the caller can
    // poll kontrollresultat. Also persists inlamningId locally for recovery.
    {
      method: 'POST',
      path: '/agi/submit',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        try {
          const { arbetsgivare, period, salaryRunId, xml } = await loadAGIXml(request, ctx)

          console.log('[skatteverket] AGI submitting underlag:', { arbetsgivare, period })

          const result = await agiPostUnderlag(ctx.supabase, ctx.userId, ctx.companyId, xml)
          if (!result.ok) {
            console.error('[skatteverket] AGI underlag error:', result.status, result.error)
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }

          await ctx.settings.set(
            `agi_submission_${period}`,
            JSON.stringify({
              status: 'underlag_submitted',
              arbetsgivare,
              period,
              salaryRunId,
              inlamningId: result.data.inlamningId,
              updatedAt: new Date().toISOString(),
            }),
          )

          // Don't flip agi_declarations.status to 'exported' here. SKV's
          // kontrollresultat may still come back DONE_REJECTED, in which case
          // nothing landed in Eget utrymme. The transition belongs in
          // /agi/spara below, after the user (or auto-spara on success) has
          // committed the underlag.

          return NextResponse.json({ data: result.data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Poll kontrollresultat ──────────────────────────────────
    // Query: ?inlamningId=...
    // Returns { status: PROCESSING | DONE_SUCCESS | DONE_FAILED | DONE_REJECTED, ... }
    //
    // Side effect: when SKV reports a terminal failure (DONE_REJECTED or
    // DONE_FAILED), promote the matching agi_declarations row to 'rejected'.
    // Without this the row would sit at 'generated' indefinitely while SKV's
    // own state shows the underlag as failed: misrepresenting the filing
    // outcome (BFNAR 2013:2 kap 8 / BFL 5 kap 5§).
    {
      method: 'GET',
      path: '/agi/kontrollresultat',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        try {
          const url = new URL(request.url)
          const inlamningId = Number(url.searchParams.get('inlamningId'))
          if (!Number.isFinite(inlamningId) || inlamningId <= 0) {
            return NextResponse.json({ error: 'Saknar parameter: inlamningId' }, { status: 400 })
          }

          const result = await agiGetKontrollresultat(ctx.supabase, ctx.userId, ctx.companyId, inlamningId)
          if (!result.ok) {
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }

          if (result.data.status === 'DONE_REJECTED' || result.data.status === 'DONE_FAILED') {
            // Recover the salaryRunId from cached submission state: same
            // fallback mechanism /agi/spara uses. We only update when we can
            // identify the row; a missing local cache means we silently skip
            // (the alternative would be guessing which declaration to mark).
            const { data: rows } = await ctx.supabase
              .from('extension_data')
              .select('value')
              .eq('company_id', ctx.companyId)
              .eq('extension_id', 'skatteverket')
              .like('key', 'agi_submission_%')
            for (const row of rows ?? []) {
              try {
                const v = JSON.parse(row.value as string) as { inlamningId?: number; salaryRunId?: string }
                if (v.inlamningId === inlamningId && v.salaryRunId) {
                  // Same monotonicity rule as /agi/spara: never regress
                  // from a successful filing back to 'rejected'.
                  await ctx.supabase
                    .from('agi_declarations')
                    .update({ status: 'rejected' })
                    .eq('salary_run_id', v.salaryRunId)
                    .eq('company_id', ctx.companyId)
                    .in('status', ['generated', 'pending_signature', 'exported'])
                  break
                }
              } catch { /* skip malformed */ }
            }
          }

          return NextResponse.json({ data: result.data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Save underlag into Eget utrymme ────────────────────────
    // Body: { inlamningId, salaryRunId? }. Only meaningful between
    // POST /underlag and skapaGranskningsunderlag.
    //
    // Flips agi_declarations.status to 'pending_signature' on success:
    // the underlag is durable in SKV's Eget utrymme but is not yet a
    // filed declaration. /agi/kvittenser later promotes it to 'submitted'
    // when a uuidKvittens (signature receipt) is observed for the period.
    // /agi/submit deliberately does NOT update status, because a
    // DONE_REJECTED kontrollresultat would leave it falsely pending.
    {
      method: 'POST',
      path: '/agi/spara',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        try {
          const body = (await request.json()) as { inlamningId?: number; salaryRunId?: string }
          const inlamningId = Number(body.inlamningId)
          if (!Number.isFinite(inlamningId) || inlamningId <= 0) {
            return NextResponse.json({ error: 'Saknar inlamningId' }, { status: 400 })
          }

          const result = await agiSparaUnderlag(ctx.supabase, ctx.userId, ctx.companyId, inlamningId)
          if (!result.ok) {
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }

          // Promote the matching declaration to 'exported'. salaryRunId is
          // accepted in the body for the happy path; if missing we can still
          // fall back to the locally-cached submission state, which always
          // carries it (we wrote it in /agi/submit).
          let runId = body.salaryRunId
          if (!runId) {
            // Last-resort lookup: scan recent agi_submission_* keys for a
            // matching inlamningId. Cheap because there's at most one active
            // submission per period and the operator typically has very few.
            const { data: rows } = await ctx.supabase
              .from('extension_data')
              .select('value')
              .eq('company_id', ctx.companyId)
              .eq('extension_id', 'skatteverket')
              .like('key', 'agi_submission_%')
            for (const row of rows ?? []) {
              try {
                const v = JSON.parse(row.value as string) as { inlamningId?: number; salaryRunId?: string }
                if (v.inlamningId === inlamningId && v.salaryRunId) {
                  runId = v.salaryRunId
                  break
                }
              } catch { /* skip malformed */ }
            }
          }
          if (runId) {
            // Monotonicity guard: only flip from a pre-filing state. If the
            // kvittens cron or the interactive /agi/kvittenser handler has
            // already promoted this row to 'submitted'/'accepted', don't
            // regress it: behandlingshistorik must move forward through
            // the filing milestones (BFNAR 2013:2 kap 8).
            //
            // 'rejected' IS allowed as an originating state: a previous
            // submission failed kontrollresultat, the user fixed the XML
            // and re-submitted. The same agi_declarations row is reused
            // (xml-route updates xml_content in place), so this update
            // promotes the recovered submission back to pending_signature.
            //
            // 'exported' is NOT in the allowed-from list. The status value
            // is preserved in the schema for the legacy manual-download
            // path (see migration), but no code currently writes it; an
            // 'exported' row encountered here would represent a parallel
            // filing attempt that should land in its own row, not reuse
            // this one (preserves chain of custody per BFL 5 kap 6§).
            await ctx.supabase
              .from('agi_declarations')
              .update({ status: 'pending_signature' })
              .eq('salary_run_id', runId)
              .eq('company_id', ctx.companyId)
              .in('status', ['generated', 'rejected'])
          }

          return NextResponse.json({ data: result.data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Avbryt underlag (before spara) ─────────────────────────
    // Query: ?inlamningId=...&period=YYYYMM (period optional but recommended)
    //
    // The `period` param lets the handler clear the locally-cached
    // `agi_submission_{period}` record so the UI doesn't sit on a stale
    // `underlag_submitted` state. If the caller doesn't pass it we fall
    // back to scanning recent submission keys for the matching inlamningId.
    {
      method: 'DELETE',
      path: '/agi/underlag',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        try {
          const url = new URL(request.url)
          const inlamningId = Number(url.searchParams.get('inlamningId'))
          const period = url.searchParams.get('period')
          if (!Number.isFinite(inlamningId) || inlamningId <= 0) {
            return NextResponse.json({ error: 'Saknar parameter: inlamningId' }, { status: 400 })
          }
          const result = await agiAvbrytUnderlag(ctx.supabase, ctx.userId, ctx.companyId, inlamningId)
          if (!result.ok) {
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }

          // Clear locally-cached submission state so the UI doesn't keep
          // showing `underlag_submitted` for an inlamning that no longer
          // exists at SKV. Direct path: caller passed period.
          if (period) {
            await ctx.settings.clear(`agi_submission_${period}`)
          } else {
            // Fallback: find the period by matching inlamningId across
            // recent submission keys. Cheap because there's at most one
            // active submission per period.
            const { data: rows } = await ctx.supabase
              .from('extension_data')
              .select('key, value')
              .eq('company_id', ctx.companyId)
              .eq('extension_id', 'skatteverket')
              .like('key', 'agi_submission_%')
            for (const row of rows ?? []) {
              try {
                const v = JSON.parse(row.value as string) as { inlamningId?: number }
                if (v.inlamningId === inlamningId) {
                  await ctx.supabase
                    .from('extension_data')
                    .delete()
                    .eq('company_id', ctx.companyId)
                    .eq('extension_id', 'skatteverket')
                    .eq('key', row.key as string)
                  break
                }
              } catch { /* skip malformed */ }
            }
          }

          return NextResponse.json({ success: true })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Ta bort sparad inlämning (after spara) ─────────────────
    // Query: ?arbetsgivare=...&period=YYYYMM&inlamningId=...
    {
      method: 'DELETE',
      path: '/agi/sparad',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        try {
          const url = new URL(request.url)
          const arbetsgivare = url.searchParams.get('arbetsgivare')
          const period = url.searchParams.get('period')
          const inlamningId = Number(url.searchParams.get('inlamningId'))
          if (!arbetsgivare || !period || !Number.isFinite(inlamningId) || inlamningId <= 0) {
            return NextResponse.json(
              { error: 'Saknar parametrar: arbetsgivare, period, inlamningId' },
              { status: 400 },
            )
          }
          const result = await agiTaBortSparadInlamning(
            ctx.supabase, ctx.userId, ctx.companyId, arbetsgivare, period, inlamningId,
          )
          if (!result.ok) {
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }
          await ctx.settings.clear(`agi_submission_${period}`)
          return NextResponse.json({ success: true })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Skapa granskningsunderlag (BankID signing link) ────────
    // Query: ?arbetsgivare=...&period=YYYYMM&lasPeriod=true|false
    // Returns { link, tillstand, meddelande }. The user opens `link` in a
    // new tab and signs with BankID on Skatteverket's site.
    {
      method: 'POST',
      path: '/agi/granskningsunderlag',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        try {
          const url = new URL(request.url)
          const arbetsgivare = url.searchParams.get('arbetsgivare')
          const period = url.searchParams.get('period')
          const lasPeriod = url.searchParams.get('lasPeriod') !== 'false'  // default true

          if (!arbetsgivare || !period) {
            return NextResponse.json(
              { error: 'Saknar parametrar: arbetsgivare, period' },
              { status: 400 },
            )
          }

          const result = await agiSkapaGranskningsunderlag(
            ctx.supabase, ctx.userId, ctx.companyId, arbetsgivare, period, { lasPeriod },
          )
          if (!result.ok) {
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }

          // Persist the link so the user can return to it after a refresh.
          // SKV's tillstand enum (per skapagranskningsunderlagsvar.json):
          //   LOCKED_FOR_SIGNING / UNLOCKED → granskning ready, user can sign
          //   INCORRECT_DATA               → felrapport link, can't sign yet
          //   RECEIVING / CALCULATING      → server still processing
          //   SIGNING                      → another signing flow already running
          // We key on tillstand alone: keying on HTTP status (e.g. 409) and
          // the body string would miss future SKV additions like RECEIVING
          // returned with HTTP 200, leaving us in an awaiting_signing state
          // when the underlag isn't actually ready.
          const canSign =
            result.data.tillstand === 'LOCKED_FOR_SIGNING' ||
            result.data.tillstand === 'UNLOCKED'
          await ctx.settings.set(
            `agi_submission_${period}`,
            JSON.stringify({
              status: canSign ? 'awaiting_signing' : 'underlag_rejected',
              arbetsgivare,
              period,
              signeringslank: result.data.link,
              tillstand: result.data.tillstand,
              meddelande: result.data.meddelande,
              updatedAt: new Date().toISOString(),
            }),
          )

          // Flip the matching agi_declarations row to pending_signature when
          // SKV returns a usable granskningsunderlag. Previously this happened
          // in /agi/spara, but /spara is only valid for re-saving rejected
          // underlag: successful underlag are auto-persisted by SKV, so
          // /spara returns felkod 20 on the happy path. Doing the flip here
          // ensures the audit trail still moves through pending_signature
          // → submitted (BFNAR 2013:2 kap 8 / BFL 5 kap 6§) without /spara.
          if (canSign) {
            const periodYear = parseInt(period.slice(0, 4))
            const periodMonth = parseInt(period.slice(4, 6))
            await ctx.supabase
              .from('agi_declarations')
              .update({ status: 'pending_signature' })
              .eq('company_id', ctx.companyId)
              .eq('period_year', periodYear)
              .eq('period_month', periodMonth)
              .in('status', ['generated', 'rejected'])
          }

          return NextResponse.json({ data: result.data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Hämta kvittenser (after user signs) ────────────────────
    // Query: ?arbetsgivare=...&period=YYYYMM
    // Returns the kvittenser array. While the user has not yet signed the
    // array is empty; after signing it carries uuidKvittens/signeradAv/-Tid.
    {
      method: 'GET',
      path: '/agi/kvittenser',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        try {
          const url = new URL(request.url)
          const arbetsgivare = url.searchParams.get('arbetsgivare')
          const period = url.searchParams.get('period')
          if (!arbetsgivare || !period) {
            return NextResponse.json(
              { error: 'Saknar parametrar: arbetsgivare, period' },
              { status: 400 },
            )
          }

          const result = await agiGetKvittenser(
            { mode: 'user', supabase: ctx.supabase, userId: ctx.userId, companyId: ctx.companyId },
            arbetsgivare,
            period
          )
          if (!result.ok) {
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }

          // Newest kvittens for the period drives the local state.
          const kvittens = result.data.kvittenser?.[0]
          if (kvittens?.uuidKvittens) {
            const periodYear = parseInt(period.slice(0, 4))
            const periodMonth = parseInt(period.slice(4, 6))
            await ctx.settings.set(
              `agi_submission_${period}`,
              JSON.stringify({
                status: 'signed',
                arbetsgivare,
                period,
                kvittensnummer: kvittens.uuidKvittens,
                signeradAv: kvittens.signeradAv,
                signeradTid: kvittens.signeradTid,
                updatedAt: new Date().toISOString(),
              }),
            )

            // Pin the receipt to the most recent declaration for this period
            // (id desc) so a correction chain doesn't get its kvittens written
            // onto a superseded row. Also stamp salary_runs.agi_submitted_at
            // here, mirroring SKV's signeradTid: this is the only place we
            // know the AGI was actually filed (the orchestrator deliberately
            // doesn't stamp on underlag-ingest, see route.ts comment).
            //
            // The presence of `uuidKvittens` confirms SKV signed and accepted
            // the AGI. signeradTid is the precise signing moment; if SKV
            // omits it we fall back to reconciliation time + warn so the
            // discrepancy is investigable. Leaving NULL would hide that the
            // filing occurred at all, which itself misstates the behandlings-
            // historik (BFNAR 2013:2 kap 8 / BFL 5 kap 6§). The fallback
            // applies only on this code path because we're inside the
            // `if (kvittens?.uuidKvittens)` branch: if no kvittens, no stamp.
            const submittedAt = kvittens.signeradTid || new Date().toISOString()
            if (!kvittens.signeradTid) {
              console.warn('[skatteverket] kvittens missing signeradTid; using reconciliation time', {
                companyId: ctx.companyId, period, uuidKvittens: kvittens.uuidKvittens,
              })
            }
            const { data: latest } = await ctx.supabase
              .from('agi_declarations')
              .select('id, salary_run_id')
              .eq('company_id', ctx.companyId)
              .eq('period_year', periodYear)
              .eq('period_month', periodMonth)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()
            if (latest?.id) {
              // submitted_by is the auth.users UUID we have on hand (the
              // operator who polled the kvittens endpoint). The actual
              // BankID signer is identified by kvittens.signeradAv (a
              // personnummer string), which we preserve in response_data
              // alongside the rest of the receipt: that's the legally
              // load-bearing audit record per BFL 5 kap 6§.
              await ctx.supabase
                .from('agi_declarations')
                .update({
                  status: 'submitted',
                  kvittensnummer: kvittens.uuidKvittens,
                  submitted_at: submittedAt,
                  submitted_by: ctx.userId,
                  response_data: {
                    signeradAv: kvittens.signeradAv ?? null,
                    signeradTid: kvittens.signeradTid ?? null,
                    uuidKvittens: kvittens.uuidKvittens,
                    arbetsgivare: kvittens.arbetsgivare ?? null,
                    period: kvittens.period ?? null,
                    underlag: kvittens.underlag ?? null,
                  },
                })
                .eq('id', latest.id)

              if (latest.salary_run_id) {
                await ctx.supabase
                  .from('salary_runs')
                  .update({ agi_submitted_at: submittedAt })
                  .eq('id', latest.salary_run_id)
                  .eq('company_id', ctx.companyId)
              }
            }
          }

          return NextResponse.json({ data: result.data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Pre-flight kontrollera HU/IU ───────────────────────────
    // Validate a single HU or IU as JSON without saving anything in
    // Skatteverket. Lets the UI catch errors per HU/IU before the user
    // submits a full XML underlag. Body: the HU or IU as JSON per the
    // v1.7 spec §7 / §8 (property names like agRegistreradId,
    // redovisningsPeriod, kontantErsattningUlagAG, …).
    //
    // Response shape (kontrollsvar):
    //   { status: 'OK' | 'INFO' | 'ARENDE' | 'STOPP' | 'AVVISANDE',
    //     fel: [{ status, felmeddelande }, …] }
    {
      method: 'POST',
      path: '/agi/kontrollera/hu',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const rbac = await requireAgiWriteRole(ctx)
        if (rbac) return rbac

        // Read body as bytes first so we can enforce a hard size cap before
        // JSON.parse: protects against ~MB payloads that would otherwise
        // hit the Zod validator.
        const rawBytes = Buffer.byteLength(await request.clone().text(), 'utf8')
        if (rawBytes > AGI_KONTROLLERA_MAX_BYTES) {
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.hu',
            outcome: 'validation_error',
            responseStatus: 413,
            requestSizeBytes: rawBytes,
            errorMessage: 'payload exceeds 64KB cap',
          })
          return NextResponse.json(
            { error: 'Payload överstiger maxstorleken för pre-flight kontroll (64 KB).' },
            { status: 413 },
          )
        }

        let parsedBody: unknown
        try {
          parsedBody = await request.json()
        } catch {
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.hu',
            outcome: 'validation_error',
            responseStatus: 400,
            requestSizeBytes: rawBytes,
            errorMessage: 'invalid JSON',
          })
          return NextResponse.json({ error: 'Ogiltig JSON i förfrågan.' }, { status: 400 })
        }

        const parsed = AGIKontrolleraHUSchema.safeParse(parsedBody)
        if (!parsed.success) {
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.hu',
            outcome: 'validation_error',
            responseStatus: 400,
            requestSizeBytes: rawBytes,
            errorMessage: parsed.error.issues
              .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
              .join('; ')
              .slice(0, 1000),
          })
          return NextResponse.json(
            {
              error: 'HU-payload matchar inte Skatteverkets v1.7 §7-schema.',
              type: 'validation_error',
              errors: parsed.error.issues.map((iss) => ({
                field: iss.path.join('.'),
                message: iss.message,
                code: iss.code,
              })),
            },
            { status: 400 },
          )
        }

        try {
          const result = await agiKontrolleraHU(ctx.supabase, ctx.userId, ctx.companyId, parsed.data)
          if (!result.ok) {
            await writeSkatteverketAudit(ctx, {
              endpoint: 'agi.kontrollera.hu',
              agRegistreradId: parsed.data.agRegistreradId,
              redovisningsperiod: parsed.data.redovisningsPeriod,
              outcome: result.status === 401 || result.status === 403 ? 'auth_error' : 'skv_error',
              responseStatus: result.status,
              requestSizeBytes: rawBytes,
              errorMessage: result.error,
            })
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.hu',
            agRegistreradId: parsed.data.agRegistreradId,
            redovisningsperiod: parsed.data.redovisningsPeriod,
            outcome: 'ok',
            responseStatus: result.status,
            skvStatus: result.data?.status ?? null,
            requestSizeBytes: rawBytes,
          })
          return NextResponse.json({ data: result.data })
        } catch (err) {
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.hu',
            agRegistreradId: parsed.data.agRegistreradId,
            redovisningsperiod: parsed.data.redovisningsPeriod,
            outcome: 'internal_error',
            requestSizeBytes: rawBytes,
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          return handleSkvError(err)
        }
      },
    },

    {
      method: 'POST',
      path: '/agi/kontrollera/iu',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const rbac = await requireAgiWriteRole(ctx)
        if (rbac) return rbac

        const rawBytes = Buffer.byteLength(await request.clone().text(), 'utf8')
        if (rawBytes > AGI_KONTROLLERA_MAX_BYTES) {
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.iu',
            outcome: 'validation_error',
            responseStatus: 413,
            requestSizeBytes: rawBytes,
            errorMessage: 'payload exceeds 64KB cap',
          })
          return NextResponse.json(
            { error: 'Payload överstiger maxstorleken för pre-flight kontroll (64 KB).' },
            { status: 413 },
          )
        }

        let parsedBody: unknown
        try {
          parsedBody = await request.json()
        } catch {
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.iu',
            outcome: 'validation_error',
            responseStatus: 400,
            requestSizeBytes: rawBytes,
            errorMessage: 'invalid JSON',
          })
          return NextResponse.json({ error: 'Ogiltig JSON i förfrågan.' }, { status: 400 })
        }

        const parsed = AGIKontrolleraIUSchema.safeParse(parsedBody)
        if (!parsed.success) {
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.iu',
            outcome: 'validation_error',
            responseStatus: 400,
            requestSizeBytes: rawBytes,
            errorMessage: parsed.error.issues
              .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
              .join('; ')
              .slice(0, 1000),
          })
          return NextResponse.json(
            {
              error: 'IU-payload matchar inte Skatteverkets v1.7 §8-schema.',
              type: 'validation_error',
              errors: parsed.error.issues.map((iss) => ({
                field: iss.path.join('.'),
                message: iss.message,
                code: iss.code,
              })),
            },
            { status: 400 },
          )
        }

        try {
          const result = await agiKontrolleraIU(ctx.supabase, ctx.userId, ctx.companyId, parsed.data)
          if (!result.ok) {
            await writeSkatteverketAudit(ctx, {
              endpoint: 'agi.kontrollera.iu',
              agRegistreradId: parsed.data.agRegistreradId,
              redovisningsperiod: parsed.data.redovisningsPeriod,
              outcome: result.status === 401 || result.status === 403 ? 'auth_error' : 'skv_error',
              responseStatus: result.status,
              requestSizeBytes: rawBytes,
              errorMessage: result.error,
            })
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.iu',
            agRegistreradId: parsed.data.agRegistreradId,
            redovisningsperiod: parsed.data.redovisningsPeriod,
            outcome: 'ok',
            responseStatus: result.status,
            skvStatus: result.data?.status ?? null,
            requestSizeBytes: rawBytes,
          })
          return NextResponse.json({ data: result.data })
        } catch (err) {
          await writeSkatteverketAudit(ctx, {
            endpoint: 'agi.kontrollera.iu',
            agRegistreradId: parsed.data.agRegistreradId,
            redovisningsperiod: parsed.data.redovisningsPeriod,
            outcome: 'internal_error',
            requestSizeBytes: rawBytes,
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Lås period ─────────────────────────────────────────────
    // Hantera-API; typically not needed (skapaGranskningsunderlag already
    // accepts lasPeriod=true). Exposed for recovery / manual control.
    {
      method: 'POST',
      path: '/agi/las',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        try {
          const url = new URL(request.url)
          const arbetsgivare = url.searchParams.get('arbetsgivare')
          const period = url.searchParams.get('period')
          if (!arbetsgivare || !period) {
            return NextResponse.json(
              { error: 'Saknar parametrar: arbetsgivare, period' },
              { status: 400 },
            )
          }
          const result = await agiLasPeriod(ctx.supabase, ctx.userId, ctx.companyId, arbetsgivare, period)
          if (!result.ok) {
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }
          return NextResponse.json({ data: result.data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Lås upp period ─────────────────────────────────────────
    {
      method: 'POST',
      path: '/agi/lasUpp',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        try {
          const url = new URL(request.url)
          const arbetsgivare = url.searchParams.get('arbetsgivare')
          const period = url.searchParams.get('period')
          if (!arbetsgivare || !period) {
            return NextResponse.json(
              { error: 'Saknar parametrar: arbetsgivare, period' },
              { status: 400 },
            )
          }
          const result = await agiLasUppPeriod(ctx.supabase, ctx.userId, ctx.companyId, arbetsgivare, period)
          if (!result.ok) {
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }
          // Unlocking abandons the granskningsunderlag, so the locally-cached
          // `awaiting_signing` record no longer reflects SKV: the signing link
          // it carries points at a released draft. Clear it (mirroring the
          // DELETE /agi/underlag and /agi/sparad handlers) so the panel drops
          // back to the pre-submission state instead of stranding the user on a
          // stale "redo att signeras" box.
          await ctx.settings.clear(`agi_submission_${period}`)
          return NextResponse.json({ data: result.data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Local submission tracking (UI helper) ──────────────────
    // Returns the locally-cached submission state (inlamningId, signing link,
    // kvittensnummer if seen). When the kvittens reconciliation (cron or
    // post-connect refresh) has already promoted the declaration it deletes
    // that cache, so the receipt is served from agi_declarations instead:
    // kvittensnummer, signeradAv and signeradTid must be visible regardless
    // of which path fetched them (#1597). Pure read; never calls Skatteverket.
    {
      method: 'GET',
      path: '/agi/status',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        const url = new URL(request.url)
        const period = url.searchParams.get('period')
        if (!period) return NextResponse.json({ error: 'Saknar parameter: period' }, { status: 400 })

        const statusJson = await ctx.settings.get<string>(`agi_submission_${period}`)
        const data = await readAgiSubmissionStatus(ctx.supabase, ctx.companyId, period, statusJson)
        return NextResponse.json({ data })
      },
    },

    // ══════════════════════════════════════════════════════════════
    // Skattekonto routes (read-only balance + transactions)
    // ══════════════════════════════════════════════════════════════

    // ── Saldo (cached snapshot) ────────────────────────────────────
    // Returns the most recent saldoResponse cached in extension_data.
    // The dashboard uses this for repeated renders without hitting SKV.
    // Force a refresh by calling POST /skattekonto/sync first.
    {
      method: 'GET',
      path: '/skattekonto/saldo',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        // The Skattekonto page keys its "inte anslutet" empty state off a 401
        // NOT_CONNECTED from this route. Without this check, a company that
        // never connected rendered the connected-but-unsynced view because
        // the snapshot read below always answered 200 (with null data), and
        // "Synkronisera nu" then died on a behorighet error at SKV.
        //
        // "Connected" means the COMPANY has a token row (any member's) or a
        // verified system grant, not that the caller personally pressed
        // Anslut: the snapshot and the transactions belong to the company
        // (#1673). A row already flagged needs_reconsent still counts as
        // connected here so the stale snapshot stays visible; the sync route
        // is what surfaces the reconnect prompt.
        const resolved = await resolveCompanyReadAuth(ctx)
        if (!resolved.ok && resolved.reason === 'no_token') {
          return readAuthFailureResponse('no_token')
        }
        const snapshot = await ctx.settings.get<SkattekontoBalanceSnapshot>(SKATTEKONTO_BALANCE_SNAPSHOT_KEY)
        const lastSyncedAt = await ctx.settings.get<string>(SKATTEKONTO_LAST_SYNCED_AT_KEY)
        return NextResponse.json({
          data: snapshot?.saldo ?? null,
          fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
          lastSyncedAt: lastSyncedAt ?? null,
        })
      },
    },

    // ── Transaktioner (from local table) ───────────────────────────
    // Returns booked + upcoming transactions for the active company.
    // Optional `from` query filters tidigare on transaktionsdatum >= from.
    // Ignored rows (is_ignored) are excluded from the work buckets and only
    // reported as `ignored_count`; pass `include_ignored=1` to also get the
    // rows themselves (the "Ignorerade" band). Never silently dropped.
    {
      method: 'GET',
      path: '/skattekonto/transaktioner',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const url = new URL(request.url)
        const from = url.searchParams.get('from')
        const includeIgnoredParam = url.searchParams.get('include_ignored')
        const includeIgnored =
          includeIgnoredParam === '1' || includeIgnoredParam === 'true'

        let query = ctx.supabase
          .from('skattekonto_transactions')
          .select('*')
          .eq('company_id', ctx.companyId)
          .order('transaktionsdatum', { ascending: false })

        if (from) query = query.gte('transaktionsdatum', from)

        const { data, error } = await query
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 })
        }

        const rows = data ?? []
        const today = new Date().toISOString().slice(0, 10)
        const { booked, overdue, upcoming, ignored } = splitTransactions(rows, today)

        // Enrich obokförda rader with a single-best-candidate suggestion.
        // Only attached when there's exactly one match: avoids the UI
        // confidently pointing at the wrong verifikat.
        const suggestions = await findMatchSuggestionsBulk(
          ctx.supabase,
          ctx.companyId,
          booked.map(r => ({
            id: r.id,
            transaktionsdatum: r.transaktionsdatum,
            belopp_skatteverket: Number(r.belopp_skatteverket),
            journal_entry_id: r.journal_entry_id,
          })),
        )

        // Deterministic booking suggestion per unbooked row (one hoisted
        // rules fetch): the UI shows what "Bokför" will do and uses it to
        // decide bulk-booking eligibility.
        const withBookingSuggestions = await attachBookingSuggestions(
          ctx.supabase,
          ctx.companyId,
          booked,
        )

        const bookedEnriched = withBookingSuggestions.map(r => ({
          ...r,
          match_suggestion: suggestions.get(r.id) ?? null,
        }))

        return NextResponse.json({
          data: {
            booked: bookedEnriched,
            overdue,
            upcoming,
            ignored_count: ignored.length,
            ...(includeIgnored ? { ignored } : {}),
          },
        })
      },
    },

    // ── Manual sync ────────────────────────────────────────────────
    // Pulls fresh saldo + transactions from Skatteverket and upserts.
    {
      method: 'POST',
      path: '/skattekonto/sync',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        try {
          // Any member may trigger a sync on the company's connection: the
          // resolved auth carries the token OWNER's userId, so the refresh
          // writes back to their row, never to the caller's (#1673). A row
          // flagged needs_reconsent cannot heal on its own, so answer the
          // reconnect prompt directly instead of burning a refresh call.
          const resolved = await resolveCompanyReadAuth(ctx)
          if (!resolved.ok) return readAuthFailureResponse(resolved.reason)
          const result = await syncSkattekonto(ctx, resolved.auth)
          return NextResponse.json({ data: result })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Bokför several rows → committed verifikat per row ─────────
    // Draft + commit per id, server-side, so a successful row lands as a
    // posted verifikat with no orphan drafts. Row failures never abort the
    // loop: the response carries per-row results plus a summary for one
    // aggregate toast. Also serves the inline single-row flow (ids: [id]).
    {
      method: 'POST',
      path: '/skattekonto/transaktioner/bokfor-batch',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        let parsedBody: unknown
        try {
          parsedBody = await request.json()
        } catch {
          return NextResponse.json({ error: 'Ogiltig JSON i förfrågan.' }, { status: 400 })
        }

        const parsed = SkattekontoBokforBatchSchema.safeParse(parsedBody)
        if (!parsed.success) {
          return NextResponse.json(
            { error: 'Ogiltiga parametrar: ids måste vara en lista med 1-200 transaktions-id.' },
            { status: 400 },
          )
        }

        // Dedupe: a repeated id would just burn an ALREADY_BOOKED failure
        // on its second pass.
        const ids = [...new Set(parsed.data.ids)]

        try {
          const result = await bokforSkattekontoTransactionsBatch(
            ctx.supabase,
            ctx.companyId,
            ctx.userId,
            ids,
          )
          return NextResponse.json({ data: result })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Bokför one row → draft journal entry ──────────────────────
    // Creates a DRAFT verifikat in /bookkeeping for the user to review
    // and commit. The skattekonto_transactions row is linked via
    // journal_entry_id so the UI can show "Bokförd" status.
    {
      method: 'POST',
      path: '/skattekonto/transaktioner/:id/bokfor',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        // Extract :id from the catch-all dispatcher's path-param convention
        // (`_id` query string, set in app/api/extensions/ext/[...path]/route.ts).
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }

        try {
          const entry = await bokforSkattekontoTransaction(
            ctx.supabase,
            ctx.companyId,
            ctx.userId,
            id,
          )
          return NextResponse.json({ data: { entry } })
        } catch (err) {
          if (err instanceof SkattekontoBookingError) {
            const status =
              err.code === 'TRANSACTION_NOT_FOUND' ? 404
              : err.code === 'ALREADY_BOOKED' ? 409
              : err.code === 'ROW_IGNORED' ? 409
              : err.code === 'PERIOD_LOCKED' ? 423
              : err.code === 'NO_COUNTER_ACCOUNT' ? 422
              : 400
            return NextResponse.json(
              { error: err.message, code: err.code },
              { status },
            )
          }
          return handleSkvError(err)
        }
      },
    },

    // ── Matcha mot befintligt verifikat ──────────────────────────────
    // List candidate journal entries already touching 1630 with the right
    // amount/side near the transaction date. Lets the user link the SKV
    // row to a manually-booked bank transfer instead of creating a duplicate
    // verifikat. Returns at most 25 candidates.
    {
      method: 'GET',
      path: '/skattekonto/transaktioner/:id/match-candidates',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }
        try {
          const { candidates } = await findMatchCandidates(ctx.supabase, ctx.companyId, id)
          return NextResponse.json({ data: { candidates } })
        } catch (err) {
          if (err instanceof SkattekontoMatchError) {
            const status =
              err.code === 'TRANSACTION_NOT_FOUND' ? 404
              : err.code === 'ALREADY_BOOKED' ? 409
              : 400
            return NextResponse.json({ error: err.message, code: err.code }, { status })
          }
          return handleSkvError(err)
        }
      },
    },

    // Link the SKV row to a chosen candidate. No new verifikat is created:
    // we just write journal_entry_id onto skattekonto_transactions. The
    // candidate is re-validated server-side (matching 1630 line, not already
    // linked) to catch races and a malicious client.
    {
      method: 'POST',
      path: '/skattekonto/transaktioner/:id/match',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }
        let body: { journal_entry_id?: string }
        try {
          body = (await request.json()) as { journal_entry_id?: string }
        } catch {
          return NextResponse.json({ error: 'Ogiltig request body' }, { status: 400 })
        }
        if (!body.journal_entry_id || typeof body.journal_entry_id !== 'string') {
          return NextResponse.json(
            { error: 'Saknar journal_entry_id' },
            { status: 400 },
          )
        }
        try {
          await matchSkattekontoToEntry(
            ctx.supabase,
            ctx.companyId,
            id,
            body.journal_entry_id,
          )
          return NextResponse.json({ data: { ok: true } })
        } catch (err) {
          if (err instanceof SkattekontoMatchError) {
            const status =
              err.code === 'TRANSACTION_NOT_FOUND' ? 404
              : err.code === 'ENTRY_NOT_FOUND' ? 404
              : err.code === 'ALREADY_BOOKED' ? 409
              : err.code === 'ROW_IGNORED' ? 409
              : err.code === 'ENTRY_ALREADY_LINKED' ? 409
              : 422
            return NextResponse.json({ error: err.message, code: err.code }, { status })
          }
          return handleSkvError(err)
        }
      },
    },

    // ── Ignorera / återställ en rad ───────────────────────────────────
    // Skattekonto rows mirror Skatteverket's ledger and are never deleted;
    // is_ignored is the sanctioned way to take an unbookable row off the
    // work list (e.g. an EF row predating the first räkenskapsår). Fully
    // reversible: PATCH { is_ignored: false } restores it. A booked row
    // cannot be ignored (409; the DB CHECK enforces the same invariant).
    {
      method: 'PATCH',
      path: '/skattekonto/transaktioner/:id/ignore',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }
        let body: { is_ignored?: unknown }
        try {
          body = (await request.json()) as { is_ignored?: unknown }
        } catch {
          return NextResponse.json({ error: 'Ogiltig request body' }, { status: 400 })
        }
        if (typeof body.is_ignored !== 'boolean') {
          return NextResponse.json(
            { error: 'is_ignored måste vara true eller false' },
            { status: 400 },
          )
        }
        const isIgnored = body.is_ignored

        const { data: tx, error: txError } = await ctx.supabase
          .from('skattekonto_transactions')
          .select('id, journal_entry_id, is_ignored')
          .eq('id', id)
          .eq('company_id', ctx.companyId)
          .single()
        if (txError || !tx) {
          return NextResponse.json(
            { error: 'Skattekonto-transaktionen hittades inte.' },
            { status: 404 },
          )
        }
        if (isIgnored && tx.journal_entry_id) {
          return NextResponse.json(
            { error: 'Transaktionen är redan bokförd och kan inte ignoreras.' },
            { status: 409 },
          )
        }

        // Conditional write: `.is('journal_entry_id', null)` on the ignore
        // path makes a concurrent booking race lose cleanly (zero rows
        // updated -> 409) instead of tripping the DB CHECK.
        let update = ctx.supabase
          .from('skattekonto_transactions')
          .update({ is_ignored: isIgnored })
          .eq('id', id)
          .eq('company_id', ctx.companyId)
        if (isIgnored) {
          update = update.is('journal_entry_id', null)
        }
        const { data: updated, error: updateError } = await update.select('id')
        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }
        if (!updated || updated.length === 0) {
          return NextResponse.json(
            { error: 'Transaktionen är redan bokförd och kan inte ignoreras.' },
            { status: 409 },
          )
        }

        return NextResponse.json({ data: { ok: true, is_ignored: isIgnored } })
      },
    },
  ],

  // No email consumers. skattekonto.connection.expired is still emitted
  // (needs_reconsent flagging, UI banner, agent briefing) but a per-episode
  // expiry mail is one mail per connect with SKV's 65-minute sessions, which
  // trains users to ignore it (DECISIONS.md 2026-08-25). The skattekonto
  // drift mail was removed 2026-09-02: the reconciliation page and the Hem
  // notice (lib/notices/categories.ts detectSkvUnexplained) are the surface,
  // and the mail alerted on raw saldo-vs-1630 gaps that unbooked rows explain.
  eventHandlers: [],

  // Registry-resolved commit services for the MCP submit tools. The core
  // pending-operations dispatcher (lib/pending-operations/commit.ts) cannot
  // import this extension (CI guard), so it reaches these through
  // extensionRegistry.get('skatteverket')?.services when committing a staged
  // submit_vat_declaration / submit_agi operation. Commit = "send for BankID
  // signing" (returns a signing link), never "file".
  services: {
    commitSubmitVatDeclaration,
    commitSubmitAgi,
    // Commit side of the staged book_skattekonto_row(s) MCP ops: books
    // already-synced skattekonto rows through the bookkeeping engine.
    commitBookSkattekontoRows,
    // Read service for the v1 REST endpoint (issue #1663): filed
    // momsdeklarationer (inlamnat) and beslut (beslutat). Contract in
    // lib/skatteverket/declaration-status.ts.
    fetchVatDeclarationStatus,
  },
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Parse and validate declaration request body, then compute the momsuppgift.
 *
 * The computation itself lives in lib/declaration-prep.ts (buildMomsuppgift)
 * so the commit-side service and MCP tools file exactly the same numbers this
 * route does: see the no-drift note there. This shell only parses the body.
 */
async function parseDeclarationRequest(
  request: Request,
  ctx: ExtensionContext
): Promise<VatDeclarationPrep> {
  const body = await request.json()
  const { periodType, year, period, fiscalPeriodId } = body as {
    periodType: VatPeriodType
    year: number
    period: number
    fiscalPeriodId?: string
  }

  if (!periodType || !year || !period) {
    throw new Error('Saknar obligatoriska fält: periodType, year, period')
  }

  return buildMomsuppgift(ctx.supabase, ctx.companyId, { periodType, year, period, fiscalPeriodId })
}

/**
 * Parse redovisare and redovisningsperiod from query params.
 * Used by GET/PUT/DELETE endpoints that don't need a full body.
 */
function parseQueryParams(
  request: Request,
  ctx: ExtensionContext
): { redovisare: string; redovisningsperiod: string } {
  const url = new URL(request.url)
  const redovisare = url.searchParams.get('redovisare')
  const redovisningsperiod = url.searchParams.get('redovisningsperiod')

  if (!redovisare || !redovisningsperiod) {
    throw new Error('Saknar obligatoriska parametrar: redovisare, redovisningsperiod')
  }

  // Suppress unused variable warning: ctx is required by the type signature
  void ctx

  return { redovisare, redovisningsperiod }
}

/**
 * Build the deadline generator's tax_period string (`YYYY-MM` monthly,
 * `YYYY-QN` quarterly) from the picker params. Yearly periods use the
 * fiscal-year label and need company settings; see yearlyVatTaxPeriod.
 */
function vatTaxPeriod(periodType: VatPeriodType, year: number, period: number): string | null {
  if (periodType === 'monthly') return `${year}-${String(period).padStart(2, '0')}`
  if (periodType === 'quarterly') return `${year}-Q${period}`
  return null
}

/**
 * The moms_yearly row's tax_period is the generator's fiscal-year label:
 * `YYYY` for calendar fiscal years and `YYYY-1/YYYY` for broken ones (year
 * = the FY-end year). Derived from company settings because the picker only
 * carries the year.
 */
async function yearlyVatTaxPeriod(ctx: ExtensionContext, year: number): Promise<string> {
  const { data } = await ctx.supabase
    .from('company_settings')
    .select('fiscal_year_start_month')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  const startMonth = data?.fiscal_year_start_month ?? 1
  return startMonth === 1 ? `${year}` : `${year - 1}/${year}`
}

/**
 * Complete the moms deadline for the period identified by the request's
 * optional periodType/year/period query params. Both monthly and quarterly
 * types are passed for sub-annual periods: company settings decide which one
 * exists, the other is a no-op. Best-effort by design (completeTaxDeadline
 * never throws).
 */
async function completeVatDeadlineFromRequest(
  request: Request,
  ctx: ExtensionContext,
  newStatus: 'submitted' | 'confirmed'
): Promise<void> {
  const url = new URL(request.url)
  const periodType = url.searchParams.get('periodType') as VatPeriodType | null
  const year = Number(url.searchParams.get('year'))
  const period = Number(url.searchParams.get('period'))
  if (!periodType || !Number.isFinite(year) || !Number.isFinite(period) || !year || !period) {
    return
  }
  const taxPeriod =
    periodType === 'yearly'
      ? await yearlyVatTaxPeriod(ctx, year)
      : vatTaxPeriod(periodType, year, period)
  if (!taxPeriod) return
  await completeTaxDeadline(
    ctx.supabase,
    ctx.companyId,
    periodType === 'yearly' ? ['moms_yearly'] : ['moms_monthly', 'moms_quarterly'],
    taxPeriod,
    newStatus
  )
}

/**
 * Load the AGI XML for a salary run from agi_declarations.xml_content
 * (built by app/api/salary/runs/[id]/agi/xml/route.ts via generateAGIXml).
 *
 * The lookup + status guard live in lib/declaration-prep.ts (buildAgiUnderlag)
 * so the commit-side service files the same XML this route does. This shell
 * only parses the salaryRunId from the body.
 */
async function loadAGIXml(
  request: Request,
  ctx: ExtensionContext,
): Promise<AgiUnderlagPrep> {
  const body = (await request.json()) as { salaryRunId?: string }
  return buildAgiUnderlag(ctx.supabase, ctx.companyId, body.salaryRunId ?? '')
}

/**
 * Convert Skatteverket errors to appropriate HTTP responses.
 */
function handleSkvError(err: unknown): NextResponse {
  if (err instanceof SkatteverketAuthError) {
    // MISSING_SCOPE returns 401: the existing token works, but it doesn't
    // grant access to this resource. Treating it as 401 (rather than 403)
    // signals to the frontend that the right remediation is to reconnect,
    // not to ask the user to gain new authorization at SKV.
    const status = err.code === 'NOT_CONNECTED' ? 401
      : err.code === 'BEHORIGHET_SAKNAS' ? 403
      : err.code === 'SESSION_EXPIRED' || err.code === 'REFRESH_EXHAUSTED' ? 401
      : err.code === 'MISSING_SCOPE' ? 401
      : err.code === 'TOKEN_CORRUPTED' ? 401
      : err.code === 'TOKEN_REVOKED' ? 401
      : 403

    return NextResponse.json(
      { error: err.message, code: err.code },
      { status }
    )
  }

  console.error('[skatteverket] API error:', err)
  return NextResponse.json(
    { error: err instanceof Error ? err.message : 'Okänt fel' },
    { status: 500 }
  )
}

// ── MCP submit commit services ─────────────────────────────────────────
//
// Registry-resolved by lib/pending-operations/commit.ts when a staged
// submit_vat_declaration / submit_agi op is approved. "Commit" runs the SKV
// chain up to the BankID signing link and returns it: the user's signature in
// the browser is the irreversible filing act, outside this code.
//
// Direct lib calls bypass the HTTP dispatcher's SKATTEVERKET_ENABLED gate
// (app/api/extensions/ext/[...path]/route.ts), so each service checks the flag
// itself and returns a recoverable EXTENSION_DISABLED result (the op stays
// reviewable). SkatteverketAuthError (no connection / scope / quota) is
// likewise recoverable. SKV business rejections are non-recoverable → the op
// is consumed and the user regenerates + re-stages.

function skatteverketEnabled(): boolean {
  return process.env.SKATTEVERKET_ENABLED === 'true'
}

const EXTENSION_DISABLED_RESULT: Extract<SkvSubmitResult, { ok: false }> = {
  ok: false,
  code: 'EXTENSION_DISABLED',
  http_status: 503,
  recoverable: true,
  error: 'Skatteverket-integrationen är inte aktiverad i denna miljö.',
}

/**
 * Commit service for the staged book_skattekonto_row / book_skattekonto_rows
 * MCP operations. Registry-resolved by lib/pending-operations/commit.ts on
 * approval. Books already-synced skattekonto_transactions rows as posted
 * verifikat through the SAME batch helper the HTTP bokfor-batch route uses
 * (draft + commit per row via the bookkeeping engine, requireSettled): no
 * SKV API call is involved. Row failures come back as per-row data, never as
 * a thrown error, so a partial batch commits with the failures listed.
 *
 * Gated on SKATTEVERKET_ENABLED for parity with the HTTP surface: the
 * dispatcher blocks the whole extension route family behind that flag, so a
 * direct lib call must not book where the web app could not. Recoverable:
 * the op stays reviewable and a re-approve works once the env is enabled.
 */
async function commitBookSkattekontoRows(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<SkattekontoBookCommitResult> {
  if (!skatteverketEnabled()) return EXTENSION_DISABLED_RESULT

  const raw = params.ids
  const ids = Array.isArray(raw)
    ? [...new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0))]
    : []
  if (ids.length === 0 || ids.length > 200) {
    return {
      ok: false,
      code: 'INVALID_PARAMS',
      http_status: 400,
      recoverable: false,
      error: 'ids måste vara en lista med 1-200 transaktions-id.',
    }
  }

  try {
    const result = await bokforSkattekontoTransactionsBatch(supabase, companyId, userId, ids)
    return { ok: true, ...result }
  } catch (err) {
    // bokforSkattekontoTransactionsBatch catches per-row errors itself; a
    // throw here is a batch-level failure (e.g. rule-context load): internal,
    // non-recoverable, the user re-stages after the underlying issue is fixed.
    log.error('commitBookSkattekontoRows failed', {
      companyId,
      rowCount: ids.length,
      error: err instanceof Error ? err.message : String(err),
    })
    // Fixed public message: the raw exception stays in the server log above
    // and must not flow back to API callers (it can carry DB/row details).
    return {
      ok: false,
      code: 'SKATTEKONTO_BOOKING_FAILED',
      http_status: 500,
      recoverable: false,
      error: 'Skattekonto-raderna kunde inte bokföras. Försök igen eller kontakta support.',
    }
  }
}

/**
 * Translate a thrown error inside a commit service to a SkvSubmitResult.
 * SkatteverketAuthError (connection / scope / quota) is recoverable: the op
 * stays reviewable so the user reconnects and re-approves. Anything else is a
 * non-recoverable internal error → the op is rejected.
 */
async function mapServiceError(
  ctx: ExtensionContext,
  endpoint: string,
  err: unknown,
): Promise<Extract<SkvSubmitResult, { ok: false }>> {
  if (err instanceof SkatteverketAuthError) {
    const mapped = skvAuthCodeToStructured(err.code)
    await writeSkatteverketAudit(ctx, { endpoint, outcome: 'auth_error', errorMessage: err.message })
    return { ok: false, code: mapped.code, http_status: mapped.httpStatus, recoverable: true, error: err.message }
  }
  await writeSkatteverketAudit(ctx, {
    endpoint,
    outcome: 'internal_error',
    errorMessage: err instanceof Error ? err.message : String(err),
  })
  return {
    ok: false,
    code: 'SKATTEVERKET_INTERNAL_ERROR',
    http_status: 500,
    recoverable: false,
    error: err instanceof Error ? err.message : 'Okänt fel',
  }
}

/**
 * VAT "skicka för signering": POST /utkast + PUT /las → signeringslänk.
 * Recompute-at-commit (buildMomsuppgift over posted entries) so the figures
 * filed equal what the preview showed for the same ledger state.
 */
async function commitSubmitVatDeclaration(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<SkvSubmitResult> {
  if (!skatteverketEnabled()) return EXTENSION_DISABLED_RESULT

  const periodType = params.period_type as VatPeriodType
  const year = params.year as number
  const period = params.period as number
  const fiscalPeriodId = params.fiscal_period_id as string | undefined
  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')

  try {
    // The staged figures were already reviewed at approval time, so the
    // chain starts at the utkast write (no kontrollera pre-step here).
    const result = await submitVatDeclarationChain(ctx, { periodType, year, period, fiscalPeriodId })
    if (!result.ok) {
      return {
        ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: result.httpStatus,
        recoverable: false, error: result.error,
      }
    }
    return {
      ok: true,
      signing_url: result.signingUrl,
      redovisningsperiod: result.redovisningsperiod,
      redovisare: result.redovisare,
      kontrollresultat: result.kontrollresultat,
    }
  } catch (err) {
    return mapServiceError(ctx, 'declaration/submit', err)
  }
}

/**
 * AGI "skicka för signering": POST /underlag → poll kontrollresultat →
 * skapaGranskningsunderlag(lasPeriod) → Mina Sidor signing link. Mirrors the
 * route handlers' status flips (monotonic guards) and audit rows.
 */
async function commitSubmitAgi(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<SkvSubmitResult> {
  if (!skatteverketEnabled()) return EXTENSION_DISABLED_RESULT

  const salaryRunId = params.salary_run_id as string
  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')

  try {
    const { arbetsgivare, period, xml, periodYear, periodMonth } =
      await buildAgiUnderlag(supabase, companyId, salaryRunId)

    // 1. POST /underlag (XML) → inlamningId.
    const submit = await agiPostUnderlag(supabase, userId, companyId, xml)
    await writeSkatteverketAudit(ctx, {
      endpoint: 'agi/submit', agRegistreradId: arbetsgivare, redovisningsperiod: period,
      outcome: submit.ok ? 'ok' : 'skv_error', responseStatus: submit.status,
      errorMessage: submit.ok ? null : submit.error,
    })
    if (!submit.ok) {
      return { ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: submit.status,
        recoverable: false, error: submit.error }
    }
    const inlamningId = submit.data.inlamningId
    await ctx.settings.set(`agi_submission_${period}`, JSON.stringify({
      status: 'underlag_submitted', arbetsgivare, period, salaryRunId,
      inlamningId, updatedAt: new Date().toISOString(),
    }))

    // 2. Poll kontrollresultat (bounded; SKV is typically sub-second).
    let kontroll = await agiGetKontrollresultat(supabase, userId, companyId, inlamningId)
    for (let i = 0; i < 2 && kontroll.ok && kontroll.data.status === 'PROCESSING'; i++) {
      await sleep(750)
      kontroll = await agiGetKontrollresultat(supabase, userId, companyId, inlamningId)
    }
    await writeSkatteverketAudit(ctx, {
      endpoint: 'agi/kontrollresultat', agRegistreradId: arbetsgivare, redovisningsperiod: period,
      outcome: kontroll.ok ? 'ok' : 'skv_error', responseStatus: kontroll.status,
      skvStatus: kontroll.ok ? kontroll.data.status : null,
    })
    if (!kontroll.ok) {
      return { ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: kontroll.status,
        recoverable: false, error: kontroll.error }
    }
    if (kontroll.data.status === 'PROCESSING') {
      // Still processing after the bounded poll: recoverable; re-approve shortly.
      return { ok: false, code: 'SKATTEVERKET_PROCESSING', http_status: 202, recoverable: true,
        error: 'Skatteverket bearbetar fortfarande AGI-underlaget. Försök igen om en stund.' }
    }
    if (kontroll.data.status === 'DONE_REJECTED' || kontroll.data.status === 'DONE_FAILED') {
      // Scope by salary_run_id, not just period: a correction run sharing the
      // period must not have its (still-valid) declaration flipped to rejected.
      await supabase.from('agi_declarations').update({ status: 'rejected' })
        .eq('company_id', companyId).eq('salary_run_id', salaryRunId)
        .eq('period_year', periodYear).eq('period_month', periodMonth)
        .in('status', ['generated', 'pending_signature', 'exported'])
      return { ok: false, code: 'AGI_KONTROLL_REJECTED', http_status: 422, recoverable: false,
        error: 'Skatteverket avvisade AGI-underlaget vid kontroll. Åtgärda felen och generera om AGI:n.' }
    }

    // 3. skapaGranskningsunderlag (lasPeriod=true) → Mina Sidor signing link.
    const gransk = await agiSkapaGranskningsunderlag(supabase, userId, companyId, arbetsgivare, period, { lasPeriod: true })
    await writeSkatteverketAudit(ctx, {
      endpoint: 'agi/granskningsunderlag', agRegistreradId: arbetsgivare, redovisningsperiod: period,
      outcome: gransk.ok ? 'ok' : 'skv_error', responseStatus: gransk.status,
      skvStatus: gransk.ok ? gransk.data.tillstand : null,
    })
    if (!gransk.ok) {
      return { ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: gransk.status,
        recoverable: false, error: gransk.error }
    }
    const tillstand = gransk.data.tillstand
    const canSign = tillstand === 'LOCKED_FOR_SIGNING' || tillstand === 'UNLOCKED'

    await ctx.settings.set(`agi_submission_${period}`, JSON.stringify({
      status: canSign ? 'awaiting_signing' : 'underlag_rejected', arbetsgivare, period,
      signeringslank: gransk.data.link, tillstand, meddelande: gransk.data.meddelande,
      updatedAt: new Date().toISOString(),
    }))

    if (tillstand === 'INCORRECT_DATA') {
      return { ok: false, code: 'AGI_GRANSKNING_INCORRECT', http_status: 422, recoverable: false,
        error: gransk.data.meddelande || 'Skatteverket avvisade granskningsunderlaget. Åtgärda felen och generera om AGI:n.' }
    }
    if (!canSign) {
      // RECEIVING / CALCULATING etc.: still processing, recoverable.
      return { ok: false, code: 'SKATTEVERKET_PROCESSING', http_status: 202, recoverable: true,
        error: gransk.data.meddelande || 'Skatteverket bearbetar fortfarande underlaget. Försök igen om en stund.' }
    }

    // Flip the declaration to pending_signature (monotonic guard). Scoped by
    // salary_run_id so a correction run in the same period isn't co-flipped:
    // more precise than the period-only route handler, which has no run id.
    await supabase.from('agi_declarations').update({ status: 'pending_signature' })
      .eq('company_id', companyId).eq('salary_run_id', salaryRunId)
      .eq('period_year', periodYear).eq('period_month', periodMonth)
      .in('status', ['generated', 'rejected'])

    return {
      ok: true,
      signing_url: gransk.data.link,
      arbetsgivare,
      period,
      inlamning_id: inlamningId,
      tillstand,
    }
  } catch (err) {
    return mapServiceError(ctx, 'agi/submit', err)
  }
}
