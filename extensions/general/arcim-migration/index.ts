import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import {
  createConsent,
  getConsent,
  listConsents,
  generateOtc,
  consumeOAuthState,
  getAuthUrl,
  exchangeAuthToken,
  submitProviderToken,
  acceptConsent,
  deleteConsent,
  resolveConsent,
  fetchCompanyInfoDirect,
  ProviderTokenInvalidError,
  ProviderCompanyMismatchError,
  ConsentNotFoundError,
} from './lib/provider-client'
import { providerSupportsSie, fetchProviderSieFiles, getAllowedFiscalYears } from './lib/sie-fetcher'
import { mapCompanyInfo } from './lib/entity-mapper'
import { executeMigration } from './lib/migration-orchestrator'
import {
  FortnoxDocumentScopesRequiredError,
  importProviderDocuments,
} from './lib/import-documents'
import { reconcileSupplierInvoiceVouchers } from '@/lib/invoices/bulk-reconcile-supplier-vouchers'
import type { ArcimProvider } from './types'
import { ARCIM_PROVIDERS } from './types'
import { parseSIEFile, validateSIEFile } from '@/lib/import/sie-parser'
import { mergeParsedSIEFiles } from '@/lib/import/sie-merge'
import { scanSieForCp1252Artifacts, formatSieArtifactWarning } from '@/lib/import/sie-artifact-scan'
import { suggestMappings, getMappingStats, isSystemAccount } from '@/lib/import/account-mapper'
import { loadMappings, generateImportPreview, executeSIEImport, findOverlappingPeriodImports } from '@/lib/import/sie-import'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'
import type { ProviderName } from '@/lib/providers/types'
import { FORTNOX_DOCUMENT_SCOPES_APPROVED } from '@/lib/providers/fortnox/oauth'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { classifyProviderError } from '@/lib/providers/with-provider-call'
import { FortnoxApiError, fortnoxErrorMessage } from '@/lib/providers/fortnox/client'
import { createLogger } from '@/lib/logger'

const moduleLog = createLogger('extensions/arcim-migration')

/**
 * The one answer the unauthenticated OAuth callback gives for every state
 * failure: forged, unknown, expired, replayed, or pointing at a consent that no
 * longer exists. Distinguishing them would turn the callback into a probe for
 * other tenants' consent ids.
 */
const STATE_REJECTED_MESSAGE =
  'Ingen giltig migrationssession hittades. Starta om anslutningen.'

/**
 * Map known OAuth error codes from providers (Fortnox, Visma) to actionable
 * Swedish guidance. Falls back to the raw provider message so we never hide
 * unknown errors from the user.
 */
function translateOAuthError(error: string, description: string | null): string {
  const haystack = `${error} ${description ?? ''}`.toLowerCase()

  if (haystack.includes('missing license') || haystack.includes('not have enough licenses')) {
    return 'Du behöver aktivera tilläggstjänsten "Fortnox Integration" (~149 kr/mån) på ditt Fortnox-konto innan du kan ansluta. Aktivera den under Inställningar → Tilläggstjänster i Fortnox och försök igen.'
  }

  if (error === 'access_denied') {
    return 'Du avbröt anslutningen i leverantörens inloggning. Försök igen om du vill koppla kontot.'
  }

  if (error === 'invalid_scope') {
    return 'Tredjepartsappen har inte rätt behörigheter för ditt konto. Kontakta supporten.'
  }

  return description ? `${error}: ${description}` : error
}

/**
 * Resolve the OAuth callback URL for a provider. Single source of truth for
 * BOTH legs of the flow: the redirect_uri sent in the authorization request
 * and the redirect_uri sent in the token exchange must be byte-identical, or
 * the provider rejects the code exchange (RFC 6749 §4.1.3). The two legs used
 * to resolve this independently: authorize honored the FORTNOX_REDIRECT_URI /
 * VISMA_REDIRECT_URI override while the exchange hardcoded the
 * NEXT_PUBLIC_APP_URL fallback, so any override differing from the fallback
 * (dev ngrok URI, or an env var left on the old app domain after a domain
 * cutover) silently broke every OAuth connect at the exchange step.
 *
 * The override exists so dev environments can route through a single
 * registered URI instead of registering every ngrok URL on the OAuth client.
 */
/**
 * WINT ships dark until the connection is verified against a live WINT
 * account (its API is spec-derived, not sandbox-verified) and the relationship
 * question is settled. Flipping WINT_MIGRATION_ENABLED=true is the launch
 * switch; the rest of the provider is fully wired.
 */
function enabledProviders(): typeof ARCIM_PROVIDERS {
  if (process.env.WINT_MIGRATION_ENABLED === 'true') return ARCIM_PROVIDERS
  return ARCIM_PROVIDERS.filter(p => p.id !== 'wint')
}

