import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { StoredSkattekontoTransaction } from '@/types/skatteverket'
import { z } from 'zod'
import { requestCspNonce } from '@/lib/security/csp'
import { parseEntityType } from '@/lib/company/entity-type'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse, after } from 'next/server'
import { TimeoutError } from '@/lib/http/fetch-with-timeout'
import { capabilityBlockedResponse, requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { buildAuthorizeUrl, exchangeCodeForTokens, generatePkcePair } from './lib/oauth'
import { skatteverketConnectorMode, startConnectorAuthorization } from './lib/connector-mode'
import { isConnectorState, verifyConnectorState } from '@/lib/connect/hosted/state'
import {
  requireFlowInitiator,
  FLOW_INITIATOR_MISMATCH_MESSAGE,
} from '@/lib/auth/oauth-flow-binding'
import {
  consumeOAuthFlowHandoff,
  consumeOAuthFlowState,
  createOAuthFlow,
  mintOAuthFlowHandoff,
  newOAuthFlowId,
  peekOAuthFlowHandoff,
  peekOAuthFlowState,
  purgeExpiredOAuthFlows,
  requestMatchesOrigin,
  resolveOAuthOrigin,
  type OAuthFlow,
} from '@/lib/auth/oauth-flows'
import { storeTokens, getTokens, deleteTokens, getTokenHealth } from './lib/token-store'
import { skvRequest, SkatteverketAuthError, getSkatteverketEnvironment, isApigwClientRefusal } from './lib/api-client'
import { skvAuthCodeToStructured } from './lib/error-map'
import {
  buildMomsuppgift,
  type VatDeclarationPrep,
} from './lib/declaration-prep'
import { submitVatDeclarationChain, vatDeclarationIncompleteFailure } from './lib/vat-submit'
import { vatFilingVerdict } from '@/lib/reports/vat-close-check'
import {
  agiRunTarget,
  createAgiSigningLink,
  submitAgiChain,
  submitAgiUnderlag,
  type AgiStepFailure,
} from './lib/agi-submit'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'
import {
  VAT_FILING_DEADLINE_TYPES,
  vatFilingFiscalYearEndMonth,
  vatFilingTaxPeriod,
} from '@/lib/vat/filing-record'
import { getSystemAuthMode, isSystemAuthConfigured, getOmbudOrgNumber, getSystemCertInfo } from './lib/system-auth/config'
import {
  getConnection,
  isOrgNumberContested,
  markConnectionRevoked,
  recordProbeResult,
} from './lib/connection-store'
import { currentSkvEnvironment, hasOmbudReadAccess, isSystemReadActive, resolveReadAuth } from './lib/resolve-auth'
import { probeCompanyGrants } from './lib/grant-probe'
import { formatRedovisare } from '@/lib/skatteverket/format'
import { isSkvSessionRefreshable } from '@/lib/skatteverket/session-lifetime'
import { resolveSkattekontoAccount, type SkattekontoLedgerAccount } from '@/lib/skatteverket/skattekonto-account'
import { createUtseOmbudDeepLink, OMBUD_ROLE_KEYS, OmbudApiError } from './lib/ombud-client'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import type {
  SkvSubmitResult,
  SkattekontoBookCommitResult,
} from '@/lib/pending-operations/skatteverket-commit'
import {
  agiGetKvittenser,
  agiLasUppPeriod,
} from './lib/agi-client'
import {
  previewSkattekontoSync,
  runSkattekontoSync,
  syncSkattekontoNow,
  validateAgiUppgift,
} from './lib/core-actions'
import type { SkvActionFailure } from '@/lib/skatteverket/extension-actions'
import {
  SKATTEKONTO_BALANCE_SNAPSHOT_KEY,
  SKATTEKONTO_LAST_SYNCED_AT_KEY,
  SKATTEKONTO_UNAVAILABLE_KEY,
  type SkattekontoUnavailableState,
} from './lib/skattekonto-sync'
import { fetchDeclarationView, fetchVatDeclarationStatus } from './lib/declaration-status'
import { runPostConnectRefresh } from './lib/post-connect-refresh'
import { declarationKvittens, newestAgiKvittens, promoteAgiDeclaration } from './lib/agi-kvittens-reconcile'
import { recordAgiKvittenser } from './lib/agi-kvittens-history'
import { readAgiSubmissionStatus } from './lib/agi-submission-status'
import {
  attachBookingSuggestions,
  bokforSkattekontoTransaction,
  bokforSkattekontoTransactionsBatch,
  DUPLICATE_REASON_MAX_LENGTH,
  findSkattekontoLedgerHolding,
  ledgerHoldOfRows,
  normaliseDuplicateReason,
  SkattekontoBookingError,
} from './lib/skattekonto-booking'
import {
  findGroupMatchCandidates,
  findMatchCandidates,
  findMatchSuggestionsBulk,
  matchSkattekontoToEntry,
  SkattekontoMatchError,
} from './lib/skattekonto-match'
import { splitTransactions } from './lib/skattekonto-buckets'
import type { SkattekontoBalanceSnapshot } from './types'
import type { VatPeriodType } from '@/types'
import type { SkattekontoLedgerCoverInfo } from '@/types/skatteverket'
import { createLogger } from '@/lib/logger'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { setSkattekontoRowIgnored, SkattekontoLinkError } from '@/lib/skatteverket/skattekonto-link'
import { isSkatteverketEnabled } from '@/lib/skatteverket/enabled'

const log = createLogger('skatteverket')

// Every state or handoff failure on the unauthenticated callback gets this
// one message: unknown, forged, expired, replayed, wrong origin. Telling the
// caller which one would make the route an oracle for live flows.
const SKV_STATE_REJECTED_MESSAGE =
  'Anslutningen kunde inte verifieras (ogiltig eller förbrukad state). Stäng fliken och försök ansluta igen.'

// Answered only when the session vanished between the identity check and
// the consume (a race, not the normal path: a session-less arrival is sent
// to login BEFORE the flow is spent and resumes from there).
const SKV_SESSION_MISSING_MESSAGE =
  'Sessionen har gått ut. Stäng fliken, logga in och försök ansluta igen.'

/**
 * For a candidates answer with nothing to offer: the unlinked verifikat on
 * 1630 that already hold every given row (a summarised verifikat, crm#1043,
 * or the one verifikat the ledger plan assigns them to, PH 171), by the same
 * check the booking guard runs (ledgerHoldOf), so the dialogs point at the
 * link instead of telling the user to book the rows. Null when not all rows
 * are held, and when the bridge cannot be read: this only informs, the
 * booking guard itself fails closed.
 */
async function coverForRows(
  supabase: SupabaseClient,
  companyId: string,
  ids: string[],
): Promise<SkattekontoLedgerCoverInfo | null> {
  try {
    return ledgerHoldOfRows(await findSkattekontoLedgerHolding(supabase, companyId), ids)
  } catch {
    return null
  }
}

// Body for POST /skattekonto/transaktioner/bokfor-batch. Capped at 200 ids:
// a full year of skattekonto events fits comfortably, and the sequential
// draft+commit loop stays well inside the dispatcher's time budget.
// allow_duplicate_ids: rows to book even though the ledger already holds the
// event (LEDGER_TWIN_EXISTS, LEDGER_COVER_EXISTS, LEDGER_DIRECT_EXISTS); an explicit per-row
// choice that needs duplicate_reason, which the verifikat notes carry.
const SkattekontoBokforBatchSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    allow_duplicate_ids: z.array(z.string().uuid()).max(200).optional(),
    duplicate_reason: z.string().max(DUPLICATE_REASON_MAX_LENGTH).optional(),
  })
  .refine((b) => !b.allow_duplicate_ids?.length || normaliseDuplicateReason(b.duplicate_reason) !== null, {
    message: 'duplicate_reason',
  })

