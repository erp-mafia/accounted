import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import {
  AGIKontrolleraHUSchema,
  AGIKontrolleraIUSchema,
  AGI_KONTROLLERA_MAX_BYTES,
} from '@/lib/salary/agi/kontrollera-schemas'
import { TimeoutError } from '@/lib/http/fetch-with-timeout'
import { buildAuthorizeUrl, exchangeCodeForTokens, generatePkcePair } from './lib/oauth'
import { storeTokens, getTokens, deleteTokens } from './lib/token-store'
import { skvRequest, SkatteverketAuthError, getSkatteverketEnvironment } from './lib/api-client'
import { writeSkatteverketAudit } from './lib/audit'
import { skvAuthCodeToStructured } from './lib/error-map'
import {
  buildMomsuppgift,
  buildAgiUnderlag,
  type VatDeclarationPrep,
  type AgiUnderlagPrep,
} from './lib/declaration-prep'
import { createExtensionContext } from '@/lib/extensions/context-factory'
import type { SkvSubmitResult } from '@/lib/pending-operations/skatteverket-commit'
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
import { bokforSkattekontoTransaction, SkattekontoBookingError } from './lib/skattekonto-booking'
import { handleSkattekontoDriftDetected } from './lib/skattekonto-drift-email'
import {
  findMatchCandidates,
  findMatchSuggestionsBulk,
  matchSkattekontoToEntry,
  SkattekontoMatchError,
} from './lib/skattekonto-match'
import { splitTransactions } from './lib/skattekonto-buckets'
import type { SkattekontoBalanceSnapshot, SkatteverketUtkastResponse } from './types'
import type { VatPeriodType } from '@/types'

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
 *        SKATTEVERKET_OAUTH_BASE_URL=https://oauth2.skatteverket.se/oauth2
 *   8. Verify Sentry alerts on /api/extensions/ext/skatteverket/* 5xx.
 *   9. Verify 7-year retention of `agi_declarations.xml_content` +
 *      `kvittensnummer` (BFL 7 kap.).
 *  10. Run a single AGI end-to-end against test on a real client before
 *      switching that client over.
 *
 * The /status endpoint reports which environment is active so the UI can
 * surface a Testmiljö / Produktion badge.
 */