function resolveArcimCallbackUrl(provider: ArcimProvider | ProviderName): string {
  const providerRedirectEnv =
    provider === 'visma'
      ? process.env.VISMA_REDIRECT_URI
      : provider === 'fortnox'
        ? process.env.FORTNOX_REDIRECT_URI
        : undefined
  if (providerRedirectEnv && providerRedirectEnv.trim().length > 0) {
    return providerRedirectEnv
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  return `${appUrl}/api/extensions/ext/arcim-migration/callback`
}

/**
 * Build a provider OAuth authorization URL bound to an EXISTING consent id.
 * Used by both first-time connect and reconnect (token revival): the callback
 * runs exchangeAuthToken(consentId, …) which upserts the fresh tokens keyed by
 * consent_id, so re-running OAuth against the same consent overwrites a dead
 * refresh-token pair in place: no disconnect/recreate needed.
 */
async function buildArcimOAuthUrl(
  consentId: string,
  provider: ArcimProvider,
  options?: { documentScopes?: boolean },
): Promise<string> {
  // Server-side state row: consent id, provider (via the consent), expiry and a
  // consumed marker all live in provider_otc. The `state` handed to the provider
  // is that row's opaque random primary key, nothing more.
  const otc = await generateOtc(consentId)

  const callbackUrl = resolveArcimCallbackUrl(provider)

  // The state is the one-time code itself: an unguessable pointer to the row
  // above. It deliberately encodes NOTHING. The previous base64url JSON payload
  // was attacker-authored input the callback trusted, so anyone who learned a
  // consent id could redirect their own provider tokens onto that consent.
  const { url } = await getAuthUrl(provider, otc.code, callbackUrl, {
    documentScopes: options?.documentScopes,
  })
  return url
}

/**
 * Map a failed /migrate run to its structured error response. Shared by the
 * JSON path (returned as-is) and the NDJSON path (body re-sent as the
 * terminal `error` event, since the stream's 200 status is already
 * committed). Consent missing or owned by another company: same 404 either way.
 */
function migrateFailureResponse(error: unknown, consentId: string): NextResponse {
  if (error instanceof ConsentNotFoundError) {
    return errorResponseFromCode('PROVIDER_CONSENT_NOT_FOUND', moduleLog, {
      details: { consentId },
    })
  }
  const classified = classifyProviderError(error)
  return errorResponseFromCode(classified ?? 'PROVIDER_MIGRATE_FAILED', moduleLog, {
    details: {
      reason: error instanceof Error ? error.message : 'unknown',
      classified: classified ?? 'unclassified',
    },
  })
}

/**
 * Provider Migration extension
 *
 * Migrates bookkeeping data from external Swedish accounting systems
 * (Fortnox, Visma, Bokio, Björn Lundén, Briox) into Accounted by talking
 * directly to each provider's API.
 *
 * Bookkeeping data (accounts, balances, vouchers) is imported via SIE
 * files fetched from providers. Entity data (customers, suppliers,
 * invoices) is imported via the provider REST APIs.
 */
export const arcimMigrationExtension: Extension = {
  id: 'arcim-migration',
  name: 'Systemmigration',
  version: '2.0.0',

  apiRoutes: [
    // ── List available providers ───────────────────────────────────
    {
      method: 'GET',
      path: '/providers',
      handler: async () => {
        return NextResponse.json({ providers: enabledProviders() })
      },
    },

    // ── Check existing connections and import history ──────────────
    {
      method: 'GET',
      path: '/status',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id

        try {
          // Get accepted consents only (status 1): not abandoned/created ones
          const allConsents = await listConsents(companyId)
          const consents = allConsents.filter(c => c.status === 1)

          // Get SIE import history
          const { data: sieImports } = await supabase
            .from('sie_imports')
            .select('id, filename, status, accounts_count, transactions_count, company_name, fiscal_year_start, fiscal_year_end, imported_at, created_at')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(10)

          // Get entity counts (to show what's already been imported)
          const [
            { count: customerCount },
            { count: supplierCount },
            { count: invoiceCount },
          ] = await Promise.all([
            supabase.from('customers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
            supabase.from('suppliers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
            supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
          ])

          return NextResponse.json({
            consents: consents.map(c => ({
              id: c.id,
              provider: c.provider,
              status: c.status,
              companyName: c.companyName,
              createdAt: c.createdAt,
            })),
            sieImports: sieImports ?? [],
            entityCounts: {
              customers: customerCount ?? 0,
              suppliers: supplierCount ?? 0,
              invoices: invoiceCount ?? 0,
            },
          })
        } catch (error) {
          moduleLog.error('arcim status failed', error as Error, { companyId })
          return errorResponseFromCode('PROVIDER_STATUS_FAILED', moduleLog, {
            details: { reason: error instanceof Error ? error.message : 'unknown' },
          })
        }
      },
    },

    // ── Start consent flow (create consent + OTC) ─────────────────
    {
      method: 'POST',
      path: '/connect',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id

        const {
          provider,
          companyName,
          orgNumber,
          reconnect,
          documentScopes,
        } = await request.json() as {
          provider: ArcimProvider
          companyName?: string
          orgNumber?: string
          reconnect?: boolean
          /**
           * Reconnect specifically to grant the voucher-attachment scopes.
           * Only the underlag follow-up sets it, so an ordinary connect never
           * asks the customer for Arkivplats and Koppla filer.
           */
          documentScopes?: boolean
        }

        if (!provider) {
          return errorResponseFromCode('VALIDATION_ERROR', moduleLog, {
            details: { field: 'provider', reason: 'required' },
          })
        }

        const providerInfo = enabledProviders().find(p => p.id === provider)
        if (!providerInfo) {
          return errorResponseFromCode('PROVIDER_INVALID', moduleLog, {
            details: { provider },
          })
        }

        try {
          const { createServiceClient: createSvc } = await import('@/lib/supabase/server')

          const existingConsents = await listConsents(companyId)

          // Reconnect: an existing connection's stored tokens are dead (refresh
          // failed → PROVIDER_AUTH_EXPIRED). Re-run auth against the SAME consent
          // so fresh tokens overwrite the dead pair in place: no disconnect, no
          // duplicate consent, import history preserved. Bypasses the
          // alreadyConnected short-circuit below (which would otherwise skip the
          // auth that's the whole point here).
          if (reconnect) {
            const stale = existingConsents.find(
              c => c.provider === provider && (c.status === 0 || c.status === 1),
            )
            if (stale) {
              if (ctx?.settings) {
                await ctx.settings.set('consent_id', stale.id)
                await ctx.settings.set('provider', provider)
              }
              if (providerInfo.authType === 'oauth') {
                const authUrl = await buildArcimOAuthUrl(stale.id, provider, {
                  documentScopes: documentScopes === true,
                })
                return NextResponse.json({
                  consentId: stale.id,
                  authType: 'oauth',
                  authUrl,
                  reconnect: true,
                })
              }
              // Token-based providers re-authorize by re-entering credentials
              return NextResponse.json({
                consentId: stale.id,
                authType: 'token',
                reconnect: true,
              })
            }
            // No existing consent to revive: fall through to a normal connect.
          }

          // Reuse existing accepted consent if one exists for this provider
          const accepted = existingConsents.find(c => c.provider === provider && c.status === 1)

          if (accepted) {
            // Already connected: skip OAuth, go straight to preview
            if (ctx?.settings) {
              await ctx.settings.set('consent_id', accepted.id)
              await ctx.settings.set('provider', provider)
            }

            return NextResponse.json({
              consentId: accepted.id,
              authType: providerInfo.authType,
              alreadyConnected: true,
            })
          }

          // Check for status 0 consents that already have tokens stored (credentials submitted but migration not completed)
          const pending = existingConsents.filter(c => c.provider === provider && c.status === 0)
          if (pending.length > 0) {
            const svc = createSvc()
            for (const p of pending) {
              const { data: tokens } = await svc
                .from('provider_consent_tokens')
                // consent_id is the PK: there is no `id` column. Selecting `id`
                // errors silently (only `data` is read), so `tokens` was always
                // null and the reuse branch below never fired, deleting valid
                // status-0 consents as "abandoned".
                .select('consent_id')
                .eq('consent_id', p.id)
                .limit(1)
              if (tokens && tokens.length > 0) {
                // Tokens exist: reuse this consent, skip credential entry
                if (ctx?.settings) {
                  await ctx.settings.set('consent_id', p.id)
                  await ctx.settings.set('provider', provider)
                }
                return NextResponse.json({
                  consentId: p.id,
                  authType: providerInfo.authType,
                  alreadyConnected: true,
                })
              }
            }
            // No tokens found: clean up abandoned consents
            for (const p of pending) {
              await deleteConsent(p.id)
            }
          }

          // Create new consent
          const consent = await createConsent(
            companyId,
            provider,
            `gnubok-migration-${user.id}`,
            orgNumber,
            companyName
          )

          if (ctx?.settings) {
            await ctx.settings.set('consent_id', consent.id)
            await ctx.settings.set('provider', provider)
          }

          if (providerInfo.authType === 'oauth') {
            const authUrl = await buildArcimOAuthUrl(consent.id, provider)

            return NextResponse.json({
              consentId: consent.id,
              authType: 'oauth',
              authUrl,
            })
          } else {
            // Token-based providers: consent is ready for direct use
            return NextResponse.json({
              consentId: consent.id,
              authType: 'token',
            })
          }
        } catch (error) {
          log.error('arcim connect failed', error as Error, { provider })
          return errorResponseFromCode('PROVIDER_CONNECT_FAILED', moduleLog, {
            details: { reason: error instanceof Error ? error.message : 'unknown' },
          })
        }
      },
    },

    // ── Submit API token for token-based providers (Bokio, etc.) ──
    {
      method: 'POST',
      path: '/submit-token',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        // The caller's tenant: NOT the provider-side company id below.
        const ownerCompanyId = ctx?.companyId ?? user.id

        // `companyId` in the body is the PROVIDER-side company identifier
        // (BL User-Key / Briox account ID / Bokio company GUID).
        const { consentId, provider, apiToken, companyId: providerCompanyId } = await request.json() as {
          consentId: string
          provider: ArcimProvider
          apiToken: string
          companyId?: string
        }

        if (!consentId || !provider) {
          return errorResponseFromCode('VALIDATION_ERROR', moduleLog, {
            details: { fields: ['consentId', 'provider'], reason: 'required' },
          })
        }

        // BL uses server-side client credentials: only needs companyId
        if (provider !== 'bjornlunden' && !apiToken) {
          return errorResponseFromCode('PROVIDER_TOKEN_REQUIRED', moduleLog, {
            details: { provider },
          })
        }

        // Briox needs the account ID (the /token clientid param) alongside
        // the application token; Bokio/BL need their company GUID. WINT
        // reuses the field for the login mail (paired with the password in
        // apiToken; both are exchanged for tokens and never stored).
        if ((provider === 'bokio' || provider === 'bjornlunden' || provider === 'briox' || provider === 'wint') && !providerCompanyId) {
          return errorResponseFromCode('PROVIDER_COMPANY_ID_REQUIRED', moduleLog, {
            details: { provider },
          })
        }

        try {
          await submitProviderToken(
            consentId,
            provider,
            apiToken || 'client_credentials',
            providerCompanyId,
            ownerCompanyId,
          )
          return NextResponse.json({ success: true, consentId })
        } catch (error) {
          log.error('arcim submit-token failed', error as Error, { provider })
          // Consent missing or owned by another company: same 404 either way.
          if (error instanceof ConsentNotFoundError) {
            return errorResponseFromCode('PROVIDER_CONSENT_NOT_FOUND', moduleLog, {
              details: { consentId },
            })
          }
          // Provider rejected authentication or could not resolve the Bokio
          // company: return the actionable problem instead of a generic 500.
          if (error instanceof ProviderTokenInvalidError) {
            if (error.kind === 'company-not-found') {
              return errorResponseFromCode('BOKIO_COMPANY_NOT_FOUND', moduleLog, {
                details: { provider, reason: error.message },
              })
            }
            return errorResponseFromCode('PROVIDER_TOKEN_INVALID', moduleLog, {
              details: { provider, reason: error.message },
            })
          }
          // Valid credentials, wrong company: name both org numbers so the user
          // can see at a glance which company the token actually opened.
          if (error instanceof ProviderCompanyMismatchError) {
            return errorResponseFromCode('PROVIDER_COMPANY_MISMATCH', moduleLog, {
              details: {
                provider,
                expectedOrgNumber: error.expectedOrgNumber,
                actualOrgNumber: error.actualOrgNumber,
                actualCompanyName: error.actualCompanyName,
              },
            })
          }
          return errorResponseFromCode('PROVIDER_TOKEN_SUBMIT_FAILED', moduleLog, {
            details: { reason: error instanceof Error ? error.message : 'unknown' },
          })
        }
      },
    },

    // ── OAuth callback ────────────────────────────────────────────
    {
      method: 'GET',
      path: '/callback',
      skipAuth: true,
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const url = new URL(request.url)
        const code = url.searchParams.get('code')
        const stateRaw = url.searchParams.get('state')
        const oauthError = url.searchParams.get('error')
        const oauthErrorDescription = url.searchParams.get('error_description')
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''

        // JSON-encode for safe embedding inside <script>. Escapes quotes/unicode
        // and `</` so the value can't break out of the script tag.
        const jsLiteral = (value: unknown) =>
          JSON.stringify(value ?? '').replace(/</g, '\\u003c')

        const respondWithError = (reason: string, consentId?: string) => {
          const fallbackUrl = new URL(`${appUrl}/import`)
          fallbackUrl.searchParams.set('migration', 'error')
          fallbackUrl.searchParams.set('reason', reason)
          if (consentId) fallbackUrl.searchParams.set('consentId', consentId)

          const escapedReason = reason
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')

          // The popup deliberately stays open on error: the postMessage is
          // dropped whenever the popup's origin differs from the opener's
          // (browser targetOrigin/origin checks), and closing anyway turns any
          // such config drift into an invisible failure the user can only
          // describe as "nothing happens". Leaving the reason on screen keeps
          // every error diagnosable; the wizard also shows it when the message
          // does arrive.
          const html = `<!DOCTYPE html><html><body><script>
            if (window.opener) {
              window.opener.postMessage({ type: 'arcim-oauth-error', reason: ${jsLiteral(reason)} }, ${jsLiteral(appUrl)});
            } else {
              window.location.href = ${jsLiteral(fallbackUrl.toString())};
            }
          </script><p>Anslutningen misslyckades: ${escapedReason}</p><p>Du kan stänga detta fönster.</p></body></html>`

          return new Response(html, {
            status: 200,
            // charset is required: without it browsers default to Latin-1 and
            // render the Swedish text as mojibake (the "rÃ¤tt behÃ¶righeter" bug).
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        }

        // Provider returned an OAuth error (user cancelled, missing API
        // subscription on the Fortnox side, invalid scope, etc.)
        if (oauthError) {
          log.error('OAuth callback returned provider error', {
            error: oauthError,
            errorDescription: oauthErrorDescription,
            hasCode: !!code,
            hasState: !!stateRaw,
          })
          let consentId: string | undefined
          if (stateRaw) {
            try {
              consentId = (await consumeOAuthState(stateRaw))?.consentId
            } catch (error) {
              log.error('OAuth callback could not resolve failed consent', error)
            }
          }
          return respondWithError(
            translateOAuthError(oauthError, oauthErrorDescription),
            consentId,
          )
        }

        if (!code || !stateRaw) {
          log.error('OAuth callback missing code or state', {
            hasCode: !!code,
            hasState: !!stateRaw,
            queryKeys: Array.from(url.searchParams.keys()),
          })
          return respondWithError('Återanropet saknade code eller state. Försök igen.')
        }

        let callbackConsentId: string | undefined
        try {
          // Single source of truth for who this callback belongs to: the
          // server-written provider_otc row, consumed atomically here. The row
          // carries the consent; the consent carries the provider. Nothing is
          // read from the query string except the opaque state token itself, so
          // an attacker who knows a victim's consent id still cannot steer their
          // own provider tokens onto it.
          const resolvedState = await consumeOAuthState(stateRaw)

          if (!resolvedState) {
            // Unknown/forged state, expired state, replayed state and deleted
            // consent all end here with the SAME message: this route is
            // unauthenticated, so telling the caller which one it was would
            // disclose whether a given consent exists.
            log.error('OAuth callback state rejected', {
              hasCode: !!code,
              stateLength: stateRaw.length,
            })
            return respondWithError(STATE_REJECTED_MESSAGE)
          }

          const { consentId, provider } = resolvedState
          callbackConsentId = consentId

          // Must match the redirect_uri the authorization request was built
          // with, so both come from resolveArcimCallbackUrl.
          const redirectUri = resolveArcimCallbackUrl(provider)

          // Exchange OAuth code directly with the provider
          await exchangeAuthToken(consentId, provider, code, redirectUri)

          // Return an HTML page that notifies the opener tab and closes itself
          const successUrl = `${appUrl}/import?migration=connected&consentId=${encodeURIComponent(consentId)}`
          const html = `<!DOCTYPE html><html><body><script>
            if (window.opener) {
              window.opener.postMessage({ type: 'arcim-oauth-success', consentId: ${jsLiteral(consentId)} }, ${jsLiteral(appUrl)});
              window.close();
            } else {
              window.location.href = ${jsLiteral(successUrl)};
            }
          </script><p>Anslutningen lyckades. Du kan stänga denna flik.</p></body></html>`

          return new Response(html, {
            status: 200,
            // charset is required: without it browsers default to Latin-1 and
            // render the Swedish text as mojibake (the "rÃ¤tt behÃ¶righeter" bug).
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        } catch (error) {
          log.error('OAuth callback exchange failed', error)
          const reason = error instanceof Error ? error.message : 'Okänt fel vid tokenutbyte.'
          return respondWithError(reason, callbackConsentId)
        }
      },
    },

    // ── Preview: fetch company info + SIE stats before migration ──
    {
      method: 'GET',
      path: '/preview',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id

        const url = new URL(request.url)
        const consentId = url.searchParams.get('consentId')

        if (!consentId) {
          return errorResponseFromCode('VALIDATION_ERROR', moduleLog, {
            details: { field: 'consentId', reason: 'required' },
          })
        }

        try {
          // Company-scoped read: the status below is returned to the caller, so
          // an unscoped lookup would let any authenticated user probe another
          // tenant's consent id for existence and connection state. A foreign
          // consent throws ConsentNotFoundError, same as a nonexistent one.
          const consent = await getConsent(consentId, companyId)
          if (consent.status !== 0 && consent.status !== 1) {
            return errorResponseFromCode('PROVIDER_CONSENT_NOT_READY', moduleLog, {
              details: { consentId, status: consent.status },
            })
          }

          // Resolve consent to get access token
          const resolved = await resolveConsent(companyId, consentId)
          const provider = resolved.consent.provider as ProviderName

          // Fetch company info directly from provider
          let mapped = null
          try {
            const companyInfo = await fetchCompanyInfoDirect(provider, resolved.accessToken, resolved.providerCompanyId)
            mapped = companyInfo ? mapCompanyInfo(companyInfo) : null
          } catch (err) {
            // A missing integration license / inactive API module dooms every
            // later call in the wizard too: fail the preview with the typed
            // code (via the outer catch) so the user reads the remediation at
            // connect time, not after a silently empty migration. Other
            // failures stay soft: the preview is still useful without company
            // info (e.g. SIE-over-API can work with narrower scopes).
            const classified = classifyProviderError(err)
            if (classified === 'PROVIDER_API_MODULE_INACTIVE' || classified === 'PROVIDER_LICENSE_MISSING') {
              throw err
            }
            log.info('Company info fetch failed:', err instanceof Error ? err.message : String(err))
          }

          // Try to fetch SIE data (Fortnox and Briox serve SIE over the API)
          let sieAvailable = false
          let sieStats: { accountCount: number; transactionCount: number; fiscalYears: number[] } | null = null

          if (providerSupportsSie(provider)) {
            try {
              log.info(`Fetching SIE export from ${provider} for consent ${consentId}...`)
              // Fetch SIE type 4 for EVERY allowed year, not latestOnly: the
              // stats below render as "Hittade X konton och Y verifikationer"
              // on the connect step, and a mid-year export has few or zero
              // vouchers in the newest year (the One.com migration previewed
              // "0 verifikationer" and then imported 4153). Costs one SIE
              // export per extra year, the same work /sie-data repeats right
              // after: honest numbers are worth it.
              const { files, availableYears } = await fetchProviderSieFiles(
                provider,
                resolved.accessToken,
                resolved.providerCompanyId,
              )
              if (files.length > 0) {
                const merged = mergeParsedSIEFiles(files.map((f) => parseSIEFile(f.rawContent)))
                sieAvailable = true
                sieStats = {
                  accountCount: merged.accounts.length,
                  transactionCount: merged.vouchers.length,
                  fiscalYears: availableYears,
                }
              }
            } catch (err) {
              log.info('SIE export failed:', err instanceof Error ? err.message : String(err))
            }
          }

          // Check if the company already has completed SIE imports (from manual upload)
          const { count: sieImportCount } = await supabase
            .from('sie_imports')
            .select('*', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .eq('status', 'completed')

          return NextResponse.json({
            consent: {
              id: consent.id,
              provider: consent.provider,
              status: consent.status,
              companyName: consent.companyName,
            },
            companyInfo: mapped,
            sieAvailable,
            sieStats,
            hasSieData: (sieImportCount ?? 0) > 0,
          })
        } catch (error) {
          log.error('arcim preview failed', error as Error)
          // Consent missing or owned by another company: same 404 either way.
          if (error instanceof ConsentNotFoundError) {
            return errorResponseFromCode('PROVIDER_CONSENT_NOT_FOUND', moduleLog, {
              details: { consentId },
            })
          }
          // Classify HTTP failures into typed codes so the toast can suggest
          // reconnect / retry instead of a generic "preview failed".
          const classified = classifyProviderError(error)
          return errorResponseFromCode(classified ?? 'PROVIDER_PREVIEW_FAILED', moduleLog, {
            details: {
              reason: error instanceof Error ? error.message : 'unknown',
              classified: classified ?? 'unclassified',
            },
          })
        }
      },
    },

    // ── Fetch + parse SIE data for mapping step ───────────────────
    {
      method: 'GET',
      path: '/sie-data',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id

        const url = new URL(request.url)
        const consentId = url.searchParams.get('consentId')

        if (!consentId) {
          return NextResponse.json({ error: 'consentId is required' }, { status: 400 })
        }

        try {
          // Resolve consent
          const resolved = await resolveConsent(companyId, consentId)
          const provider = resolved.consent.provider as ProviderName

          if (!providerSupportsSie(provider)) {
            return errorResponseFromCode('PROVIDER_SIE_NOT_SUPPORTED', moduleLog, {
              details: { provider },
            })
          }

          // Fetch SIE type 4 for each allowed fiscal year
          const { files: sieFiles, failedYears } = await fetchProviderSieFiles(
            provider,
            resolved.accessToken,
            resolved.providerCompanyId,
          )

          if (sieFiles.length === 0) {
            // The allowed window is rolling (current year and the two before
            // it): interpolate the actual range instead of the static
            // registry message so the text never goes stale.
            const allowedYears = [...getAllowedFiscalYears()].sort((a, b) => a - b)
            const range = `${allowedYears[0]}-${allowedYears[allowedYears.length - 1]}`
            return errorResponseFromCode('PROVIDER_SIE_NO_YEARS', moduleLog, {
              messageSv: `Inga räkenskapsår ${range} hittades hos leverantören.`,
              messageEn: `No fiscal years available for ${range}.`,
              ...(failedYears.length > 0 ? { details: { failedYears } } : {}),
            })
          }

          // Parse every file ONCE: validation, account collection, the
          // preview and the returned `parsed` all read from these parses.
          const parsedFiles = sieFiles.map((file) => ({
            file,
            parsed: parseSIEFile(file.rawContent),
          }))

          // Validate the most recent file's parse: unchanged behavior, so no
          // previously accepted dataset is newly rejected. Older years get no
          // gate here (they never had one); their problems still surface
          // per-file at import time. Validating the merged parse instead
          // would be wrong: validateSIEFile assumes single-file invariants
          // (balance yearIndexes relative to ONE current year) that the
          // merged view deliberately does not preserve.
          const newestFile = parsedFiles[parsedFiles.length - 1]
          const validation = validateSIEFile(newestFile.parsed)

          if (!validation.valid) {
            log.warn(
              `arcim sie-data validation failed for ${provider} fiscal year ${newestFile.file.fiscalYear}: ` +
              `${validation.errors.length} error(s): ${validation.errors.slice(0, 3).join(' | ')}`,
            )
            return NextResponse.json({
              error: 'validation',
              message: 'SIE file validation failed',
              validation,
            }, { status: 400 })
          }

          // Whole-dataset view across ALL fiscal years. Mid-year provider
          // exports have few or zero vouchers in the newest file, so the
          // preview counts and the theater model must never be built from
          // that file alone ("Hittade 740 konton och 0 verifikationer" while
          // 4153 vouchers were about to be imported).
          const merged = mergeParsedSIEFiles(parsedFiles.map((p) => p.parsed))

          // All unique accounts across all files (first file's name wins,
          // same as the merge's account union).
          const allAccounts = merged.accounts
            .filter(a => !isSystemAccount(a.number))
            .map(a => ({ number: a.number, name: a.name }))

          // Load existing user mappings
          const existingMappings = await loadMappings(supabase, companyId)
          const existingRecords = [...existingMappings.values()].map(m => ({
            id: '',
            user_id: user.id,
            source_account: m.sourceAccount,
            source_name: m.sourceName,
            target_account: m.targetAccount,
            confidence: m.confidence,
            match_type: m.matchType,
            created_at: '',
            updated_at: '',
          }))

          // Suggest mappings
          const basAccounts = BAS_REFERENCE.map(b => ({
            account_number: b.account_number,
            account_name: b.account_name,
          }))
          const mappings = suggestMappings(allAccounts, basAccounts, existingRecords)
          const mappingStats = getMappingStats(mappings)

          log.info(`Account mapping: ${allAccounts.length} unique accounts across ${sieFiles.length} files, ${mappingStats.unmapped} unmapped`)

          const preview = generateImportPreview(merged, mappings)

          // Detect prior imports by *fiscal period overlap*, not file hash.
          // Providers embed the export-time #GEN date in every SIE export so
          // the hash always changes between syncs; only the period stays
          // stable. A re-sync replaces the prior import for the same period.
          const fileStatuses: {
            fiscalYear: number
            rawContent: string
            previousImport: {
              importedAt: string | null
              fiscalYearStart: string | null
              fiscalYearEnd: string | null
            } | null
          }[] = []
          for (const { file, parsed: fileParsed } of parsedFiles) {
            const fyStart = fileParsed.stats.fiscalYearStart
            const fyEnd = fileParsed.stats.fiscalYearEnd

            let priorImport: {
              imported_at: string | null
              fiscal_year_start: string | null
              fiscal_year_end: string | null
            } | null = null

            if (fyStart && fyEnd) {
              // Newest first: several completed rows can overlap the same
              // year (manual upload + provider sync, or residue from
              // partially deleted data). The unordered .limit(1) this
              // replaces picked an arbitrary row, so the wizard could show
              // a stale "ersätter tidigare import från <date>" (issue #1667).
              // Import-time replace resolves ALL rows regardless of which
              // one is displayed here.
              const overlapping = await findOverlappingPeriodImports(
                supabase, companyId, fyStart, fyEnd
              )
              priorImport = overlapping[0] ?? null
            }

            fileStatuses.push({
              fiscalYear: file.fiscalYear,
              rawContent: file.rawContent,
              previousImport: priorImport
                ? {
                    importedAt: priorImport.imported_at,
                    fiscalYearStart: priorImport.fiscal_year_start,
                    fiscalYearEnd: priorImport.fiscal_year_end,
                  }
                : null,
            })
          }

          const replacedFileCount = fileStatuses.filter(f => f.previousImport).length

          return NextResponse.json({
            // The merged whole-dataset parse: SIEData.parsed feeds the
            // migration theater (buildTheaterModel), which must see every
            // fiscal year, not just the newest file.
            parsed: merged,
            mappings,
            mappingStats,
            preview,
            validation,
            rawContent: fileStatuses.map(f => f.rawContent),
            fileStatuses: fileStatuses.map(f => ({
              fiscalYear: f.fiscalYear,
              previousImport: f.previousImport,
              // Back-compat for older wizard builds: an `alreadyImported`
              // boolean. The new wizard reads `previousImport` directly.
              alreadyImported: !!f.previousImport,
              importedAt: f.previousImport?.importedAt ?? null,
            })),
            allImported: false,
            newFileCount: fileStatuses.length - replacedFileCount,
            replacedFileCount,
            // Allowed years whose provider export failed: the wizard warns
            // the user before proceeding so an IB/UB gap cannot slip through.
            failedYears,
            basAccounts: BAS_REFERENCE,
          })
        } catch (error) {
          log.error('arcim sie-data fetch failed', error as Error)
          const classified = classifyProviderError(error)
          return errorResponseFromCode(classified ?? 'PROVIDER_SIE_FETCH_FAILED', moduleLog, {
            details: {
              reason: error instanceof Error ? error.message : 'unknown',
              classified: classified ?? 'unclassified',
            },
          })
        }
      },
    },

    // ── Import SIE data (accounts, balances, vouchers) ────────────
    {
      method: 'POST',
      path: '/import-sie',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id

        const { rawContent, mappings, options } = await request.json() as {
          rawContent: string
          mappings: import('@/lib/import/types').AccountMapping[]
          options: {
            createFiscalPeriod: boolean
            importOpeningBalances: boolean
            importTransactions: boolean
            voucherSeries?: string
            updateAccountNames?: boolean
          }
        }

        if (!rawContent || !mappings) {
          return NextResponse.json({ error: 'rawContent and mappings are required' }, { status: 400 })
        }

        try {
          const parsed = parseSIEFile(rawContent)

          // Mojibake tripwire (warn, never block). This handler receives SIE
          // as an ALREADY-DECODED string, so an upstream that decoded CP437
          // bytes as windows-1252 has baked the corruption in before we ever
          // see it (the retired Arcim Sync gateway did exactly that on
          // 2026-03-17). Flag the signature so it can never again land
          // silently in posted entries; the import itself proceeds untouched.
          const artifactScan = scanSieForCp1252Artifacts(parsed)
          if (artifactScan.flagged) {
            log.warn('import-sie: CP1252 mojibake artifacts in SIE text', {
              artifactCount: artifactScan.artifactCount,
              samples: artifactScan.samples,
            })
          }

          // Validate all accounts are mapped (same as manual upload)
          const unmapped = mappings.filter((m: import('@/lib/import/types').AccountMapping) => !m.targetAccount)
          if (unmapped.length > 0) {
            return NextResponse.json({
              error: 'validation',
              message: `${unmapped.length} account(s) are not mapped`,
              unmappedAccounts: unmapped.map((m: import('@/lib/import/types').AccountMapping) => ({
                account: m.sourceAccount,
                name: m.sourceName,
              })),
            }, { status: 400 })
          }

          // Account creation (and #KONTO renames) happen inside
          // executeSIEImport via syncMappedAccounts: the auto-activate block
          // that used to live here was a duplicate of that logic. Mapping
          // persistence ALSO happens inside executeSIEImport, with the
          // correct companyId + userId and non-fatal warning handling: the
          // direct saveMappings call that used to sit here passed user.id in
          // the companyId slot, which throws on RLS/FK now that the helper
          // surfaces upsert failures, 500ing every provider-migration import
          // before a single voucher was written. Do not re-add it.
          const result = await executeSIEImport(supabase, companyId, user.id, parsed, mappings, {
            filename: `migration-sie-${Date.now()}.se`,
            fileContent: rawContent,
            createFiscalPeriod: options.createFiscalPeriod,
            importOpeningBalances: options.importOpeningBalances,
            importTransactions: options.importTransactions,
            voucherSeries: options.voucherSeries,
            // Default ON: re-syncs keep account names current with the source
            // system (idempotent: equal names are a no-op in the rename pass).
            updateAccountNames: options.updateAccountNames ?? true,
            // Provider re-sync semantics: a prior completed import for the
            // same fiscal year is automatically replaced (its imported
            // entries are cancelled) so the user can pull updated data
            // without manual cleanup. Manual SIE upload keeps default
            // 'block' behavior.
            onExistingPeriod: 'replace',
          })

          // Surface the tripwire on the result the workspace UI already
          // renders (its "Remaining warnings" card shows result.warnings).
          if (artifactScan.flagged) {
            result.warnings.push(formatSieArtifactWarning(artifactScan))
          }

          log.info('SIE import completed:', {
            success: result.success,
            journalEntriesCreated: result.journalEntriesCreated,
            errors: result.errors.length,
            errorDetails: result.errors.slice(0, 10),
          })

          return NextResponse.json(result)
        } catch (error) {
          log.error('arcim sie import failed', error as Error)
          const classified = classifyProviderError(error)
          return errorResponseFromCode(classified ?? 'SIE_IMPORT_UNEXPECTED', moduleLog, {
            details: {
              reason: error instanceof Error ? error.message : 'unknown',
              classified: classified ?? 'unclassified',
            },
          })
        }
      },
    },

    // ── Execute entity migration (customers, suppliers, invoices) ──
    {
      method: 'POST',
      path: '/migrate',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id

        const {
          consentId,
          importCompanyInfo = true,
          importCustomers = true,
          importSuppliers = true,
          importSalesInvoices = true,
          importSupplierInvoices = true,
          reconcileVouchers = true,
        } = await request.json() as {
          consentId: string
          importCompanyInfo?: boolean
          importCustomers?: boolean
          importSuppliers?: boolean
          importSalesInvoices?: boolean
          importSupplierInvoices?: boolean
          reconcileVouchers?: boolean
        }

        if (!consentId) {
          return NextResponse.json({ error: 'consentId is required' }, { status: 400 })
        }

        try {
          // Company-scoped read: the status below is returned to the caller, so
          // an unscoped lookup would let any authenticated user probe another
          // tenant's consent id for existence and connection state. A foreign
          // consent throws ConsentNotFoundError, same as a nonexistent one.
          const consent = await getConsent(consentId, companyId)
          if (consent.status !== 0 && consent.status !== 1) {
            return errorResponseFromCode('PROVIDER_CONSENT_NOT_READY', moduleLog, {
              details: { consentId, status: consent.status },
            })
          }

          // ── Guard: a completed SIE import is required before entity import ──
          // Most providers expose ONLY entity data (customers, suppliers,
          // invoices) via API: never the general ledger. Fortnox pulls the GL
          // itself via SIE-over-API and is exempt. Briox and Björn Lundén also
          // serve SIE over the API, but the wizard runs /import-sie before
          // /migrate, so this guard stays satisfied, and keeps protecting
          // against a skipped SIE step. Importing entities without the
          // SIE-derived ledger (kontoplan,
          // ingående balanser, verifikationer) would leave an incomplete
          // bokföring under BFL: a subledger with no chart of accounts and no
          // opening balances, so every subsequent posting and balance is wrong.
          // The wizard surfaces this as an advisory banner, but it must be
          // enforced here so the rule cannot be bypassed by a direct API call,
          // a skipped wizard step, or a stale client.
          if (consent.provider !== 'fortnox') {
            const { count: completedSieImports } = await supabase
              .from('sie_imports')
              .select('id', { count: 'exact', head: true })
              .eq('company_id', companyId)
              .eq('status', 'completed')

            if (!completedSieImports || completedSieImports < 1) {
              return errorResponseFromCode('PROVIDER_SIE_IMPORT_REQUIRED', moduleLog, {
                details: { provider: consent.provider },
              })
            }
          }

          log.info(`Starting migration for user ${user.id} from ${consent.provider}`)

          const migrationOptions = {
            consentId,
            companyId,
            userId: user.id,
            supabase,
            importCompanyInfo,
            importCustomers,
            importSuppliers,
            importSalesInvoices,
            importSupplierInvoices,
            reconcileVouchers,
          }

          // Streaming mode (the migration wizard opts in via Accept): one
          // NDJSON line per orchestrator progress event, then a terminal
          // `done` or `error` line. Errors after the stream opens cannot
          // change the HTTP status, so the terminal `error` line carries the
          // same structured envelope the JSON path answers with. Callers
          // without the Accept header keep the original JSON contract.
          if ((request.headers.get('accept') ?? '').includes('application/x-ndjson')) {
            const encoder = new TextEncoder()
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                const send = (event: Record<string, unknown>) => {
                  try {
                    controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
                  } catch {
                    // Reader cancelled (tab closed, navigation). The migration
                    // keeps running server-side; we just stop narrating.
                  }
                }
                try {
                  const results = await executeMigration({
                    ...migrationOptions,
                    onProgress: (p) => send({
                      kind: 'progress',
                      status: p.status,
                      currentStep: p.currentStep,
                      progress: p.progress,
                    }),
                  })
                  log.info('Migration completed:', results)
                  // Mark consent as fully accepted now that data has been imported
                  await acceptConsent(consentId)
                  send({ kind: 'done', success: true, results })
                } catch (error) {
                  log.error('arcim migration failed', error as Error)
                  const envelope = await migrateFailureResponse(error, consentId).json()
                  send({ kind: 'error', ...envelope })
                } finally {
                  try {
                    controller.close()
                  } catch {
                    // Already closed because the reader cancelled; close()
                    // would otherwise reject start() as an unhandled rejection.
                  }
                }
              },
            })
            return new Response(stream, {
              headers: {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Accel-Buffering': 'no',
              },
            })
          }

          const results = await executeMigration(migrationOptions)

          log.info('Migration completed:', results)

          // Mark consent as fully accepted now that data has been imported
          await acceptConsent(consentId)

          return NextResponse.json({ success: true, results })
        } catch (error) {
          log.error('arcim migration failed', error as Error)
          return migrateFailureResponse(error, consentId)
        }
      },
    },

    // ── Reconcile supplier invoices to GL payment vouchers ────────
    // Re-runnable maintenance endpoint. The migration runs this automatically as
    // its final step, but SIE (the GL) and entity import are two separate HTTP
    // requests whose order is UI-driven: so if the GL lands after the entity
    // import, or a company was migrated before this feature existed, call this to
    // auto-link settled supplier invoices to their existing vouchers. Pass
    // { dryRun: true } to preview the plan (incl. items needing manual review)
    // without writing.
    {
      method: 'POST',
      path: '/reconcile',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id

        let dryRun = false
        try {
          const body = (await request.json()) as { dryRun?: boolean }
          dryRun = body?.dryRun === true
        } catch {
          // empty body is fine: default to a real run
        }

        try {
          const result = await reconcileSupplierInvoiceVouchers({
            supabase,
            companyId,
            userId: user.id,
            dryRun,
          })
          log.info('arcim reconcile completed', {
            companyId,
            dryRun,
            autoLinked: result.autoLinked,
            ambiguous: result.ambiguous,
            unmatched: result.unmatched,
          })
          return NextResponse.json({ success: true, dryRun, result })
        } catch (error) {
          log.error('arcim reconcile failed', error as Error)
          return errorResponseFromCode('PROVIDER_MIGRATE_FAILED', moduleLog, {
            details: { reason: error instanceof Error ? error.message : 'unknown' },
          })
        }
      },
    },

    // ── Import provider underlag (receipts) and link to verifikat ──
    // Best-effort, re-runnable. Kept off the migration's critical path because
    // the Bokio and Fortnox APIs are rate-limited and a full receipt sweep can
    // issue hundreds of download calls. Resolves each receipt's verifikat via
    // the SIE-preserved provider voucher number and archives it idempotently.
    // Fortnox consents need archive and connectfile scopes. Pass
    // { dryRun: true } to preview the match plan without downloading or writing.
    {
      method: 'POST',
      path: '/import-documents',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id

        let consentId: string | undefined
        let dryRun = false
        let cursor = 0
        try {
          const body = (await request.json()) as {
            consentId?: string
            dryRun?: boolean
            cursor?: number
          }
          consentId = body?.consentId
          dryRun = body?.dryRun === true
          // Resume point from a previous partial call (see import-documents.ts);
          // anything but a non-negative integer restarts from the top, which
          // is always safe: already-archived receipts are skipped by hash.
          cursor =
            typeof body?.cursor === 'number' && Number.isInteger(body.cursor) && body.cursor >= 0
              ? body.cursor
              : 0
        } catch {
          // empty/invalid body: consentId check below rejects it
        }

        if (!consentId) {
          return NextResponse.json({ error: 'consentId is required' }, { status: 400 })
        }

        try {
          const result = await importProviderDocuments({
            supabase,
            companyId,
            userId: user.id,
            consentId,
            dryRun,
            cursor,
          })
          log.info('arcim import-documents completed', {
            companyId,
            dryRun,
            cursor,
            total: result.total,
            scanned: result.scanned,
            linked: result.linked,
            skipped: result.skipped,
            unmatched: result.unmatched,
            failed: result.failed,
            partial: result.partial,
            nextCursor: result.nextCursor,
          })
          return NextResponse.json({ success: true, dryRun, result })
        } catch (error) {
          // "400 Bad Request" alone told us nothing when a live Fortnox
          // discovery failed (2026-08-20): keep status, Fortnox's own
          // message and a body excerpt in the log, and hand the message
          // to the UI so the user sees what the source system said.
          const providerStatus = error instanceof FortnoxApiError ? error.statusCode : undefined
          const providerMessage = fortnoxErrorMessage(error)
          log.error('arcim import-documents failed', error as Error, {
            providerStatus,
            providerMessage,
            providerBody:
              error instanceof FortnoxApiError ? error.body?.slice(0, 500) : undefined,
          })
          if (error instanceof FortnoxDocumentScopesRequiredError) {
            // Reconnecting only helps once the connect request actually asks
            // for Arkiv and Koppla fil. While it does not, say so plainly
            // instead of sending the user around a loop that cannot succeed.
            return errorResponseFromCode(
              FORTNOX_DOCUMENT_SCOPES_APPROVED
                ? 'PROVIDER_DOCUMENT_SCOPES_REQUIRED'
                : 'PROVIDER_DOCUMENT_SCOPES_UNAVAILABLE',
              moduleLog,
              { status: 403 },
            )
          }
          return errorResponseFromCode('PROVIDER_IMPORT_DOCUMENTS_FAILED', moduleLog, {
            details: {
              reason: error instanceof Error ? error.message : 'unknown',
              ...(providerStatus ? { providerStatus } : {}),
              ...(providerMessage ? { providerMessage } : {}),
            },
          })
        }
      },
    },

    // ── Accept consent (mark as fully connected after import) ─────
    {
      method: 'POST',
      path: '/accept',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id
        const { consentId } = await request.json() as { consentId: string }
        if (!consentId) {
          return NextResponse.json({ error: 'consentId is required' }, { status: 400 })
        }

        // Verify consent belongs to this company before mutating
        const { data: consent } = await supabase
          .from('provider_consents')
          .select('id')
          .eq('id', consentId)
          .eq('company_id', companyId)
          .single()

        if (!consent) {
          return errorResponseFromCode('PROVIDER_CONSENT_NOT_FOUND', moduleLog)
        }

        try {
          await acceptConsent(consentId)
          return NextResponse.json({ success: true })
        } catch (error) {
          moduleLog.error('arcim accept failed', error as Error, { consentId })
          return errorResponseFromCode('PROVIDER_ACCEPT_FAILED', moduleLog, {
            details: { reason: error instanceof Error ? error.message : 'unknown' },
          })
        }
      },
    },

    // ── Disconnect / revoke consent ───────────────────────────────
    {
      method: 'DELETE',
      path: '/disconnect',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        const log = ctx?.log ?? console
        const supabase = ctx?.supabase ?? await (await import('@/lib/supabase/server')).createClient()
        const { data: { user } } = await supabase.auth.getUser()

        if (!user) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const companyId = ctx?.companyId ?? user.id
        const { consentId } = await request.json() as { consentId: string }

        if (!consentId) {
          return NextResponse.json({ error: 'consentId is required' }, { status: 400 })
        }

        // Verify consent belongs to this company before mutating
        const { data: consent } = await supabase
          .from('provider_consents')
          .select('id')
          .eq('id', consentId)
          .eq('company_id', companyId)
          .single()

        if (!consent) {
          return errorResponseFromCode('PROVIDER_CONSENT_NOT_FOUND', moduleLog)
        }

        try {
          await deleteConsent(consentId)

          if (ctx?.settings) {
            await ctx.settings.clear('consent_id')
            await ctx.settings.clear('provider')
          }

          return NextResponse.json({ success: true })
        } catch (error) {
          log.error('arcim disconnect failed', error as Error, { consentId })
          return errorResponseFromCode('PROVIDER_DISCONNECT_FAILED', moduleLog, {
            details: { reason: error instanceof Error ? error.message : 'unknown' },
          })
        }
      },
    },
  ],

  eventHandlers: [],
}