// Rows the user ticked together to match against ONE verifikat ("Matcha mot
// verifikat"); linkSkattekontoRows caps a group at 50.
const SkattekontoGroupMatchSchema = z.object({
  transaction_ids: z.array(z.string().uuid()).min(2).max(50),
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

const SKV_WRITE_ROLES = new Set(['owner', 'admin', 'member'])

/** agi_declarations statuses that do not yet carry a filing receipt. */
const AGI_UNFILED_STATUSES: readonly string[] = ['pending_signature', 'generated', 'exported']

/**
 * What the person filing an AGI is told when Skatteverket's gateway refuses
 * the kvittens read for the whole installation (#2226). The filing itself is
 * unaffected (it is made and signed at Skatteverket), so the message says
 * where the receipt can be verified instead of how to fix an API subscription
 * they have no access to. The panel renders its own copy from the code; this
 * string is for API/MCP callers of the same route.
 */
const AGI_KVITTENS_UNAVAILABLE_MESSAGE =
  'Accounted kan just nu inte hämta kvittensen från Skatteverket. Inlämningen ' +
  'påverkas inte: kontrollera i Skatteverkets e-tjänst Arbetsgivardeklaration ' +
  'att perioden är signerad och inlämnad. Kvittensen kan hämtas hit senare.'

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
          'Anslutningen mot Skatteverket har gått ut. Skatteverkets inloggning räcker i ungefär tio timmar, så detta är normalt. Anslut igen med BankID.',
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
 * RBAC check for every route that acts at Skatteverket for the company
 * (VAT utkast, lås, submit; AGI underlag, spara, lås, granskningsunderlag;
 * the ombud system connection). Ctx presence alone (set by middleware) only
 * confirms the user is signed in and has a resolved company; it does NOT
 * prove they are entitled to file for that company. Viewers must be blocked,
 * and here the route is the only gate: the effect lands at Skatteverket, so
 * RLS (current_user_can_write) never sees it. write-role-gate.test.ts derives
 * the gated set from the registered routes.
 *
 * Returns null on success, a NextResponse on failure.
 */
async function requireSkvWriteRole(ctx: ExtensionContext): Promise<NextResponse | null> {
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
  if (!data?.role || !SKV_WRITE_ROLES.has(data.role as string)) {
    return NextResponse.json(
      { error: 'Otillräcklig behörighet för att lämna uppgifter till Skatteverket för det här företaget.' },
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

  apiRoutes: [
    // ── OAuth: Start authorization ──────────────────────────────────
    // Builds the Skatteverket OAuth2 authorize URL and redirects the user
    // to BankID login. The flow is recorded as one oauth_flows row keyed by
    // the state (lib/auth/oauth-flows.ts): who started it, on which origin,
    // and what the token exchange must repeat.
    {
      method: 'GET',
      path: '/authorize',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        const state = newOAuthFlowId()
        let redirectUri = `${getSkvOauthBaseUrl()}/api/extensions/ext/skatteverket/callback`

        // Optional: where to send the user after the BankID round-trip.
        // Allowlisted to internal in-app paths to avoid open-redirect abuse.
        const url = new URL(request.url)
        const requestedReturn = url.searchParams.get('return_to')
        const returnTo =
          requestedReturn && requestedReturn.startsWith('/') && !requestedReturn.startsWith('//')
            ? requestedReturn
            : null

        // The origin the user is on (app or a validated white-label brand
        // domain). The callback finishes the flow there: that is where the
        // opener tab lives and where the session cookies are.
        const origin = await resolveOAuthOrigin(request)

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

        const { createServiceClient } = await import('@/lib/supabase/server')
        const db = createServiceClient()
        // Expired rows go here rather than in a cron: the set is tiny and
        // every connect attempt is a fine moment to sweep it. Best-effort.
        try {
          await purgeExpiredOAuthFlows(db)
        } catch (err) {
          log.warn('oauth flow purge failed', { error: (err as Error).message })
        }
        await createOAuthFlow(db, {
          id: state,
          kind: 'skatteverket',
          companyId: ctx.companyId,
          userId: ctx.userId,
          origin,
          redirectUri,
          codeVerifier: pkce.verifier,
          connectorState,
          returnTo,
        })

        return NextResponse.redirect(authorizeUrl)
      },
    },

    // ── OAuth: Callback ─────────────────────────────────────────────
    // Receives the auth code from Skatteverket after BankID login.
    // Exchanges code for tokens immediately (5-minute code expiry).
    // skipAuth: true; browser redirect from Skatteverket. The flow is
    // resolved from the oauth_flows row the state names, and the completion
    // is bound to that row's user via the session on the initiating origin.
    {
      method: 'GET',
      path: '/callback',
      skipAuth: true,
      handler: async (request: Request) => {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        const url = new URL(request.url)
        let code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        const handoffId = url.searchParams.get('handoff')
        // Where the opener tab lives. The canonical app origin until the flow
        // row says otherwise; never derived from the request itself.
        let responseOrigin = new URL(appUrl).origin

        // Connector branch: a self-hosted instance started this SKV consent
        // through the /api/connect/skv broker, which registered OUR redirect
        // uri and a signed connector state. We never exchange the code here
        // (the instance does, through the broker's /oauth/token): just bounce
        // the browser back to the instance with the code + its original
        // state, so no per-instance redirect uri is registered at SKV.
        if (!handoffId && isConnectorState(state)) {
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

        // Injection-safety invariants: responseOrigin is either deployment
        // configuration (NEXT_PUBLIC_APP_URL) or a server-validated origin
        // written by /authorize, never callback input, and jsLiteral
        // JSON-encodes and escapes `<` so embedded values cannot break out of
        // the script context. The per-response CSP nonce below is defense in
        // depth on top of that: even injected markup could never execute.
        const jsLiteral = (value: unknown) =>
          JSON.stringify(value ?? '').replace(/</g, '\\u003c')

        // CSP allows only the nonce-carrying inline script; everything else
        // is blocked. The nonce is the proxy's for this request, so the
        // script also runs under the proxy's CSP header (the only one a
        // self-hosted `next start` delivers). Cache-Control: no-store because
        // the callback URL carries a one-shot authorization code and must
        // never be cached.
        const responseHeaders = (nonce: string) => ({
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        })

        // Build an HTML response that detects whether we're running inside an
        // OAuth popup. If `window.opener` exists, post a message back to the
        // parent and close the popup. Otherwise fall back to a plain redirect
        // (preserves the legacy non-popup connect flow). Both go to the
        // origin the flow started on. The fallback uses location.replace so
        // this callback URL (whose code and state are consumed) drops out of
        // history: navigating Back from the landing page must not re-run the
        // callback into a guaranteed state error.
        const respondWithSuccess = (fallbackPath: string) => {
          const nonce = requestCspNonce(request.headers)
          const html = `<!DOCTYPE html><html><body><script nonce="${nonce}">
            if (window.opener) {
              window.opener.postMessage({ type: 'skatteverket-oauth-success' }, ${jsLiteral(responseOrigin)});
              window.close();
            } else {
              window.location.replace(${jsLiteral(`${responseOrigin}${fallbackPath}`)});
            }
          </script><p>Anslutningen lyckades. Du kan stänga denna flik.</p></body></html>`
          return new Response(html, {
            status: 200,
            headers: responseHeaders(nonce),
          })
        }

        // Once the flow row is known the message goes to the opener's own
        // origin and is guaranteed to arrive, so the tab stays open on error:
        // the reason stays on screen and cannot become an invisible "nothing
        // happens". Before the row is known (unknown, expired or replayed
        // state or handoff) the target is a guess, and a brand opener would
        // never hear it: then the tab closes so the panels' closed-tab
        // watcher resets them instead of leaving Connect disabled forever.
        const respondWithError = (
          reason: string,
          fallbackPath: string,
          options: { closeTab?: boolean } = {},
        ) => {
          const nonce = requestCspNonce(request.headers)
          const escapedReason = reason
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
          const html = `<!DOCTYPE html><html><body><script nonce="${nonce}">
            if (window.opener) {
              window.opener.postMessage({ type: 'skatteverket-oauth-error', reason: ${jsLiteral(reason)} }, ${jsLiteral(responseOrigin)});
              ${options.closeTab ? 'window.close();' : ''}
            } else {
              window.location.replace(${jsLiteral(`${responseOrigin}${fallbackPath}`)});
            }
          </script><p>Anslutningen misslyckades: ${escapedReason}</p><p>Du kan stänga denna flik.</p></body></html>`
          return new Response(html, {
            status: 200,
            headers: responseHeaders(nonce),
          })
        }

        const defaultErrorPath = (msg: string) =>
          `/reports?tab=vat-declaration&skv_error=${encodeURIComponent(msg)}`

        if (!handoffId && ((!code && !error) || !state)) {
          return respondWithError('Saknar auktoriseringskod', defaultErrorPath('Saknar auktoriseringskod'), { closeTab: true })
        }

        const { createServiceClient } = await import('@/lib/supabase/server')
        const db = createServiceClient()

        // Resolve the flow. Hop 2 arrives with a handoff id; hop 1 (or the
        // only hop, when the callback host is the app host) with the
        // provider's state. Both consumes are atomic and single-use, and
        // every failure (unknown, forged, expired, replayed, wrong origin) is
        // the same answer: this route is unauthenticated and must not be an
        // oracle. The handoff is claimed for the validated origin this
        // request arrived on: decided by host with the scheme from
        // configuration, so a proxy that drops x-forwarded-proto cannot make
        // hop 2 disagree with what /authorize recorded.
        //
        // On the hop that finishes the flow (it has the initiating origin's
        // cookies), the completing browser is bound to the initiator BEFORE
        // the one-shot row is spent: the row names who started the flow, and
        // the tokens below are stored for that user with the service client.
        // A session-less arrival goes to login and resumes into this very
        // URL; a different user is refused and the row stays claimable for
        // the initiator; only then is the row consumed. A victim lured into
        // approving a consent someone else started thus never has their
        // BankID-authorised access stored under that someone, and nobody
        // can burn a live flow by merely reaching its URL signed out.
        //
        // Membership is checked here as well, before the consume: the
        // service-role token write below has no RLS backstop, membership
        // can be revoked between /authorize and this callback (#1091), and
        // a revoked initiator must not burn the one-shot provider code on
        // the way to being refused.
        const bindInitiator = async (identity: { userId: string; companyId: string; origin: string }) => {
          responseOrigin = identity.origin
          const initiator = await requireFlowInitiator(request, identity.userId, {
            flow: 'skatteverket.callback',
            returnOrigin: identity.origin,
          })
          if (!initiator.ok) {
            if (initiator.reason === 'no_session') return { userId: null, response: initiator.response }
            return {
              userId: null,
              response: respondWithError(
                FLOW_INITIATOR_MISMATCH_MESSAGE,
                defaultErrorPath(FLOW_INITIATOR_MISMATCH_MESSAGE),
              ),
            }
          }
          const { data: membership } = await db
            .from('company_members')
            .select('user_id')
            .eq('company_id', identity.companyId)
            .eq('user_id', initiator.userId)
            .maybeSingle()
          if (!membership) {
            return {
              userId: null,
              response: respondWithError(
                'Behörighet saknas för företaget',
                defaultErrorPath('Behörighet saknas för företaget'),
              ),
            }
          }
          return { userId: initiator.userId, response: null }
        }

        let flow: OAuthFlow
        let providerError: string | null = null
        let boundUserId: string | null = null
        if (handoffId) {
          const arrivedOn = await resolveOAuthOrigin(request)
          const identity = await peekOAuthFlowHandoff(db, handoffId, arrivedOn, 'skatteverket')
          if (!identity) {
            return respondWithError(SKV_STATE_REJECTED_MESSAGE, defaultErrorPath(SKV_STATE_REJECTED_MESSAGE), { closeTab: true })
          }
          const bound = await bindInitiator(identity)
          if (bound.response) return bound.response
          boundUserId = bound.userId
          const handoff = await consumeOAuthFlowHandoff(db, handoffId, arrivedOn, 'skatteverket')
          if (!handoff) {
            return respondWithError(SKV_STATE_REJECTED_MESSAGE, defaultErrorPath(SKV_STATE_REJECTED_MESSAGE), { closeTab: true })
          }
          flow = handoff
          code = handoff.providerCode
          providerError = handoff.providerError
        } else {
          const identity = await peekOAuthFlowState(db, state as string, 'skatteverket')
          if (!identity) {
            return respondWithError(SKV_STATE_REJECTED_MESSAGE, defaultErrorPath(SKV_STATE_REJECTED_MESSAGE), { closeTab: true })
          }
          // Single hop (the callback host is the initiating host): bind here.
          // Hop 1 on the registered host has no session to bind; hop 2 does.
          if (requestMatchesOrigin(request, identity.origin)) {
            const bound = await bindInitiator(identity)
            if (bound.response) return bound.response
            boundUserId = bound.userId
          }
          const consumed = await consumeOAuthFlowState(db, state as string, 'skatteverket')
          if (!consumed) {
            return respondWithError(SKV_STATE_REJECTED_MESSAGE, defaultErrorPath(SKV_STATE_REJECTED_MESSAGE), { closeTab: true })
          }
          flow = consumed
          if (error) providerError = url.searchParams.get('error_description') || 'Okänt fel'
        }
        responseOrigin = flow.origin

        const successPath = flow.returnTo
          ? `${flow.returnTo}${flow.returnTo.includes('?') ? '&' : '?'}skv_connected=true`
          : `/reports?tab=vat-declaration&skv_connected=true`
        const errorPath = (msg: string) =>
          flow.returnTo
            ? `${flow.returnTo}${flow.returnTo.includes('?') ? '&' : '?'}skv_error=${encodeURIComponent(msg)}`
            : defaultErrorPath(msg)

        // Hop 1 on the registered callback host: no session for the
        // initiating origin can exist here. Stash the provider's result on
        // the row (encrypted, under a separate handoff id) and send the
        // browser to the origin the flow started on. Provider credentials
        // never enter this URL. Compared by host only: see requestHost.
        if (!handoffId && !requestMatchesOrigin(request, flow.origin)) {
          let nextHandoff: string
          try {
            nextHandoff = await mintOAuthFlowHandoff(
              db,
              flow,
              providerError !== null ? { providerError } : { providerCode: code as string },
            )
          } catch (err) {
            // The state is spent; the user restarts. The response must still
            // be the callback page, so the opener hears it and resets.
            log.error('oauth handoff mint failed', err as Error, { companyId: flow.companyId })
            return respondWithError(
              'Ett tekniskt fel uppstod. Försök igen.',
              errorPath('Ett tekniskt fel uppstod'),
            )
          }
          const target = new URL('/api/extensions/ext/skatteverket/callback', flow.origin)
          target.searchParams.set('handoff', nextHandoff)
          return new Response(null, {
            status: 302,
            headers: {
              Location: target.toString(),
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer',
            },
          })
        }

        // Bound above, before the consume. Re-checked here only because the
        // row was read twice: the session that passed the identity check is
        // the one that must own the tokens.
        if (!boundUserId || boundUserId !== flow.userId) {
          log.error('oauth callback bound user diverged from the consumed flow', {
            companyId: flow.companyId,
          })
          return respondWithError(SKV_SESSION_MISSING_MESSAGE, errorPath(SKV_SESSION_MISSING_MESSAGE))
        }
        const userId = boundUserId
        const companyId = flow.companyId

        if (providerError !== null) {
          return respondWithError(providerError, errorPath(providerError))
        }
        if (!code) {
          return respondWithError(SKV_STATE_REJECTED_MESSAGE, errorPath(SKV_STATE_REJECTED_MESSAGE))
        }

        try {
          // The exchange must repeat the redirect_uri SKV saw and the PKCE
          // verifier /authorize generated; both come from the row.
          const tokens = await exchangeCodeForTokens(
            code,
            flow.redirectUri,
            flow.codeVerifier ?? undefined,
            flow.connectorState ?? undefined,
          )
          await storeTokens(db, userId, tokens, companyId)

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
          log.error('token exchange failed', err, { companyId, userId })
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
      handler: async (_request: Request, ctx: ExtensionContext) => {
        const tokens = await getTokens(ctx.supabase, ctx.userId, ctx.companyId)
        const environment = getSkatteverketEnvironment()
        const disabled = (process.env.SKATTEVERKET_DISABLED ?? '').toLowerCase() === 'true'
        // Reads run on Accounted's ombud grant: the personal session below
        // only matters for signing, so the reconnect prompts stand down
        // (skvStatusNeedsReconnect). `connected` keeps meaning "this user
        // has a BankID connection", which the submit panels still need.
        const ombud = await hasOmbudReadAccess(ctx.companyId).catch(() => false)

        if (!tokens) {
          return NextResponse.json({ connected: false, ombud, environment, disabled })
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

        // Skatteverket's last answer when it would not hand the skattekonto
        // over (no account yet, person not authorized): the panel says so
        // instead of the sync failing silently every hour (B07).
        const unavailable = await ctx.settings
          .get<SkattekontoUnavailableState>(SKATTEKONTO_UNAVAILABLE_KEY)
          .catch(() => null)

        return NextResponse.json({
          connected: true,
          ombud,
          expired,
          canRefresh,
          needsReconsent: health?.status === 'needs_reconsent',
          lastErrorCode: health?.last_error_code ?? null,
          skattekontoUnavailable: unavailable?.reason
            ? { reason: unavailable.reason, since: unavailable.since, checkedAt: unavailable.checkedAt }
            : null,
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
      handler: async (_request: Request, ctx: ExtensionContext) => {
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
      handler: async (_request: Request, ctx: ExtensionContext) => {
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
      handler: async (_request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        if (getSystemAuthMode() === 'off' || !isSystemAuthConfigured()) {
          return NextResponse.json(
            { error: 'Systemanslutningen är inte aktiverad i denna miljö.' },
            { status: 503 }
          )
        }

        // Manual probes are rate limited: one per minute per company. Timed
        // on the last real probe (lasombud_checked_at), not last_probe_at,
        // which the deep link's opt-in row also stamps: a user who signs at
        // Skatteverket within a minute of opening the link and comes back
        // must get a verification, not a 429.
        const existing = await getConnection(ctx.companyId, currentSkvEnvironment())
        const lastProbe = existing?.lasombud_checked_at ?? null
        if (lastProbe && Date.now() - new Date(lastProbe).getTime() < 60_000) {
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
          parseEntityType(settings.entity_type)
        )

        const contestedForVerify = await contestedOrgNumberResponse(orgNumber)
        if (contestedForVerify) return contestedForVerify

        try {
          // Each probe call is audited by the transport.
          const result = await probeCompanyGrants(ctx.companyId, orgNumber, ctx.userId)
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
      handler: async (_request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireSkvWriteRole(ctx)
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
          parseEntityType(settings.entity_type)
        )

        const contestedForLink = await contestedOrgNumberResponse(orgNumber)
        if (contestedForLink) return contestedForLink

        try {
          const link = await createUtseOmbudDeepLink(
            orgNumber,
            { companyId: ctx.companyId, userId: ctx.userId },
            OMBUD_ROLE_KEYS
          )
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
      handler: async (_request: Request, ctx: ExtensionContext) => {
        const roleBlocked = await requireSkvWriteRole(ctx)
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked

        try {
          const { redovisare, redovisningsperiod, momsuppgift } =
            await parseDeclarationRequest(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'POST',
            `/kontrollera/${redovisare}/${redovisningsperiod}`,
            { endpoint: 'declaration/validate', agRegistreradId: redovisare, redovisningsperiod },
            momsuppgift
          )

          if (!response.ok) {
            const text = await response.text()
            ctx.log.error('VAT validate refused', { redovisningsperiod, status: response.status })
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        try {
          const input = await parseDeclarationInput(request)
          const { redovisare, redovisningsperiod, momsuppgift, declaration } =
            await buildMomsuppgift(ctx.supabase, ctx.companyId, input)

          // The "Kontroll av underlaget" gate on the server, before anything
          // reaches Eget utrymme: the panel's own check is no gate for a
          // caller that posts here directly.
          const verdict = await vatFilingVerdict(ctx.supabase, ctx.companyId, declaration, {
            fiscalPeriodId: input.fiscalPeriodId,
          })
          if (verdict.blocked) {
            const refused = vatDeclarationIncompleteFailure(verdict.checks)
            return NextResponse.json(
              {
                error: refused.error,
                code: 'VAT_DECLARATION_INCOMPLETE',
                stage: refused.stage,
                completeness_checks: refused.completenessChecks,
              },
              { status: refused.httpStatus }
            )
          }

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'POST',
            `/utkast/${redovisare}/${redovisningsperiod}`,
            { endpoint: 'declaration/draft', agRegistreradId: redovisare, redovisningsperiod },
            momsuppgift
          )

          if (!response.ok) {
            const text = await response.text()
            ctx.log.error('VAT draft refused', { redovisningsperiod, status: response.status })
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'GET',
            `/utkast/${redovisare}/${redovisningsperiod}`,
            {
              endpoint: 'declaration/draft/read',
              agRegistreradId: redovisare,
              redovisningsperiod,
              okStatuses: [404],
            }
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'DELETE',
            `/utkast/${redovisare}/${redovisningsperiod}`,
            { endpoint: 'declaration/draft/delete', agRegistreradId: redovisare, redovisningsperiod }
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          // 'declaration/lock' with outcome 'ok' is read by the reset
          // guards: never relabel it.
          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'PUT',
            `/las/${redovisare}/${redovisningsperiod}`,
            { endpoint: 'declaration/lock', agRegistreradId: redovisare, redovisningsperiod }
          )

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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            ctx.companyId,
            'DELETE',
            `/las/${redovisare}/${redovisningsperiod}`,
            { endpoint: 'declaration/unlock', agRegistreradId: redovisare, redovisningsperiod }
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked

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
                ...(result.completenessChecks
                  ? { code: 'VAT_DECLARATION_INCOMPLETE', completeness_checks: result.completenessChecks }
                  : {}),
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
      handler: async (request: Request, ctx: ExtensionContext) => {
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
          // The same fetch as the v1 read service (lib/declaration-status.ts).
          const fetched = await fetchDeclarationView(
            resolved.auth,
            { view: 'inlamnat', companyId: ctx.companyId, userId: ctx.userId, redovisare, redovisningsperiod },
            ctx.log,
          )
          if (!fetched.ok) {
            return NextResponse.json(
              { error: fetched.failure.error, code: fetched.failure.code },
              { status: fetched.failure.http_status },
            )
          }

          // A non-null inlamnat means the declaration is filed: complete the
          // period's moms deadline. Best-effort, gated on the caller passing
          // the picker params (older clients omit them).
          if (fetched.body) {
            await completeVatDeadlineFromRequest(request, ctx, 'submitted')
          }

          return NextResponse.json({ data: fetched.body })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch decided declaration ───────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/decided',
      handler: async (request: Request, ctx: ExtensionContext) => {
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
          // The same fetch as the v1 read service (lib/declaration-status.ts).
          const fetched = await fetchDeclarationView(
            resolved.auth,
            { view: 'beslutat', companyId: ctx.companyId, userId: ctx.userId, redovisare, redovisningsperiod },
            ctx.log,
          )
          if (!fetched.ok) {
            return NextResponse.json(
              { error: fetched.failure.error, code: fetched.failure.code },
              { status: fetched.failure.http_status },
            )
          }

          // A beslut means Skatteverket has processed the filing: confirm
          // the period's moms deadline (terminal state).
          if (fetched.body) {
            await completeVatDeadlineFromRequest(request, ctx, 'confirmed')
          }

          return NextResponse.json({ data: fetched.body })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },
    // ══════════════════════════════════════════════════════════════
    // AGI (Arbetsgivardeklaration) routes
    //
    // AGI submission is XML, not JSON. We feed agi_declarations.xml_content
    // (built by lib/salary/agi/xml-generator.ts, regenerated from current data
    // before every submit while unfiled) to POST /underlag, then poll
    // kontrollresultat, save into Eget utrymme, and return a Mina Sidor
    // signing link via skapaGranskningsunderlag. After the user signs we
    // observe the kvittenser endpoint to record kvittensnummer/signeradTid.
    //
    // The route surface mirrors the conceptual flow rather than the literal
    // SKV endpoints so the frontend stays simple. Two SKV APIs are involved:
    // inlamning (XML ingest + JSON status) and hanteraredovisningsperiod
    // (kvittenser + las/lasUpp). The agi-client encapsulates both.
    // ══════════════════════════════════════════════════════════════

    // ── AGI: Skicka in underlag (step 1 of the chain) ───────────────
    // Body: { salaryRunId }. The panel's advanced "Skicka in underlag":
    // submitAgiUnderlag (lib/agi-submit.ts), the first step of the one-click
    // chain: refresh and POST the XML, poll kontrollresultat with the panel's
    // patience, mark the run's declaration rejected on a refusal at kontroll.
    // Answers { data: { inlamningId, kontrollrapport } } or { error, code,
    // details } (details.kontrollrapport on a refusal at kontroll).
    {
      method: 'POST',
      path: '/agi/submit',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked
        try {
          const salaryRunId = await readSalaryRunId(request)
          if (!salaryRunId) {
            return NextResponse.json({ error: 'Saknar parameter: salaryRunId' }, { status: 400 })
          }
          // 'agi/submit' with outcome 'ok' is read by the migration-reset
          // guard; the transport writes the row.
          const result = await submitAgiUnderlag(ctx.supabase, ctx.userId, ctx.companyId, ctx.settings, salaryRunId, {
            extraPolls: 7,
            pollIntervalMs: 1000,
          })
          if (!result.ok) {
            if (result.code === 'SKATTEVERKET_SUBMIT_REJECTED') {
              ctx.log.error('AGI underlag refused', { status: result.httpStatus, kod: result.skvKod })
            }
            return agiStepFailureResponse(result)
          }
          return NextResponse.json({
            data: { inlamningId: result.inlamningId, kontrollrapport: result.kontrollrapport },
          })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Skicka för signering (the whole chain) ─────────────────
    // Body: { salaryRunId }. The panel's one-click "Skicka för signering":
    // submitAgiChain (lib/agi-submit.ts), the chain MCP gnubok_agi_submit
    // runs at approval, so both doors submit, poll, lock and flip the run's
    // declaration alike. Answers { data: { signing_url, tillstand, period } }
    // or { error, code, details } (details.kontrollrapport on a refusal at
    // kontroll). The XML is (re)generated first; nothing is filed here.
    {
      method: 'POST',
      path: '/agi/send-for-signing',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked
        try {
          const salaryRunId = await readSalaryRunId(request)
          if (!salaryRunId) {
            return NextResponse.json({ error: 'Saknar parameter: salaryRunId' }, { status: 400 })
          }
          // The panel's own patience: up to eight kontroll reads a second apart.
          const result = await submitAgiChain(ctx.supabase, ctx.userId, ctx.companyId, ctx.settings, salaryRunId, {
            extraPolls: 7,
            pollIntervalMs: 1000,
          })
          if (!result.ok) return agiStepFailureResponse(result)
          return NextResponse.json({
            data: { signing_url: result.signingUrl, tillstand: result.tillstand, period: result.period },
          })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Skapa signeringslänk (step 2 of the chain) ─────────────
    // Body: { salaryRunId }. The panel's advanced "Skapa signeringslänk",
    // after "Skicka in underlag": createAgiSigningLink (lib/agi-submit.ts),
    // the second step of the one-click chain. skapaGranskningsunderlag with
    // the period locked, the link persisted for a later visit, and the run's
    // own declaration flipped to pending_signature. Answers
    // { data: { link, tillstand } } or { error, code }.
    {
      method: 'POST',
      path: '/agi/granskningsunderlag',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked
        try {
          const salaryRunId = await readSalaryRunId(request)
          if (!salaryRunId) {
            return NextResponse.json({ error: 'Saknar parameter: salaryRunId' }, { status: 400 })
          }
          const target = await agiRunTarget(ctx.supabase, ctx.companyId, salaryRunId)
          const result = await createAgiSigningLink(ctx.supabase, ctx.userId, ctx.companyId, ctx.settings, target)
          if (!result.ok) return agiStepFailureResponse(result)
          return NextResponse.json({ data: { link: result.signingUrl, tillstand: result.tillstand } })
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
      handler: async (request: Request, ctx: ExtensionContext) => {
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
            period,
            { companyId: ctx.companyId, userId: ctx.userId }
          )
          if (!result.ok) {
            return NextResponse.json(
              { error: result.error, code: result.body?.kod },
              { status: result.status },
            )
          }

          // The receipt of the period's current declaration, once it has
          // one; the panel reads it instead of the raw list, which also holds
          // earlier filings' receipts (a correction awaiting signature lists
          // only the original's).
          let declarationKvittensnummer: string | null = null
          if (newestAgiKvittens(result.data.kvittenser)) {
            const periodYear = parseInt(period.slice(0, 4))
            const periodMonth = parseInt(period.slice(4, 6))

            // Every receipt listed for the period is kept first
            // (agi-kvittens-history.ts): the period's declaration below
            // follows the newest, and a correction's must not cost the
            // original filing its receipt.
            const recorded = await recordAgiKvittenser(
              ctx.supabase,
              ctx.companyId,
              { year: periodYear, month: periodMonth },
              result.data.kvittenser,
              'interactive',
            )
            if (!recorded.ok) {
              ctx.log.warn('kvittenser read but not recorded', {
                companyId: ctx.companyId, period, message: recorded.error,
              })
            }

            // Pin the receipt to the most recent declaration for this period
            // so a correction chain doesn't get its kvittens written onto a
            // superseded row.
            const { data: latest } = await ctx.supabase
              .from('agi_declarations')
              .select('id, salary_run_id, status')
              .eq('company_id', ctx.companyId)
              .eq('period_year', periodYear)
              .eq('period_month', periodMonth)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()

            // The declaration's own receipt, never an earlier filing's of the
            // month (declarationKvittens): the same pick the cron makes.
            const own = await declarationKvittens(
              ctx.supabase,
              ctx.companyId,
              (latest?.salary_run_id as string | null) ?? null,
              result.data.kvittenser,
            )
            if (!own.ok) {
              ctx.log.warn('kvittenser read but the declaration\'s own could not be resolved', {
                companyId: ctx.companyId, period, message: own.error,
              })
            }
            const kvittens = own.ok ? own.kvittens : null
            declarationKvittensnummer = kvittens?.uuidKvittens ?? null

            if (!kvittens) {
              // Every receipt listed belongs to an earlier filing of the month:
              // the declaration is not signed yet, so nothing moves.
            } else if (latest?.id && AGI_UNFILED_STATUSES.includes(latest.status as string)) {
              // First receipt for this declaration. This check is what fires
              // when the user comes back from signing, so it is usually the
              // FIRST observer of the kvittens, and it used to promote the row
              // with its own inline update: no compare-and-set, no deadline
              // confirmation. The background runs only revisit
              // pending_signature rows, so a filing recorded here kept its AGI
              // deadline open forever. It now goes through the same promotion
              // as the cron and the post-connect refresh: one claim, and the
              // side effects (salary_runs.agi_submitted_at from signeradTid,
              // cache cleanup, deadline confirmation) run exactly once, by
              // whichever path wins. submitted_by is the operator who ran the
              // check; the BankID signer is kvittens.signeradAv, preserved in
              // response_data (BFL 5 kap 6§). No email: the user is looking at
              // the panel, which shows the receipt (served from the declaration
              // once the in-flight cache is gone, #1597).
              const outcome = await promoteAgiDeclaration(
                ctx.supabase,
                {
                  id: latest.id as string,
                  company_id: ctx.companyId,
                  salary_run_id: (latest.salary_run_id as string | null) ?? null,
                  period_year: periodYear,
                  period_month: periodMonth,
                },
                kvittens,
                {
                  reconciledBy: 'interactive',
                  submittedBy: ctx.userId,
                  notifyUserId: null,
                  fromStatuses: AGI_UNFILED_STATUSES,
                },
              )
              if (outcome.status === 'error') {
                ctx.log.warn('kvittens observed but the declaration was not updated', {
                  companyId: ctx.companyId, period, message: outcome.error,
                })
              }
            } else {
              // No declaration row, or one that already carries a receipt (a
              // correction filed on a submitted period): the period's state
              // moves to the newest receipt; every earlier one stays in
              // agi_kvittenser.
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

              // The presence of `uuidKvittens` confirms SKV signed and accepted
              // the AGI. signeradTid is the precise signing moment; if SKV
              // omits it we fall back to reconciliation time + warn so the
              // discrepancy is investigable. Leaving NULL would hide that the
              // filing occurred at all, which itself misstates the behandlings-
              // historik (BFNAR 2013:2 kap 8 / BFL 5 kap 6§).
              const submittedAt = kvittens.signeradTid || new Date().toISOString()
              if (!kvittens.signeradTid) {
                ctx.log.warn('kvittens missing signeradTid; using reconciliation time', {
                  companyId: ctx.companyId, period, uuidKvittens: kvittens.uuidKvittens,
                })
              }
              // The declaration already carries a receipt: replace it only
              // once every receipt is kept, so the one it carries now is
              // never lost.
              if (latest?.id && recorded.ok) {
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
          }

          return NextResponse.json({ data: { ...result.data, declarationKvittens: declarationKvittensnummer } })
        } catch (err) {
          if (isApigwClientRefusal(err)) {
            // Skatteverket's gateway refuses the APIGW client for the hantera
            // API (#2226). The thrown message is operator guidance (env var,
            // Utvecklarportalen): nothing the person filing an AGI can act on.
            // Same 403 as before, now with a code the panel maps to its own
            // copy, so the UI can stop claiming it is waiting for a signature
            // it has no way to see.
            return NextResponse.json(
              { error: AGI_KVITTENS_UNAVAILABLE_MESSAGE, code: 'KVITTENS_UNAVAILABLE' },
              { status: 403 },
            )
          }
          return handleSkvError(err)
        }
      },
    },

    // ── AGI: Lås upp period ─────────────────────────────────────────
    {
      method: 'POST',
      path: '/agi/lasUpp',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const roleBlocked = await requireSkvWriteRole(ctx)
        if (roleBlocked) return roleBlocked
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
          // it carries points at a released draft. Clear it so the panel drops
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
      handler: async (request: Request, ctx: ExtensionContext) => {
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
      handler: async (_request: Request, ctx: ExtensionContext) => {
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const from = url.searchParams.get('from')
        const includeIgnoredParam = url.searchParams.get('include_ignored')
        const includeIgnored =
          includeIgnoredParam === '1' || includeIgnoredParam === 'true'

        // Paged, id as the unique tiebreaker: past 1,000 rows the oldest
        // fell out of every bucket.
        let rows: StoredSkattekontoTransaction[]
        try {
          rows = await fetchAllRows<StoredSkattekontoTransaction>(({ from: rangeFrom, to: rangeTo }) => {
            let query = ctx.supabase
              .from('skattekonto_transactions')
              .select('*')
              .eq('company_id', ctx.companyId)
              .order('transaktionsdatum', { ascending: false })
              .order('id', { ascending: true })

            if (from) query = query.gte('transaktionsdatum', from)

            return query.range(rangeFrom, rangeTo)
          })
        } catch (error) {
          return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }

        const today = todayIsoStockholm()
        const { booked, overdue, upcoming, ignored } = splitTransactions(rows, today)

        // The skattekonto's ledger account (1630, or 2012 for an enskild
        // firma that runs it there): the suggestions below and the page's
        // labels use it.
        let skattekontoAccount: SkattekontoLedgerAccount
        try {
          skattekontoAccount = await resolveSkattekontoAccount(ctx.supabase, ctx.companyId)
        } catch (error) {
          return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }

        // Enrich obokförda rader with a single-best-candidate suggestion.
        // Only attached when there's exactly one match: avoids the UI
        // confidently pointing at the wrong verifikat.
        const suggestions = await findMatchSuggestionsBulk(
          ctx.supabase,
          ctx.companyId,
          booked.map(r => ({
            id: r.id,
            transaktionsdatum: r.transaktionsdatum,
            transaktionstext: r.transaktionstext,
            belopp_skatteverket: Number(r.belopp_skatteverket),
            journal_entry_id: r.journal_entry_id,
          })),
          skattekontoAccount,
        )

        // Deterministic booking suggestion per unbooked row (one hoisted
        // rules fetch): the UI shows what "Bokför" will do and uses it to
        // decide bulk-booking eligibility.
        const withBookingSuggestions = await attachBookingSuggestions(
          ctx.supabase,
          ctx.companyId,
          booked,
          skattekontoAccount,
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
            skattekonto_account: skattekontoAccount,
          },
        })
      },
    },

    // ── Manual sync ────────────────────────────────────────────────
    // Pulls fresh saldo + transactions from Skatteverket and upserts.
    {
      method: 'POST',
      path: '/skattekonto/sync',
      handler: async (_request: Request, ctx: ExtensionContext) => {
        const blocked = await requireSkvCapability(ctx)
        if (blocked) return blocked
        try {
          // Any member may trigger a sync on the company's connection: the
          // resolved auth carries the token OWNER's userId, so the refresh
          // writes back to their row, never to the caller's (#1673). A row
          // flagged needs_reconsent cannot heal on its own, so answer the
          // reconnect prompt directly instead of burning a refresh call.
          // Shared with the v1 operation skattekonto.sync (lib/core-actions.ts).
          const result = await runSkattekontoSync(ctx)
          if (!result.ok) return skvActionFailureResponse(result)
          return NextResponse.json({ data: result.data })
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        let parsedBody: unknown
        try {
          parsedBody = await request.json()
        } catch {
          return NextResponse.json({ error: 'Ogiltig JSON i förfrågan.' }, { status: 400 })
        }

        const parsed = SkattekontoBokforBatchSchema.safeParse(parsedBody)
        if (!parsed.success) {
          const missingReason = parsed.error.issues.some((i) => i.message === 'duplicate_reason')
          return NextResponse.json(
            {
              error: missingReason
                ? 'Ange varför händelsen ska bokföras fast bokföringen redan innehåller den (duplicate_reason).'
                : 'Ogiltiga parametrar: ids måste vara en lista med 1-200 transaktions-id.',
            },
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
            {
              allowDuplicateIds: parsed.data.allow_duplicate_ids ?? [],
              ...(parsed.data.allow_duplicate_ids?.length ? { duplicateReason: parsed.data.duplicate_reason } : {}),
            },
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        // Extract :id from the catch-all dispatcher's path-param convention
        // (`_id` query string, set in app/api/extensions/ext/[...path]/route.ts).
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }

        // Optional body { allow_duplicate: true, duplicate_reason }: draft
        // even though the ledger already holds the event, for the stated
        // reason the verifikat notes carry. No body (the historical call)
        // keeps the guard on.
        const rawBody = await request.text().catch(() => '')
        let duplicateReason: string | null = null
        if (rawBody.trim()) {
          let body: unknown
          try {
            body = JSON.parse(rawBody)
          } catch {
            return NextResponse.json({ error: 'Ogiltig JSON i förfrågan.' }, { status: 400 })
          }
          const fields = (body ?? {}) as { allow_duplicate?: unknown; duplicate_reason?: unknown }
          if (fields.allow_duplicate !== undefined && typeof fields.allow_duplicate !== 'boolean') {
            return NextResponse.json(
              { error: 'Ogiltiga parametrar: allow_duplicate måste vara true eller false.' },
              { status: 400 },
            )
          }
          if (
            fields.duplicate_reason !== undefined &&
            (typeof fields.duplicate_reason !== 'string' || fields.duplicate_reason.length > DUPLICATE_REASON_MAX_LENGTH)
          ) {
            return NextResponse.json(
              { error: `Ogiltiga parametrar: duplicate_reason måste vara en text på högst ${DUPLICATE_REASON_MAX_LENGTH} tecken.` },
              { status: 400 },
            )
          }
          if (fields.allow_duplicate === true) {
            duplicateReason = normaliseDuplicateReason(fields.duplicate_reason)
            if (!duplicateReason) {
              return NextResponse.json(
                { error: 'Ange varför händelsen ska bokföras fast bokföringen redan innehåller den (duplicate_reason).' },
                { status: 400 },
              )
            }
          }
        }

        try {
          const entry = await bokforSkattekontoTransaction(
            ctx.supabase,
            ctx.companyId,
            ctx.userId,
            id,
            undefined,
            duplicateReason ? { duplicateReason } : {},
          )
          return NextResponse.json({ data: { entry } })
        } catch (err) {
          if (err instanceof SkattekontoBookingError) {
            const status =
              err.code === 'TRANSACTION_NOT_FOUND' ? 404
              : err.code === 'ALREADY_BOOKED' ? 409
              : err.code === 'ROW_IGNORED' ? 409
              : err.code === 'LEDGER_TWIN_EXISTS' ? 409
              : err.code === 'LEDGER_COVER_EXISTS' ? 409
              : err.code === 'LEDGER_DIRECT_EXISTS' ? 409
              : err.code === 'PERIOD_LOCKED' ? 423
              : err.code === 'NO_COUNTER_ACCOUNT' ? 422
              : 400
            return NextResponse.json(
              {
                error: err.message,
                code: err.code,
                ...(err.ledgerTwins ? { ledger_twins: err.ledgerTwins } : {}),
                ...(err.ledgerCover ? { ledger_cover: err.ledgerCover } : {}),
                ...(err.ledgerDirect ? { ledger_direct: err.ledgerDirect } : {}),
              },
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }
        try {
          const { candidates } = await findMatchCandidates(ctx.supabase, ctx.companyId, id)
          const ledgerCover = candidates.length === 0 ? await coverForRows(ctx.supabase, ctx.companyId, [id]) : null
          return NextResponse.json({ data: { candidates, ...(ledgerCover ? { ledger_cover: ledgerCover } : {}) } })
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

    // ── Matcha flera händelser mot ett verifikat ─────────────────────
    // The bulk bar's "Matcha mot verifikat": candidates for several open
    // rows the user ticked together (findGroupMatchCandidates). The rows may
    // have either sign and different dates. Linking reuses POST /:id/match
    // with also_transaction_ids, which checks the whole group again.
    {
      method: 'POST',
      path: '/skattekonto/transaktioner/group-match-candidates',
      handler: async (request: Request, ctx: ExtensionContext) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return NextResponse.json({ error: 'Ogiltig JSON i förfrågan.' }, { status: 400 })
        }
        const parsed = SkattekontoGroupMatchSchema.safeParse(body)
        if (!parsed.success) {
          return NextResponse.json(
            { error: 'Ogiltiga parametrar: transaction_ids måste vara en lista med 2-50 transaktions-id.' },
            { status: 400 },
          )
        }
        try {
          const { candidates } = await findGroupMatchCandidates(
            ctx.supabase,
            ctx.companyId,
            parsed.data.transaction_ids,
          )
          const ledgerCover =
            candidates.length === 0
              ? await coverForRows(ctx.supabase, ctx.companyId, parsed.data.transaction_ids)
              : null
          return NextResponse.json({ data: { candidates, ...(ledgerCover ? { ledger_cover: ledgerCover } : {}) } })
        } catch (err) {
          if (err instanceof SkattekontoMatchError) {
            const status =
              err.code === 'TRANSACTION_NOT_FOUND' ? 404
              : err.code === 'ALREADY_BOOKED' ? 409
              : err.code === 'ROW_IGNORED' ? 409
              : 422
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const url = new URL(request.url)
        const id = url.searchParams.get('_id')
        if (!id) {
          return NextResponse.json({ error: 'Saknar transaktions-id' }, { status: 400 })
        }
        let body: { journal_entry_id?: string; also_transaction_ids?: unknown }
        try {
          body = (await request.json()) as { journal_entry_id?: string; also_transaction_ids?: unknown }
        } catch {
          return NextResponse.json({ error: 'Ogiltig request body' }, { status: 400 })
        }
        if (!body.journal_entry_id || typeof body.journal_entry_id !== 'string') {
          return NextResponse.json(
            { error: 'Saknar journal_entry_id' },
            { status: 400 },
          )
        }
        // A combined candidate (crm#128) names the other rows that settle the
        // verifikat together with this one; they are linked all or nothing.
        const also = body.also_transaction_ids
        if (
          also !== undefined &&
          (!Array.isArray(also) ||
            also.length > 49 ||
            !also.every((v): v is string => typeof v === 'string' && v.length > 0))
        ) {
          return NextResponse.json(
            { error: 'also_transaction_ids måste vara en lista med högst 49 transaktions-id.' },
            { status: 400 },
          )
        }
        try {
          await matchSkattekontoToEntry(
            ctx.supabase,
            ctx.companyId,
            id,
            body.journal_entry_id,
            (also as string[] | undefined) ?? [],
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
      handler: async (request: Request, ctx: ExtensionContext) => {
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

        // The same service as the reconciliation page's ignore (core
        // lib/skatteverket/skattekonto-link.ts): one rule for which rows may
        // be ignored, and ignoring drops a standing proposal.
        try {
          await setSkattekontoRowIgnored(ctx.supabase, ctx.companyId, id, isIgnored)
        } catch (err) {
          if (!(err instanceof SkattekontoLinkError)) throw err
          const status = err.code === 'TRANSACTION_NOT_FOUND' ? 404 : err.code === 'ALREADY_BOOKED' ? 409 : 500
          return NextResponse.json({ error: err.message }, { status })
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
    // AGI pre-validation and the manual skattekonto sync for the v1
    // operations (lib/operations/skatteverket.ts). Contract in
    // lib/skatteverket/extension-actions.ts; the routes above call the same
    // functions.
    validateAgiUppgift,
    syncSkattekontoNow,
    previewSkattekontoSync,
    // Ombud state for core surfaces (Hem, the reconnect notice, onboarding)
    // that must stop asking for BankID once reads run on the ombud grant.
    // Contract in lib/skatteverket/ombud-access.ts.
    isOmbudEnabled: async () => isSystemReadActive(),
    hasOmbudReadAccess,
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
  return buildMomsuppgift(ctx.supabase, ctx.companyId, await parseDeclarationInput(request))
}

/** The period a declaration request names, checked for the required fields. */
async function parseDeclarationInput(
  request: Request,
): Promise<{ periodType: VatPeriodType; year: number; period: number; fiscalPeriodId?: string }> {
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

  return { periodType, year, period, fiscalPeriodId }
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
 * The deadline generator's tax_period for the picker params, from the one
 * definition of a VAT period key (lib/vat/filing-record.ts). A yearly label
 * (`YYYY`, or `YYYY-1/YYYY` for a broken räkenskapsår; year = the year it
 * ends) depends on the company's fiscal year, hence the settings read.
 */
async function vatTaxPeriod(
  ctx: ExtensionContext,
  periodType: VatPeriodType,
  year: number,
  period: number,
): Promise<string> {
  const { data } = await ctx.supabase
    .from('company_settings')
    .select('entity_type, fiscal_year_start_month')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  return vatFilingTaxPeriod(periodType, year, period, vatFilingFiscalYearEndMonth(data))
}

/**
 * Complete the moms deadline for the period identified by the request's
 * optional periodType/year/period query params. Every moms deadline type is
 * passed: the cadences' tax_period formats never overlap, so the label alone
 * picks the row. Best-effort by design (completeTaxDeadline never throws).
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
  if (
    (periodType !== 'monthly' && periodType !== 'quarterly' && periodType !== 'yearly') ||
    !Number.isFinite(year) ||
    !Number.isFinite(period) ||
    !year ||
    !period
  ) {
    return
  }
  await completeTaxDeadline(
    ctx.supabase,
    ctx.companyId,
    [...VAT_FILING_DEADLINE_TYPES],
    await vatTaxPeriod(ctx, periodType, year, period),
    newStatus
  )
}

/** The AGI routes' `{ salaryRunId }` body, or null when it names none. */
async function readSalaryRunId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => ({}))) as { salaryRunId?: unknown }
  return typeof body.salaryRunId === 'string' && body.salaryRunId ? body.salaryRunId : null
}

/**
 * A chain step's refusal, as the AGI panel routes answer it: one shape for
 * the one-click chain and both advanced steps. Still processing is no
 * success, so never a 2xx: the panel shows the sentence and the user tries
 * again.
 */
function agiStepFailureResponse(failure: AgiStepFailure): NextResponse {
  return NextResponse.json(
    {
      error: failure.error,
      code: failure.code,
      ...(failure.details ? { details: failure.details } : {}),
    },
    { status: failure.httpStatus === 202 ? 409 : failure.httpStatus },
  )
}

/**
 * Convert Skatteverket errors to appropriate HTTP responses.
 */
/**
 * A shared-service failure (lib/core-actions.ts) in the envelope these
 * dashboard routes always answered: the paywall 403, the SKV auth codes the
 * reconnect UI reads (via handleSkvError), and Skatteverket's own status and
 * felkod for a refused kontrollera call.
 */
function skvActionFailureResponse(failure: SkvActionFailure): NextResponse {
  if (failure.code === 'SKATTEVERKET_CAPABILITY_BLOCKED') return capabilityBlockedResponse(CAPABILITY.skatteverket)
  const details = failure.details ?? {}
  const skvCode = details.skv_code as SkatteverketAuthError['code'] | undefined
  if (skvCode) return handleSkvError(new SkatteverketAuthError(failure.error, skvCode))
  const status = typeof details.skv_status === 'number' ? details.skv_status : failure.http_status
  return NextResponse.json(
    { error: failure.error, code: details.skv_kod ?? failure.code },
    { status },
  )
}

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

  log.error('API error', err)
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
  if (!isSkatteverketEnabled()) return EXTENSION_DISABLED_RESULT

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

  // Rows the reviewer approved booking although the ledger already holds a
  // verifikat for the event (staged with allow_duplicate / allow_duplicate_ids
  // and the duplicate_reason the verifikat notes carry). An op staged without
  // a reason keeps the guard on for every row.
  const rawAllow = params.allow_duplicate_ids
  const allowDuplicateIds = Array.isArray(rawAllow)
    ? rawAllow.filter((v): v is string => typeof v === 'string' && ids.includes(v))
    : []
  const duplicateReason = normaliseDuplicateReason(params.duplicate_reason)

  try {
    const result = await bokforSkattekontoTransactionsBatch(supabase, companyId, userId, ids, {
      allowDuplicateIds,
      ...(duplicateReason ? { duplicateReason } : {}),
    })
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
 *
 * Writes no audit row: a failed outbound call was already recorded by the
 * transport under its own label, and a failure before any call made none.
 */
function mapServiceError(err: unknown): Extract<SkvSubmitResult, { ok: false }> {
  if (err instanceof SkatteverketAuthError) {
    const mapped = skvAuthCodeToStructured(err.code)
    return { ok: false, code: mapped.code, http_status: mapped.httpStatus, recoverable: true, error: err.message }
  }
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
  if (!isSkatteverketEnabled()) return EXTENSION_DISABLED_RESULT

  const periodType = params.period_type as VatPeriodType
  const year = params.year as number
  const period = params.period as number
  const fiscalPeriodId = params.fiscal_period_id as string | undefined
  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')

  try {
    // The staged figures were already reviewed at approval time, so the
    // chain starts at the utkast write (no kontrollera pre-step here). The
    // chain still runs the completeness verdict on the books as they are
    // now: an op staged before they changed is refused, not filed.
    const result = await submitVatDeclarationChain(ctx, { periodType, year, period, fiscalPeriodId })
    if (!result.ok && result.stage === 'completeness') {
      // Non-recoverable by design: the op's reviewed figures no longer pass,
      // so it is consumed; the user fixes the findings and stages anew.
      return {
        ok: false, code: 'VAT_DECLARATION_INCOMPLETE', http_status: result.httpStatus,
        recoverable: false, error: result.error,
        details: { completeness_checks: result.completenessChecks ?? [] },
      }
    }
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
    return mapServiceError(err)
  }
}

/**
 * AGI "skicka för signering" for an approved MCP operation: submitAgiChain
 * (lib/agi-submit.ts), the chain the panel's one-click route runs, in the
 * pending-operation result shape.
 */
async function commitSubmitAgi(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: Record<string, unknown>,
): Promise<SkvSubmitResult> {
  if (!isSkatteverketEnabled()) return EXTENSION_DISABLED_RESULT

  const salaryRunId = params.salary_run_id as string
  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')

  try {
    // The chain the AGI panel's one-click route runs too (lib/agi-submit.ts).
    const result = await submitAgiChain(supabase, userId, companyId, ctx.settings, salaryRunId)
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        http_status: result.httpStatus,
        recoverable: result.recoverable,
        error: result.error,
        ...(result.details ? { details: result.details } : {}),
      }
    }
    return {
      ok: true,
      signing_url: result.signingUrl,
      arbetsgivare: result.arbetsgivare,
      period: result.period,
      inlamning_id: result.inlamningId,
      tillstand: result.tillstand,
    }
  } catch (err) {
    return mapServiceError(err)
  }
}