const AGI_WRITE_ROLES = new Set(['owner', 'admin', 'member'])

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

        const state = crypto.randomUUID()
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        const redirectUri = `${appUrl}/api/extensions/ext/skatteverket/callback`

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

        // Store state for CSRF validation in callback
        await ctx.settings.set('oauth_state', state)
        await ctx.settings.set('oauth_redirect_uri', redirectUri)
        await ctx.settings.set('oauth_code_verifier', pkce.verifier)
        if (returnTo) await ctx.settings.set('oauth_return_to', returnTo)
        else await ctx.settings.clear('oauth_return_to')

        const authorizeUrl = buildAuthorizeUrl(redirectUri, state, {
          codeChallenge: pkce.challenge,
        })

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

        // JSON-encode for safe embedding inside <script>. Escapes quotes and `</`
        // so the value can't break out of the script tag.
        const jsLiteral = (value: unknown) =>
          JSON.stringify(value ?? '').replace(/</g, '\\u003c')

        // Build an HTML response that detects whether we're running inside an
        // OAuth popup. If `window.opener` exists, post a message back to the
        // parent and close the popup. Otherwise fall back to a plain redirect
        // (preserves the legacy non-popup connect flow).
        const respondWithSuccess = (fallbackPath: string) => {
          const html = `<!DOCTYPE html><html><body><script>
            if (window.opener) {
              window.opener.postMessage({ type: 'skatteverket-oauth-success' }, ${jsLiteral(appUrl)});
              window.close();
            } else {
              window.location.href = ${jsLiteral(`${appUrl}${fallbackPath}`)};
            }
          </script><p>Anslutningen lyckades. Du kan stänga denna flik.</p></body></html>`
          return new Response(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }

        const respondWithError = (reason: string, fallbackPath: string) => {
          const escapedReason = reason
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
          const html = `<!DOCTYPE html><html><body><script>
            if (window.opener) {
              window.opener.postMessage({ type: 'skatteverket-oauth-error', reason: ${jsLiteral(reason)} }, ${jsLiteral(appUrl)});
              window.close();
            } else {
              window.location.href = ${jsLiteral(`${appUrl}${fallbackPath}`)};
            }
          </script><p>Anslutningen misslyckades: ${escapedReason}</p></body></html>`
          return new Response(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
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

        // Exchange code FIRST: 5-minute expiry, do this before anything else
        const { createClient } = await import('@/lib/supabase/server')
        const { requireCompanyId } = await import('@/lib/company/context')
        const supabase = await createClient()

        // Verify user session (browser should still have cookies)
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          // Login redirects always go to a full page: popups can't render the
          // login form usefully, so this is the one path that keeps a hard
          // redirect even from inside the popup.
          return NextResponse.redirect(
            `${appUrl}/login?redirect=${encodeURIComponent('/reports?tab=vat-declaration')}`
          )
        }

        // Resolve the active company: state/redirect_uri were stored keyed on company_id
        // by ctx.settings.set() in the /authorize handler.
        let companyId: string
        try {
          companyId = await requireCompanyId(supabase, user.id)
        } catch {
          return respondWithError(
            'Inget företag valt',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Inget företag valt')}`,
          )
        }

        // Validate CSRF state
        const { data: settingsData } = await supabase
          .from('extension_data')
          .select('value')
          .eq('company_id', companyId)
          .eq('extension_id', 'skatteverket')
          .eq('key', 'oauth_state')
          .single()

        if (!settingsData || settingsData.value !== state) {
          return respondWithError(
            'Ogiltig state-parameter (CSRF)',
            `/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Ogiltig state-parameter (CSRF)')}`,
          )
        }

        // Get the stored redirect URI
        const { data: redirectData } = await supabase
          .from('extension_data')
          .select('value')
          .eq('company_id', companyId)
          .eq('extension_id', 'skatteverket')
          .eq('key', 'oauth_redirect_uri')
          .single()

        const redirectUri = redirectData?.value ||
          `${appUrl}/api/extensions/ext/skatteverket/callback`

        // Retrieve the PKCE verifier stored in /authorize. Optional only for
        // backward compatibility with in-flight flows that started before the
        // PKCE rollout: once those drain, this can be made required.
        const { data: verifierData } = await supabase
          .from('extension_data')
          .select('value')
          .eq('company_id', companyId)
          .eq('extension_id', 'skatteverket')
          .eq('key', 'oauth_code_verifier')
          .maybeSingle()

        const codeVerifier = (verifierData?.value as string | null) || undefined

        // Optional in-app destination set by /authorize?return_to=...
        const { data: returnToData } = await supabase
          .from('extension_data')
          .select('value')
          .eq('company_id', companyId)
          .eq('extension_id', 'skatteverket')
          .eq('key', 'oauth_return_to')
          .maybeSingle()

        const returnTo = (returnToData?.value as string | null) || null
        const successPath = returnTo
          ? `${returnTo}${returnTo.includes('?') ? '&' : '?'}skv_connected=true`
          : `/reports?tab=vat-declaration&skv_connected=true`
        const errorPath = (msg: string) =>
          returnTo
            ? `${returnTo}${returnTo.includes('?') ? '&' : '?'}skv_error=${encodeURIComponent(msg)}`
            : `/reports?tab=vat-declaration&skv_error=${encodeURIComponent(msg)}`

        try {
          const tokens = await exchangeCodeForTokens(code, redirectUri, codeVerifier)
          await storeTokens(supabase, user.id, tokens, companyId)

          // Clean up CSRF state + the one-shot return_to + PKCE verifier.
          await supabase
            .from('extension_data')
            .delete()
            .eq('company_id', companyId)
            .eq('extension_id', 'skatteverket')
            .in('key', ['oauth_state', 'oauth_return_to', 'oauth_code_verifier'])

          return respondWithSuccess(successPath)
        } catch (err) {
          console.error('[skatteverket] Token exchange failed:', err)
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

        const tokens = await getTokens(ctx.supabase, ctx.userId)
        const environment = getSkatteverketEnvironment()
        const disabled = (process.env.SKATTEVERKET_DISABLED ?? '').toLowerCase() === 'true'

        if (!tokens) {
          return NextResponse.json({ connected: false, environment, disabled })
        }

        const expired = tokens.expires_at < Date.now()
        const canRefresh = tokens.refresh_token !== null && tokens.refresh_count < 10

        return NextResponse.json({
          connected: true,
          expired,
          canRefresh,
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

        await deleteTokens(ctx.supabase, ctx.userId)
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

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
            'PUT',
            `/las/${redovisare}/${redovisningsperiod}`
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
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
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

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
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

          const response = await skvRequest(
            ctx.supabase,
            ctx.userId,
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
        try {
          const { arbetsgivare, period, salaryRunId, xml } = await loadAGIXml(request, ctx)

          console.log('[skatteverket] AGI submitting underlag:', { arbetsgivare, period })

          const result = await agiPostUnderlag(ctx.supabase, ctx.userId, xml)
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

          const result = await agiGetKontrollresultat(ctx.supabase, ctx.userId, inlamningId)
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
        try {
          const body = (await request.json()) as { inlamningId?: number; salaryRunId?: string }
          const inlamningId = Number(body.inlamningId)
          if (!Number.isFinite(inlamningId) || inlamningId <= 0) {
            return NextResponse.json({ error: 'Saknar inlamningId' }, { status: 400 })
          }

          const result = await agiSparaUnderlag(ctx.supabase, ctx.userId, inlamningId)
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
          const result = await agiAvbrytUnderlag(ctx.supabase, ctx.userId, inlamningId)
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
            ctx.supabase, ctx.userId, arbetsgivare, period, inlamningId,
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
            ctx.supabase, ctx.userId, arbetsgivare, period, { lasPeriod },
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

          const result = await agiGetKvittenser(ctx.supabase, ctx.userId, arbetsgivare, period)
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
          const result = await agiKontrolleraHU(ctx.supabase, ctx.userId, parsed.data)
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
          const result = await agiKontrolleraIU(ctx.supabase, ctx.userId, parsed.data)
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
          const result = await agiLasPeriod(ctx.supabase, ctx.userId, arbetsgivare, period)
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
          const result = await agiLasUppPeriod(ctx.supabase, ctx.userId, arbetsgivare, period)
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
    // kvittensnummer if seen). Pure read; never calls Skatteverket.
    {
      method: 'GET',
      path: '/agi/status',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        const url = new URL(request.url)
        const period = url.searchParams.get('period')
        if (!period) return NextResponse.json({ error: 'Saknar parameter: period' }, { status: 400 })

        const statusJson = await ctx.settings.get<string>(`agi_submission_${period}`)
        if (!statusJson) return NextResponse.json({ data: null })
        try {
          return NextResponse.json({ data: JSON.parse(statusJson) })
        } catch {
          return NextResponse.json({ data: null })
        }
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
    {
      method: 'GET',
      path: '/skattekonto/transaktioner',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }
        const url = new URL(request.url)
        const from = url.searchParams.get('from')

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
        const { booked, overdue, upcoming } = splitTransactions(rows, today)

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

        const bookedEnriched = booked.map(r => ({
          ...r,
          match_suggestion: suggestions.get(r.id) ?? null,
        }))

        return NextResponse.json({
          data: {
            booked: bookedEnriched,
            overdue,
            upcoming,
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
        try {
          const result = await syncSkattekonto(ctx)
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
              : err.code === 'ENTRY_ALREADY_LINKED' ? 409
              : 422
            return NextResponse.json({ error: err.message, code: err.code }, { status })
          }
          return handleSkvError(err)
        }
      },
    },
  ],

  eventHandlers: [
    {
      eventType: 'skattekonto.drift_detected',
      handler: handleSkattekontoDriftDetected,
    },
  ],

  // Registry-resolved commit services for the MCP submit tools. The core
  // pending-operations dispatcher (lib/pending-operations/commit.ts) cannot
  // import this extension (CI guard), so it reaches these through
  // extensionRegistry.get('skatteverket')?.services when committing a staged
  // submit_vat_declaration / submit_agi operation. Commit = "send for BankID
  // signing" (returns a signing link), never "file".
  services: {
    commitSubmitVatDeclaration,
    commitSubmitAgi,
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
  const { periodType, year, period } = body as {
    periodType: VatPeriodType
    year: number
    period: number
  }

  if (!periodType || !year || !period) {
    throw new Error('Saknar obligatoriska fält: periodType, year, period')
  }

  return buildMomsuppgift(ctx.supabase, ctx.companyId, { periodType, year, period })
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const EXTENSION_DISABLED_RESULT: Extract<SkvSubmitResult, { ok: false }> = {
  ok: false,
  code: 'EXTENSION_DISABLED',
  http_status: 503,
  recoverable: true,
  error: 'Skatteverket-integrationen är inte aktiverad i denna miljö.',
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
  const ctx = createExtensionContext(supabase, userId, companyId, 'skatteverket')

  try {
    const { redovisare, redovisningsperiod, momsuppgift } =
      await buildMomsuppgift(supabase, companyId, { periodType, year, period })

    // 1. POST /utkast: save the draft to Eget utrymme. Overwrites any prior
    //    draft for the period, so retry after a mid-chain failure is safe.
    const utkast = await skvRequest(
      supabase, userId, 'POST', `/utkast/${redovisare}/${redovisningsperiod}`, momsuppgift,
    )
    await writeSkatteverketAudit(ctx, {
      endpoint: 'declaration/draft', agRegistreradId: redovisare, redovisningsperiod,
      outcome: utkast.ok ? 'ok' : 'skv_error', responseStatus: utkast.status,
    })
    if (!utkast.ok) {
      const text = await utkast.text().catch(() => '')
      return {
        ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: utkast.status,
        recoverable: false, error: `Skatteverket svarade med ${utkast.status}: ${text}`,
      }
    }
    const utkastData = (await utkast.json()) as SkatteverketUtkastResponse

    // 2. PUT /las: lock for signing; returns the BankID signeringslänk.
    const las = await skvRequest(
      supabase, userId, 'PUT', `/las/${redovisare}/${redovisningsperiod}`,
    )
    await writeSkatteverketAudit(ctx, {
      endpoint: 'declaration/lock', agRegistreradId: redovisare, redovisningsperiod,
      outcome: las.ok ? 'ok' : 'skv_error', responseStatus: las.status,
    })
    if (!las.ok) {
      const text = await las.text().catch(() => '')
      return {
        ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: las.status,
        recoverable: false, error: `Skatteverket svarade med ${las.status}: ${text}`,
      }
    }
    const lasData = (await las.json()) as SkatteverketUtkastResponse
    if (!lasData.signeringsLank) {
      return {
        ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', http_status: 502, recoverable: false,
        error: 'Skatteverket låste deklarationen men returnerade ingen signeringslänk.',
      }
    }

    // Persist locked state so the UI/poller can resume (mirrors /declaration/lock).
    await ctx.settings.set(
      `submission_${redovisningsperiod}`,
      JSON.stringify({
        status: 'draft_locked', redovisare, redovisningsperiod,
        signeringsLank: lasData.signeringsLank, updatedAt: new Date().toISOString(),
      }),
    )

    return {
      ok: true,
      signing_url: lasData.signeringsLank,
      redovisningsperiod,
      redovisare,
      kontrollresultat: utkastData.kontrollResultat ?? null,
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
    const submit = await agiPostUnderlag(supabase, userId, xml)
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
    let kontroll = await agiGetKontrollresultat(supabase, userId, inlamningId)
    for (let i = 0; i < 2 && kontroll.ok && kontroll.data.status === 'PROCESSING'; i++) {
      await sleep(750)
      kontroll = await agiGetKontrollresultat(supabase, userId, inlamningId)
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
    const gransk = await agiSkapaGranskningsunderlag(supabase, userId, arbetsgivare, period, { lasPeriod: true })
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
