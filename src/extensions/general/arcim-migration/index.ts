import { migrationJobRoutes } from './lib/migration-job-routes'
import { invoiceCompletionRoutes } from './lib/invoice-completion-routes'
import { deductionBackfillRoutes } from './lib/deduction-backfill-routes'
import { companyMismatchMessages } from './lib/company-mismatch-message'
import { archiveSIEIntakeText, readSIEIntakeFile, SIEArchiveUnavailableError } from '@/lib/import/sie-intake'
import { buildTheaterModel } from '@/lib/import/theater-model'
import { submitSIEJob } from '@/lib/import/sie-jobs'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { after, NextResponse } from 'next/server'
import {
  createConsent,
  getConsent,
  listConsents,
  generateOtc,
  consumeOAuthState,
  peekOAuthState,
  oauthStateRejectionReason,
  moveOpenLogins,
  consentHoldsTokens,
  mintHandoff,
  consumeHandoff,
  getAuthUrl,
  exchangeAuthToken,
  submitProviderToken,
  acceptConsent,
  deleteConsent,
  resolveConsent,
  fetchCompanyInfoDirect,
  fetchAccountingAccountsDirect,
  ProviderTokenInvalidError,
  ProviderCompanyMismatchError,
  ConsentNotFoundError,
} from './lib/provider-client'
import {
  providerSupportsSie,
  fetchProviderSieFiles,
  getAllowedFiscalYears,
  classifySieFetchFailure,
  FiscalYearSelectionError,
  MAX_SELECTED_FISCAL_YEARS,
  type SieFetchFailure,
  type SourceFiscalYear,
} from './lib/sie-fetcher'
import { mapCompanyInfo } from './lib/entity-mapper'
import { executeMigration } from './lib/migration-orchestrator'
import {
  FortnoxDocumentScopesRequiredError,
  ProviderConnectionRefusedError,
  importProviderDocuments,
} from './lib/import-documents'
import {
  continuationCursor,
  documentImportDrivenByServer,
  documentImportRunFacts,
  documentImportRunStatus,
  documentImportRunStillCurrent,
  readDocumentImportRun,
  recordDocumentImportNeedsReconnect,
  recordDocumentImportSlice,
  type DocumentImportRunSummary,
} from './lib/document-import-run'
import { fetchFortnoxAssetPreview } from './lib/import-assets'
import { countUnderlagOnReplacedCopies } from './lib/replaced-copy-underlag'
import { supportsUnderlagImport } from '@/lib/providers/underlag-import'
import { reconcileSupplierInvoiceVouchers } from '@/lib/invoices/bulk-reconcile-supplier-vouchers'
import { relinkRegistrationVouchers } from './lib/relink-registration-vouchers'
import { refreshMigratedSupplierPaymentState } from './lib/refresh-migrated-payment-state'
import { completeBokioSupplierInvoices } from './lib/complete-bokio-supplier-invoices'
import type { ArcimProvider } from './types'
import { ARCIM_PROVIDERS } from './types'
import { parseSIEFile, validateSIEFile } from '@/lib/import/sie-parser'
import { mergeParsedSIEFiles } from '@/lib/import/sie-merge'
import { scanSieForCp1252Artifacts, formatSieArtifactWarning } from '@/lib/import/sie-artifact-scan'
import { getMappingStats } from '@/lib/import/account-mapper'
import { suggestSIEMappings } from '@/lib/import/sie-preview-mappings'
import { sieAccountsOfferedForMapping } from '@/lib/import/sie-amounts-without-target'
import { applySourceVatCodes } from '@/lib/import/account-vat-treatment'
import { fortnoxVatCodeToTreatment } from '@/lib/providers/fortnox/vat-codes'
import { loadMappings, generateImportPreview, findOverlappingPeriodImports } from '@/lib/import/sie-import'
import { buildMappingTargets } from './lib/mapping-targets'
import type { ProviderName } from '@/lib/providers/types'
import { missingTokenCredential } from '@/lib/providers/catalog'
import type { ProviderPreviewCounts } from '@/lib/providers/preview-counts'
import { FORTNOX_DOCUMENT_SCOPES_APPROVED } from '@/lib/providers/fortnox/oauth'
import {
  buildLundifyActivationUrl,
  getBjornLundenActivationKey,
} from '@/lib/providers/bjornlunden/activation'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { userFacingCode } from '@/lib/errors/user-facing'
import { SIEIntakeNotFoundError, SIEIntakePathError, SIEJobDatabaseError, SIEJobValidationError } from '@/lib/import/sie-jobs'
import { sieJobValidationResponse } from '@/lib/import/sie-job-validation-response'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import {
  requireFlowInitiator,
  FLOW_INITIATOR_MISMATCH_MESSAGE,
} from '@/lib/auth/oauth-flow-binding'
import {
  classifyProviderError,
  fortnoxLoginLicenceRefusal,
  isMissingLicenseError,
  ProviderCallError,
  subscriptionRefusal,
} from '@/lib/providers/with-provider-call'
import { getProviderResourceForbiddenMessage } from '@/lib/errors/get-error-message'
import { FortnoxApiError, fortnoxErrorMessage } from '@/lib/providers/fortnox/client'
import { createLogger } from '@/lib/logger'
import { requestCspNonce } from '@/lib/security/csp'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { findUnfinishedConnect } from '@/lib/providers/unfinished-connect'
import { providerKeyUse, readProviderKeyUseFacts } from './lib/key-use'
import { whereSieImportInPlace } from '@/lib/bookkeeping/sie-import-in-place'

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
 * A valid state reached the callback but the browser carries no session. A
 * callback with a code has already spent the state by then (consumeOAuthState
 * is atomic and runs first), and a cancelled one carries nothing to finish, so
 * unlike the bank/Stripe callbacks there is nothing to resume after a login:
 * the user starts the connect again from the wizard.
 */
const SESSION_MISSING_MESSAGE =
  'Ingen inloggad session hittades i det här fönstret. Logga in och starta om anslutningen.'

/**
 * access_denied: the customer pressed cancel in the provider's consent screen.
 * The callback flags it (`cancelled`) so the wizard can count a cancel apart
 * from a provider error. Matched on this sentence because the white-label
 * handoff carries only the translated text across the hop.
 */
const OAUTH_CANCELLED_MESSAGE =
  'Du avbröt anslutningen i leverantörens inloggning. Försök igen om du vill koppla kontot.'

/**
 * Fortnox's error_missing_license on a first connect: the Fortnox company the
 * customer logged in to lacks the licence a requested scope needs. A first
 * connect asks for bokföring, kunder, leverantörer and fakturor, which
 * Fortnox's scope table ties to Bokföring and to Kundfaktura or Order. Two
 * customers met it on 2026-11-12; both connected within minutes by logging in
 * again.
 */
const FORTNOX_SCOPE_LICENCE_MESSAGE =
  'Fortnox nekade anslutningen: Fortnox-företaget du loggade in på saknar licens för något som Accounted läser vid flytten. ' +
  'Flytten läser bokföring, kunder, leverantörer och fakturor och kräver licenserna Bokföring och Kundfaktura (eller Order) i Fortnox. ' +
  'Har du flera företag i Fortnox: anslut igen och välj det företag som ska flyttas. ' +
  'Saknar företaget licenserna kan du flytta bokföringen med SIE-filer i stället.'

/**
 * The same refusal on a login that renews a connection the company already
 * has (an expired token, or Hämta underlag asking for Fortnox's archive too).
 * The callback cannot tell which scopes the login asked for, so it names none;
 * nothing was exchanged, so the existing connection stands.
 */
const FORTNOX_SCOPE_LICENCE_RECONNECT_MESSAGE =
  'Fortnox nekade inloggningen: Fortnox-företaget saknar licens för något som Accounted bad om att få läsa. ' +
  'Anslutningen du redan har påverkas inte. ' +
  'Har du flera företag i Fortnox: försök igen och välj samma företag som förut. ' +
  'Annars: kontrollera företagets licenser i Fortnox och försök igen.'

/**
 * Map known OAuth error codes from providers (Fortnox, Visma) to actionable
 * Swedish guidance. Falls back to the raw provider message so we never hide
 * unknown errors from the user. `consentId` is the consent the state was
 * minted for, read from the state row, never from the query.
 */
async function translateOAuthError(error: string, description: string | null, consentId: string): Promise<string> {
  // Licence refusals are read where every other provider refusal is
  // (with-provider-call.ts), not by substrings of their own here.
  const licence = fortnoxLoginLicenceRefusal(error)
  if (licence === 'scope') {
    return (await consentHoldsTokens(consentId)) ? FORTNOX_SCOPE_LICENCE_RECONNECT_MESSAGE : FORTNOX_SCOPE_LICENCE_MESSAGE
  }
  if (licence === 'app' || isMissingLicenseError(`${error} ${description ?? ''}`)) {
    return 'Du behöver aktivera tilläggstjänsten "Fortnox Integration" (~149 kr/mån) på ditt Fortnox-konto innan du kan ansluta. Aktivera den under Inställningar → Tilläggstjänster i Fortnox och försök igen.'
  }

  if (error === 'access_denied') {
    return OAUTH_CANCELLED_MESSAGE
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

function requestOrigin(request: Request): string {
  const url = new URL(request.url)
  const host = request.headers.get('host') ?? url.host
  try {
    const candidate = new URL(`${url.protocol}//${host}`)
    if (candidate.host !== host.toLowerCase() || candidate.pathname !== '/' || candidate.search || candidate.hash) {
      return url.origin
    }
    return candidate.origin
  } catch {
    return url.origin
  }
}

async function resolveOAuthOrigin(request: Request): Promise<string> {
  const origin = requestOrigin(request)
  const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL || request.url).origin
  if (origin === appOrigin) return appOrigin
  const url = new URL(origin)
  // Brand domains are HTTPS origins. A hostname lookup must not authorize an
  // arbitrary port or a downgrade to HTTP on the same host.
  if (url.protocol !== 'https:' || url.port) return appOrigin
  const brand = await resolveBrandByHost(url.host)
  return brand && new URL(`https://${brand.domain}`).origin === origin ? origin : appOrigin
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
  initiatedByUserId: string,
  origin: string,
  options?: { documentScopes?: boolean },
): Promise<string> {
  // Server-side state row: consent id, provider (via the consent), the user who
  // started the flow, expiry and a consumed marker all live in provider_otc.
  // The `state` handed to the provider is that row's opaque random primary
  // key, nothing more.
  const otc = await generateOtc(consentId, initiatedByUserId, origin)

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
 * Lundify activation URL for a Björn Lundén consent, or null when BL has not
 * issued this install an activation key (self-hosted, or a listing that is
 * not released). Same state row as the OAuth providers: Lundify echoes the
 * code back as `extra`, and the callback resolves the consent from that row
 * exactly as it resolves an OAuth `state`. The manual User-Key field stays
 * next to the button, so a customer who activated inside Lundify already can
 * still paste the key.
 */
async function buildBjornLundenActivationUrl(
  consentId: string,
  initiatedByUserId: string,
  origin: string,
): Promise<string | null> {
  const activationKey = getBjornLundenActivationKey()
  if (!activationKey) return null
  const otc = await generateOtc(consentId, initiatedByUserId, origin)
  return buildLundifyActivationUrl(activationKey, resolveArcimCallbackUrl('bjornlunden'), otc.code)
}

/**
 * Answer a failed provider call with its classified code, falling back to the
 * caller's own code when the failure is not provider-shaped.
 *
 * PROVIDER_RESOURCE_FORBIDDEN carries its message here instead of from the
 * shared registry: the useful half is the provider's own sentence naming the
 * register it refused ("Saknar behörighet för leverantörsregister."), which
 * only the error itself holds. Without the override the code would fall
 * through entryFor() to INTERNAL_ERROR and answer 500.
 */
function providerFailureResponse(error: unknown, fallbackCode: string): NextResponse {
  const classified = classifyProviderError(error)
  const ctx = {
    details: {
      reason: error instanceof Error ? error.message : 'unknown',
      classified: classified ?? 'unclassified',
    },
  }
  if (classified === 'PROVIDER_RESOURCE_FORBIDDEN') {
    const reason = fortnoxErrorMessage(error)
    return errorResponseFromCode(classified, moduleLog, {
      ...ctx,
      status: 403,
      messageSv: getProviderResourceForbiddenMessage(reason, 'sv'),
      messageEn: getProviderResourceForbiddenMessage(reason, 'en'),
    })
  }
  return errorResponseFromCode(classified ?? fallbackCode, moduleLog, ctx)
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
  return providerFailureResponse(error, 'PROVIDER_MIGRATE_FAILED')
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
    ...migrationJobRoutes,
    ...invoiceCompletionRoutes,
    ...deductionBackfillRoutes,
    // ── Check existing connections and import history ──────────────
    {
      method: 'GET',
      path: '/status',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const supabase = ctx.supabase

        const companyId = ctx.companyId

        try {
          // Get accepted consents only (status 1): not abandoned/created ones
          const allConsents = await listConsents(companyId)
          const consents = allConsents.filter(c => c.status === 1)

          // Get SIE import history
          const SIE_IMPORT_COLUMNS = 'id, filename, status, accounts_count, transactions_count, company_name, fiscal_year_start, fiscal_year_end, imported_at, created_at'
          const { data: sieImports } = await supabase
            .from('sie_imports')
            .select(SIE_IMPORT_COLUMNS)
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(10)

          // The history above is for display. Whether a completed import
          // EXISTS is asked on its own: failed and replaced rows can push the
          // completed one out of the newest-10 window, and the wizard then
          // gated Visma/Bokio behind "SIE krävs först" for a company that had
          // imported. Same predicate as the /migrate guard.
          const { data: latestCompletedSieImport } = await whereSieImportInPlace(
            supabase
              .from('sie_imports')
              .select(SIE_IMPORT_COLUMNS)
              .eq('company_id', companyId),
          )
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          // Get entity counts (to show what's already been imported), and the
          // latest connect that never got a token so the wizard can offer to
          // resume it (service client: provider_consent_tokens has no user
          // policy).
          const { createServiceClient } = await import('@/lib/supabase/server')
          const service = createServiceClient()
          const [
            { count: customerCount },
            { count: supplierCount },
            { count: invoiceCount },
            unfinishedConnect,
          ] = await Promise.all([
            supabase.from('customers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
            supabase.from('suppliers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
            supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
            findUnfinishedConnect(service, companyId),
          ])
          // Whether each stored key still has work to do, so a finished
          // migration can say the key is no longer used and offer to remove
          // it (crm#1476). Display only: a failed read says nothing.
          const keyUseFacts = consents.length > 0
            ? await readProviderKeyUseFacts(service, companyId, {
              hasCompletedSieImport: latestCompletedSieImport != null,
              importedRecords: (customerCount ?? 0) + (supplierCount ?? 0) + (invoiceCount ?? 0),
              newestConsentId: consents[0]?.id ?? null,
            }).catch((error: unknown) => {
              moduleLog.warn('provider key use unavailable', {
                companyId,
                error: error instanceof Error ? error.message : String(error),
              })
              return null
            })
            : null
          // What the latest underlag run found, linked and left, so the
          // connections list can answer "did everything come in?" after a
          // reload (crm#1410). Display only: a failed read shows nothing.
          const latestDocumentRun = ctx.settings
            ? await readDocumentImportRun(ctx.settings).catch(() => null)
            : null
          // Whether the server picks a silent run up again reads the same
          // facts its worker does: the run's connection and the latest ledger
          // import (document-import-continuation.ts).
          const latestDocumentImport = latestDocumentRun
            ? documentImportRunStatus(
              latestDocumentRun,
              Date.now(),
              documentImportRunFacts(
                latestDocumentRun,
                consents.map(c => ({ id: c.id, provider: c.provider as string, createdAt: c.createdAt ?? null })),
                latestCompletedSieImport ?? null,
              ),
            )
            : null
          // Verifikat whose underlag an earlier run left on the copy a re-run
          // migration then reversed (#51): the page offers "Hämta underlag"
          // again, which links them to the live copy. Asked only where that
          // run can go: a ledger import and a connection that serves underlag.
          const underlagOnReplacedCopies =
            latestCompletedSieImport && consents.some(c => supportsUnderlagImport(c.provider as string))
              ? await countUnderlagOnReplacedCopies(supabase, companyId)
              : 0

          return NextResponse.json({
            consents: consents.map(c => ({
              id: c.id,
              provider: c.provider,
              status: c.status,
              companyName: c.companyName,
              createdAt: c.createdAt,
              ...(keyUseFacts && { keyUse: providerKeyUse(c.id, keyUseFacts) }),
            })),
            sieImports: sieImports ?? [],
            hasCompletedSieImport: latestCompletedSieImport != null,
            latestCompletedSieImport: latestCompletedSieImport ?? null,
            unfinishedConnect,
            latestDocumentImport,
            underlagOnReplacedCopies,
            entityCounts: {
              customers: customerCount ?? 0,
              suppliers: supplierCount ?? 0,
              invoices: invoiceCount ?? 0,
            },
            // The providers this deployment can connect, so the wizard offers
            // no card the /connect gate refuses (WINT ships dark).
            enabledProviders: enabledProviders().map(p => p.id),
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const log = ctx.log
        const companyId = ctx.companyId

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
              if (ctx.settings) {
                await ctx.settings.set('consent_id', stale.id)
                await ctx.settings.set('provider', provider)
              }
              if (providerInfo.authType === 'oauth') {
                const authUrl = await buildArcimOAuthUrl(stale.id, provider, ctx.userId, await resolveOAuthOrigin(request), {
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
              // (Björn Lundén also through Lundify's activation redirect).
              const activationUrl = provider === 'bjornlunden'
                ? await buildBjornLundenActivationUrl(stale.id, ctx.userId, await resolveOAuthOrigin(request))
                : null
              return NextResponse.json({
                consentId: stale.id,
                authType: 'token',
                reconnect: true,
                ...(activationUrl ? { activationUrl } : {}),
              })
            }
            // No existing consent to revive: fall through to a normal connect.
          }

          // Reuse existing accepted consent if one exists for this provider
          const accepted = existingConsents.find(c => c.provider === provider && c.status === 1)

          if (accepted) {
            // Already connected: skip OAuth, go straight to preview
            if (ctx.settings) {
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
                if (ctx.settings) {
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
          }

          // Create new consent
          const consent = await createConsent(
            companyId,
            provider,
            `gnubok-migration-${ctx.userId}`,
            orgNumber,
            companyName
          )

          // The earlier token-less attempts are abandoned and cleaned up. A
          // login still open in another window moves onto this attempt first:
          // deleting its consent took its state with it, and that window then
          // read "ingen giltig migrationssession" whatever the provider had
          // answered (2026-11-12: connect clicked twice, the first window's
          // licence refusal hidden). The new row stays the record of the
          // attempt, started now (findUnfinishedConnect).
          if (pending.length > 0) {
            await moveOpenLogins(pending.map(p => p.id), consent.id)
            for (const p of pending) {
              await deleteConsent(p.id)
            }
          }

          if (ctx.settings) {
            await ctx.settings.set('consent_id', consent.id)
            await ctx.settings.set('provider', provider)
          }

          if (providerInfo.authType === 'oauth') {
            const authUrl = await buildArcimOAuthUrl(consent.id, provider, ctx.userId, await resolveOAuthOrigin(request))

            return NextResponse.json({
              consentId: consent.id,
              authType: 'oauth',
              authUrl,
            })
          } else {
            // Token-based providers: consent is ready for direct use. Björn
            // Lundén additionally gets the Lundify activation URL when BL has
            // issued an activation key, so the User-Key never has to be pasted.
            const activationUrl = provider === 'bjornlunden'
              ? await buildBjornLundenActivationUrl(consent.id, ctx.userId, await resolveOAuthOrigin(request))
              : null
            return NextResponse.json({
              consentId: consent.id,
              authType: 'token',
              ...(activationUrl ? { activationUrl } : {}),
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const log = ctx.log

        // The caller's tenant: NOT the provider-side company id below.
        const ownerCompanyId = ctx.companyId

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

        // The catalog names what each provider needs (BL: the company key
        // only, Accounted holds the client credentials). Both connect forms
        // read the same rule, so neither can ask for something this refuses.
        const missingCredential = missingTokenCredential(provider, { apiToken, companyId: providerCompanyId })
        if (missingCredential === 'secret') {
          return errorResponseFromCode('PROVIDER_TOKEN_REQUIRED', moduleLog, {
            details: { provider },
          })
        }
        if (missingCredential === 'companyId') {
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
          // A verdict on what was pasted is the user's to fix and is answered
          // with its own code below: a warning, not a server error.
          const verdict = error instanceof ProviderTokenInvalidError || error instanceof ProviderCompanyMismatchError
            || error instanceof ConsentNotFoundError
          if (verdict) log.warn('arcim submit-token refused', { provider, err: { name: (error as Error).name, message: (error as Error).message } })
          else log.error('arcim submit-token failed', error as Error, { provider })
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
            if (error.kind === 'company-id-invalid') {
              return errorResponseFromCode('BOKIO_COMPANY_ID_INVALID', moduleLog, {
                details: { provider, reason: error.message },
              })
            }
            // BL: a valid key whose company never activated the integration
            // is not a credentials problem; say what actually unblocks it.
            if (error.kind === 'integration-not-activated') {
              return errorResponseFromCode('BL_INTEGRATION_NOT_ACTIVATED', moduleLog, {
                details: { provider, reason: error.message },
              })
            }
            if (error.kind === 'company-key-not-found') {
              return errorResponseFromCode('BL_COMPANY_KEY_NOT_FOUND', moduleLog, {
                details: { provider, reason: error.message },
              })
            }
            // Bokio: the plan has no API access, so re-pasting the token
            // cannot help; name the plans that include it instead.
            if (error.kind === 'plan-no-api') {
              return errorResponseFromCode('BOKIO_PLAN_NO_API', moduleLog, {
                details: { provider, reason: error.message },
              })
            }
            return errorResponseFromCode('PROVIDER_TOKEN_INVALID', moduleLog, {
              details: { provider, reason: error.message },
            })
          }
          // Valid credentials, wrong company: the message names the company the
          // token opened and how to bring that company in instead.
          if (error instanceof ProviderCompanyMismatchError) {
            const message = companyMismatchMessages(error)
            return errorResponseFromCode('PROVIDER_COMPANY_MISMATCH', moduleLog, {
              messageSv: message.sv,
              messageEn: message.en,
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
      handler: async (request: Request) => {
        const log = console
        const url = new URL(request.url)
        let code = url.searchParams.get('code')
        const handoff = url.searchParams.get('handoff')
        let stateRaw = url.searchParams.get('state')
        // Lundify's activation redirect (Björn Lundén) comes back as
        // `?publicKey={User-Key}&extra={our state}` instead of code/state.
        // Fold it into the OAuth-shaped locals so the atomic state
        // consumption, initiator binding and white-label handoff below run
        // unchanged; only the final exchange step differs.
        const lundifyPublicKey = url.searchParams.get('publicKey')
        const lundifyExtra = url.searchParams.get('extra')
        if (!code && !handoff && lundifyPublicKey && lundifyExtra) {
          code = lundifyPublicKey
          stateRaw = lundifyExtra
        }
        const oauthError = url.searchParams.get('error')
        const oauthErrorDescription = url.searchParams.get('error_description')
        const currentOrigin = requestOrigin(request)
        let responseOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL || request.url).origin

        // JSON-encode for safe embedding inside <script>. Escapes quotes/unicode
        // and `</` so the value can't break out of the script tag.
        const jsLiteral = (value: unknown) =>
          JSON.stringify(value ?? '').replace(/</g, '\\u003c')

        // The proxy's CSP (lib/security/csp.ts) has no 'unsafe-inline': the
        // popup scripts below run only because they carry this request's
        // nonce.
        const scriptNonce = requestCspNonce(request.headers)

        // urlReason: what the no-opener fallback carries in its URL instead,
        // when `reason` names something that must not land in a URL (browser
        // history, request logs, analytics page URLs).
        const respondWithError = (reason: string, consentId?: string, urlReason = reason) => {
          const cancelled = reason === OAUTH_CANCELLED_MESSAGE
          const fallbackUrl = new URL(`${responseOrigin}/import`)
          fallbackUrl.searchParams.set('migration', 'error')
          fallbackUrl.searchParams.set('reason', urlReason)
          if (consentId) fallbackUrl.searchParams.set('consentId', consentId)
          if (cancelled) fallbackUrl.searchParams.set('cancelled', '1')

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
          //
          // location.replace, not href: the callback URL carries a one-time
          // state that a code has already spent, so a Back or a reload onto it
          // can only fail (a cancel leaves the state unspent, and a reload of
          // it repeats the cancel sentence). no-store keeps it out of the
          // browser cache for the same reason.
          const html = `<!DOCTYPE html><html><body><script nonce="${scriptNonce}">
            if (window.opener) {
              window.opener.postMessage({ type: 'arcim-oauth-error', reason: ${jsLiteral(reason)}, cancelled: ${cancelled} }, ${jsLiteral(responseOrigin)});
            } else {
              window.location.replace(${jsLiteral(fallbackUrl.toString())});
            }
          </script><p>Anslutningen misslyckades: ${escapedReason}</p><p>Du kan stänga detta fönster.</p></body></html>`

          return new Response(html, {
            status: 200,
            headers: {
              // charset is required: without it browsers default to Latin-1 and
              // render the Swedish text as mojibake (the "rÃ¤tt behÃ¶righeter" bug).
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer',
            },
          })
        }

        // Provider returned an OAuth error (user cancelled, missing API
        // subscription on the Fortnox side, invalid scope, etc.)
        if (!handoff && oauthError) {
          // access_denied is the user clicking "avbryt" in the provider's
          // consent screen: an expected outcome of an optional flow, so it is
          // logged at warn and stays out of the error panel. Every other
          // provider error is still an error.
          const oauthErrorDetails = {
            error: oauthError,
            errorDescription: oauthErrorDescription,
            hasCode: !!code,
            hasState: !!stateRaw,
          }
          if (oauthError === 'access_denied') {
            log.warn('OAuth callback cancelled by the user at the provider', oauthErrorDetails)
          } else {
            log.error('OAuth callback returned provider error', oauthErrorDetails)
          }
        }

        if (!handoff && ((!code && !oauthError) || !stateRaw)) {
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
          //
          // A provider error without a code (the user pressed cancel) only
          // reads the row: nothing is exchanged, and spending the state on it
          // answered a second delivery of the same cancel with the session
          // error and threw away an approval made after going Back at the
          // provider. A callback with a code still consumes: the state stays
          // one-time for the token exchange.
          const resolvedHandoff = handoff ? await consumeHandoff(handoff, currentOrigin) : null
          const resolvedState = handoff
            ? resolvedHandoff
            : oauthError && !code
              ? await peekOAuthState(stateRaw!)
              : await consumeOAuthState(stateRaw!)

          if (!resolvedState) {
            // Unknown/forged state, expired state, replayed state and deleted
            // consent all end here with the SAME message: this route is
            // unauthenticated, so telling the caller which one it was would
            // disclose whether a given consent exists. The reason goes to the
            // server log only, so a dead state can be sorted afterwards
            // (replay or expiry) once its row is purged.
            log.error('OAuth callback state rejected', {
              hasCode: !!code,
              stateLength: (handoff ?? stateRaw ?? '').length,
              reason: await oauthStateRejectionReason(handoff || stateRaw!),
            })
            return respondWithError(STATE_REJECTED_MESSAGE)
          }

          const { consentId, provider, userId: initiatedByUserId } = resolvedState
          responseOrigin = resolvedState.origin ?? responseOrigin
          const providerError = resolvedHandoff
            ? resolvedHandoff.providerError
            : oauthError ? await translateOAuthError(oauthError, oauthErrorDescription, consentId) : null
          if (resolvedHandoff) code = resolvedHandoff.providerCode

          // The state proves this callback belongs to a flow WE started; it
          // says nothing about who is finishing it. Before the code is
          // exchanged, the completing browser's own session must belong to the
          // user recorded on the state row at connect time. Otherwise a victim
          // lured into approving a consent someone else started has their
          // Fortnox/Visma account bound to that someone's consent, and the
          // next migration imports the victim's ledger into a stranger's
          // company. Checked before callbackConsentId is set: a refused
          // completion must not hand the consent id to whoever is refused.
          if (!initiatedByUserId) {
            // Row minted before provider_otc.user_id existed (or written
            // outside generateOtc): nobody to bind to, so nobody may finish it.
            // Such rows expire within 10 minutes of the deploy.
            log.error('OAuth callback state carries no initiator; refusing', { consentId })
            return respondWithError(STATE_REJECTED_MESSAGE)
          }

          // Hop 1 has no brand-domain session. Only the server-written origin
          // chooses the destination; provider credentials never enter its URL.
          if (!handoff && resolvedState.origin && responseOrigin !== currentOrigin) {
            const next = await mintHandoff(consentId, initiatedByUserId, responseOrigin,
              providerError !== null ? { providerError } : { providerCode: code! })
            const target = new URL('/api/extensions/ext/arcim-migration/callback', responseOrigin)
            target.searchParams.set('handoff', next.code)
            return new Response(null, {
              status: 302,
              headers: {
                Location: target.toString(),
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer',
              },
            })
          }
          const initiator = await requireFlowInitiator(request, initiatedByUserId, {
            flow: 'arcim-migration.callback',
          })
          if (!initiator.ok) {
            log.error('OAuth callback refused: completing session is not the initiator', {
              consentId,
              reason: initiator.reason,
            })
            return respondWithError(
              initiator.reason === 'no_session'
                ? SESSION_MISSING_MESSAGE
                : FLOW_INITIATOR_MISMATCH_MESSAGE,
            )
          }

          callbackConsentId = consentId
          if (providerError !== null) return respondWithError(providerError, consentId)
          if (!code) return respondWithError(STATE_REJECTED_MESSAGE)

          if (provider === 'bjornlunden') {
            // Lundify handed back the company's User-Key. Same probe-then-store
            // path as the manual field (client-credentials token, /details
            // probe, scope verdict), owned by the consent's own company: the
            // consent came from the server-written state row, not the query.
            await submitProviderToken(
              consentId,
              provider,
              'client_credentials',
              code,
              resolvedState.companyId,
            )
          } else {
            // Must match the redirect_uri the authorization request was built
            // with, so both come from resolveArcimCallbackUrl.
            const redirectUri = resolveArcimCallbackUrl(provider)

            // Exchange OAuth code directly with the provider
            await exchangeAuthToken(consentId, provider, code, redirectUri)
          }

          // Return an HTML page that notifies the opener tab and closes itself
          const successUrl = `${responseOrigin}/import?migration=connected&consentId=${encodeURIComponent(consentId)}`
          // location.replace + no-store: see respondWithError above. The state
          // is spent the moment consumeOAuthState returns, and prod caught the
          // consequence of leaving the URL in history: a second delivery 19
          // seconds after a successful connect, answered with a red "ingen
          // giltig migrationssession" about a connection that had just worked.
          const html = `<!DOCTYPE html><html><body><script nonce="${scriptNonce}">
            if (window.opener) {
              window.opener.postMessage({ type: 'arcim-oauth-success', consentId: ${jsLiteral(consentId)} }, ${jsLiteral(responseOrigin)});
              window.close();
            } else {
              window.location.replace(${jsLiteral(successUrl)});
            }
          </script><p>Anslutningen lyckades. Du kan stänga denna flik.</p></body></html>`

          return new Response(html, {
            status: 200,
            headers: {
              // charset is required: without it browsers default to Latin-1 and
              // render the Swedish text as mojibake (the "rÃ¤tt behÃ¶righeter" bug).
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer',
            },
          })
        } catch (error) {
          // Credentials for another company, or a key the provider refused,
          // are answered below with the sentence that says what to do: a
          // warning, not a server error.
          if (error instanceof ProviderCompanyMismatchError || error instanceof ProviderTokenInvalidError) {
            log.warn('OAuth callback exchange refused', (error as Error).name)
          } else {
            log.error('OAuth callback exchange failed', error)
          }
          // Valid tokens for the WRONG company: exchangeAuthToken stored
          // nothing. Show the same Swedish sentence /submit-token answers with
          // for Bokio/WINT (it names the company the login opened) instead of
          // the English diagnostic on the error object. The completing session
          // was checked against the initiator above, so the name goes only to
          // the user who just signed in to that company. The fallback URL gets
          // the registry sentence: an enskild firma's org number is a
          // personnummer, and a URL lands in history, logs and analytics.
          if (error instanceof ProviderCompanyMismatchError) {
            return respondWithError(
              companyMismatchMessages(error).sv,
              callbackConsentId,
              getErrorEntry('PROVIDER_COMPANY_MISMATCH')?.message_sv,
            )
          }
          // Björn Lundén via Lundify: the User-Key probe has the same three
          // verdicts as /submit-token, so show the same registry sentences.
          if (error instanceof ProviderTokenInvalidError) {
            const registryCode = error.kind === 'integration-not-activated'
              ? 'BL_INTEGRATION_NOT_ACTIVATED'
              : error.kind === 'company-key-not-found'
                ? 'BL_COMPANY_KEY_NOT_FOUND'
                : 'PROVIDER_TOKEN_INVALID'
            return respondWithError(
              getErrorEntry(registryCode)?.message_sv ?? error.message,
              callbackConsentId,
            )
          }
          const reason = error instanceof Error ? error.message : 'Okänt fel vid tokenutbyte.'
          return respondWithError(reason, callbackConsentId)
        }
      },
    },

    // ── Preview: fetch company info + SIE stats before migration ──
    {
      method: 'GET',
      path: '/preview',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const log = ctx.log
        const supabase = ctx.supabase

        const companyId = ctx.companyId

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
            if (subscriptionRefusal(err)) throw err
            log.info('Company info fetch failed:', err instanceof Error ? err.message : String(err))
          }

          // Try to fetch SIE data (Fortnox and Briox serve SIE over the API)
          let sieAvailable = false
          let sieStats: ProviderPreviewCounts | null = null
          // Why the SIE fetch failed, in the classification /sie-data and the
          // migration job use. A bare sieAvailable: false read as "SIE-import
          // krävs" in the wizard, so a rate limit, an outage or a missing
          // permission asked for a file the provider can serve (crm#1118).
          // Stays null for Visma and Bokio, which serve no SIE over the API.
          let sieError: SieFetchFailure | null = null
          // Every fiscal year the source has, with the default selection
          // marked: the preview step renders them as the year picker, so the
          // user chooses BEFORE the import runs and no year is left out
          // silently (issues #2211, #2238). The counts below cover only the
          // default years the preview read, and say which (crm#1037).
          let sourceYears: SourceFiscalYear[] = []

          if (providerSupportsSie(provider)) {
            try {
              log.info(`Fetching SIE export from ${provider} for consent ${consentId}...`)
              // Fetch SIE type 4 for every year of the default selection, not
              // just the newest: a mid-year export has few or zero vouchers
              // in the newest year (a migration once previewed
              // "0 verifikationer" and then imported 4153). Costs one SIE
              // export per extra year, the same work /sie-data repeats right
              // after: honest numbers are worth it.
              const { files, sourceYears: source, failedYears } = await fetchProviderSieFiles(
                provider,
                resolved.accessToken,
                resolved.providerCompanyId,
              )
              sourceYears = source
              if (files.length > 0) {
                const merged = mergeParsedSIEFiles(files.map((f) => parseSIEFile(f.rawContent)))
                sieAvailable = true
                sieStats = {
                  accountCount: merged.accounts.length,
                  transactionCount: merged.vouchers.length,
                  // The years these counts were read from, not the default
                  // window: a year whose export failed is in neither. The
                  // wizard shows the counts only while exactly these years
                  // are ticked (previewCountsForSelection, crm#1037).
                  fiscalYears: files.map((f) => f.fiscalYear),
                }
              } else if (failedYears.length > 0) {
                // The year list came back, but no year's export did: the
                // first failed year says why. Logged in the same shape as a
                // failed year list below, so either path names its class.
                const [{ code, reason }] = failedYears
                sieError = { code, reason }
                log.info(
                  `SIE export failed (${code}):`,
                  failedYears.map((f) => `${f.year}: ${f.error}`).join('; '),
                )
              }
            } catch (err) {
              // The year list itself failed. A company card that came back
              // above proves the token answers, so a 403 here is the provider
              // closing the ledger, not a dead grant: the migration
              // orchestrator reads its company step the same way.
              sieError = classifySieFetchFailure(err, { grantProven: mapped !== null })
              log.info(`SIE export failed (${sieError.code}):`, err instanceof Error ? err.message : String(err))
            }
          }

          // Asset register stats (Fortnox only). Soft: a consent without the
          // assets scope (or licence) just omits the line; anything else is
          // logged and omitted rather than failing an otherwise good preview.
          let assetStats: { total: number; importable: number } | null = null
          if (provider === 'fortnox') {
            try {
              assetStats = await fetchFortnoxAssetPreview(resolved.accessToken)
            } catch (err) {
              log.info('Asset preview failed:', err instanceof Error ? err.message : String(err))
            }
          }

          // Check if the company already has completed SIE imports (from manual upload)
          // and which fiscal years they hold: a history longer than one run
          // continues from the oldest year not imported yet (crm#1686).
          const { data: completedImports, count: sieImportCount } = await whereSieImportInPlace(
            supabase
              .from('sie_imports')
              .select('fiscal_year_start', { count: 'exact' })
              .eq('company_id', companyId),
          )
          const importedFiscalYears = [...new Set(
            ((completedImports ?? []) as { fiscal_year_start: string | null }[])
              .map((row) => (row.fiscal_year_start ? Number(row.fiscal_year_start.slice(0, 4)) : NaN))
              .filter((year) => Number.isInteger(year)),
          )].sort((a, b) => a - b)

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
            sieError,
            sourceYears,
            // The picker enforces the same cap as /sie-data, read from here
            // rather than duplicated in the client.
            maxSelectedYears: MAX_SELECTED_FISCAL_YEARS,
            // Start years of the completed imports, oldest first: the picker
            // skips them when the source has more years than one run takes.
            importedFiscalYears,
            assetStats,
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
          return providerFailureResponse(error, 'PROVIDER_PREVIEW_FAILED')
        }
      },
    },

    // ── Fetch + parse SIE data for mapping step ───────────────────
    {
      method: 'GET',
      path: '/sie-data',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const log = ctx.log
        const supabase = ctx.supabase

        const companyId = ctx.companyId

        const url = new URL(request.url)
        const consentId = url.searchParams.get('consentId')

        if (!consentId) {
          return NextResponse.json({ error: 'consentId is required' }, { status: 400 })
        }

        // `years`: the fiscal years the user ticked in the preview step
        // (start years, comma-separated). Absent = the default selection.
        // Every selected year is one SIE export fetched and parsed in THIS
        // invocation, so the selection is the user's own wait; it fails
        // loudly here, before any ledger write, if it is too much.
        const yearsParam = url.searchParams.get('years')
        let requestedYears: number[] | undefined
        if (yearsParam !== null) {
          const parsed = yearsParam.split(',').filter(Boolean).map(Number)
          const valid = parsed.length > 0 && parsed.every((y) => Number.isInteger(y) && y >= 1900 && y <= 2200)
          if (!valid) {
            return errorResponseFromCode('VALIDATION_ERROR', moduleLog, {
              details: { field: 'years', reason: 'comma-separated fiscal year start years' },
            })
          }
          requestedYears = [...new Set(parsed)].sort((a, b) => a - b)
          // The resource bound: each selected year is one provider export
          // fetched and parsed in this invocation (derivation on the
          // constant). Rejected before any provider call.
          if (requestedYears.length > MAX_SELECTED_FISCAL_YEARS) {
            return errorResponseFromCode('VALIDATION_ERROR', moduleLog, {
              messageSv: `Högst ${MAX_SELECTED_FISCAL_YEARS} räkenskapsår kan hämtas per körning. Välj färre år; resten kan hämtas i en ny körning, äldst först.`,
              messageEn: `At most ${MAX_SELECTED_FISCAL_YEARS} fiscal years can be fetched per run. Select fewer years; fetch the rest in a second run, oldest first.`,
              details: { field: 'years', reason: 'too_many', max: MAX_SELECTED_FISCAL_YEARS, requested: requestedYears.length },
            })
          }
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

          // Fetch SIE type 4 for each selected fiscal year. A selected year
          // the source does not have is refused by the fetcher right after
          // the year listing, before any export is fetched.
          let fetched: Awaited<ReturnType<typeof fetchProviderSieFiles>>
          try {
            fetched = await fetchProviderSieFiles(
              provider,
              resolved.accessToken,
              resolved.providerCompanyId,
              requestedYears ? { years: requestedYears } : undefined,
            )
          } catch (err) {
            if (err instanceof FiscalYearSelectionError) {
              const years = err.unknownYears.join(', ')
              return errorResponseFromCode('VALIDATION_ERROR', moduleLog, {
                messageSv: `Räkenskapsår ${years} finns inte hos leverantören.`,
                messageEn: `Fiscal years ${years} do not exist at the provider.`,
                details: { field: 'years', reason: 'unknown_year', unknownYears: err.unknownYears },
              })
            }
            throw err
          }
          const { files: sieFiles, failedYears, omittedYears } = fetched

          if (sieFiles.length === 0) {
            // Name the selection: the explicit years when the picker sent
            // them, else the rolling default window (interpolated so the
            // text never goes stale).
            const selection = requestedYears ?? [...getAllowedFiscalYears()].sort((a, b) => a - b)
            const range = requestedYears
              ? requestedYears.join(', ')
              : `${selection[0]}-${selection[selection.length - 1]}`
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
          // same as the merge's account union). A source-system account
          // (0xxx, Fortnox 0099) is left out only while it carries no amount
          // in any year; hidden with amounts on it, its vouchers were skipped
          // and the import still read completed.
          const allAccounts = sieAccountsOfferedForMapping(merged.accounts, parsedFiles.map((p) => p.parsed))
            .map(a => ({ number: a.number, name: a.name }))

          // The company's remembered mappings, every one of them (paged).
          const existingRecords = await loadMappings(supabase, companyId)

          // Mapping targets are the company's OWN chart of accounts first,
          // then BAS for anything it does not have yet. BAS alone cannot
          // express an account the company added outside the standard, so
          // such an account was impossible to map onto. See
          // ./lib/mapping-targets.
          const mappingTargets = await buildMappingTargets(supabase, companyId, moduleLog)
          // The same decision the file upload makes, over the whole dataset
          // (#3312). A class 9 account with amounts in any selected year goes
          // to 2999; without this a stored 9xxx mapping, the chart's own 9xxx
          // row or the onboarding step's self-map handed the job a 9xxx target
          // it refuses, on every retry. Unused definitions are still kept.
          const decided = suggestSIEMappings(merged, mappingTargets, existingRecords, allAccounts)
          let mappings = decided.mappings

          // The momskod each account has in the source system. SIE4 #KONTO
          // carries none, so without this the mapping step can only guess
          // from the label, and a Fortnox user saw it propose codes that
          // differed from their own kontoplan (#2585). Optional enrichment:
          // a failed chart fetch is logged and the step falls back to the
          // label suggestion rather than failing an import that does not
          // need it.
          try {
            const sourceAccounts = await fetchAccountingAccountsDirect(provider, resolved.accessToken)
            const codesByAccount = new Map<string, string>()
            for (const account of sourceAccounts) {
              if (account.vatCode) codesByAccount.set(account.accountNumber, account.vatCode)
            }
            if (codesByAccount.size > 0) {
              mappings = applySourceVatCodes(mappings, codesByAccount, fortnoxVatCodeToTreatment)
              const translated = mappings.filter((m) => m.providerVatTreatment).length
              log.info(`Account mapping: ${codesByAccount.size} ${provider} VAT codes fetched, ${translated} translated to a treatment`)
            }
          } catch (err) {
            log.warn(`Account mapping: ${provider} chart fetch failed, VAT codes fall back to label suggestions`, err as Error)
          }

          const mappingStats = getMappingStats(mappings)

          log.info(`Account mapping: ${allAccounts.length} unique accounts across ${sieFiles.length} files, ${mappingStats.unmapped} unmapped`)

          const preview = generateImportPreview(merged, mappings)
          // Definitions the decision left out of the mapping (unused numbers
          // no chart can hold) are named, as the upload's preview names them.
          preview.archivedOnlyAccounts = decided.archivedOnlyAccounts
          // Across every selected year: the unused BAS definitions the
          // options step's "only the accounts the files use" switch leaves
          // out (#63). The job decides again per year's file at submit.
          preview.unusedAccounts = decided.unusedAccounts

          // Each file is archived here, on the server, and the wizard gets
          // its path, never its text: the text in the response and again in
          // the /import-sie request body hit the hosting gateway's 4.5 MB
          // body limit, so a large company's import could not start. The
          // archive is the intake a browser upload writes; /import-sie reads
          // it back only for the active company.
          const archived = await Promise.all(
            parsedFiles.map(({ file }) => archiveSIEIntakeText(supabase, companyId, file.rawContent)),
          )

          // Detect prior imports by *fiscal period overlap*, not file hash.
          // Providers embed the export-time #GEN date in every SIE export so
          // the hash always changes between syncs; only the period stays
          // stable. A re-sync replaces the prior import for the same period.
          const fileStatuses: {
            fiscalYear: number
            storagePath: string
            filename: string
            bytes: number
            voucherCount: number
            previousImport: {
              id: string
              importedAt: string | null
              fiscalYearStart: string | null
              fiscalYearEnd: string | null
            } | null
          }[] = []
          for (const [index, { file, parsed: fileParsed }] of parsedFiles.entries()) {
            const fyStart = fileParsed.stats.fiscalYearStart
            const fyEnd = fileParsed.stats.fiscalYearEnd

            let priorImport: {
              id: string
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
              storagePath: archived[index].path,
              filename: `migration-sie-${file.fiscalYear}.se`,
              bytes: archived[index].bytes,
              voucherCount: fileParsed.stats.totalVouchers,
              previousImport: priorImport
                ? {
                    id: priorImport.id,
                    importedAt: priorImport.imported_at,
                    fiscalYearStart: priorImport.fiscal_year_start,
                    fiscalYearEnd: priorImport.fiscal_year_end,
                  }
                : null,
            })
          }

          const replacedFileCount = fileStatuses.filter(f => f.previousImport).length

          return NextResponse.json({
            // The merged dataset's accounts and its theater, built here: the
            // whole parse (every voucher of every year) is as large as the
            // files and stays on the server with them. The theater must see
            // every fiscal year, not just the newest file.
            accounts: merged.accounts,
            theater: buildTheaterModel(merged),
            mappings,
            mappingStats,
            preview,
            validation,
            // One entry per fetched file, oldest first: the path the import
            // reads it from, never its content.
            fileStatuses: fileStatuses.map(f => ({
              fiscalYear: f.fiscalYear,
              storagePath: f.storagePath,
              filename: f.filename,
              bytes: f.bytes,
              voucherCount: f.voucherCount,
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
            // Source years outside the selection: the result step names them
            // so nobody believes the books are complete (#2211).
            omittedYears,
            basAccounts: mappingTargets,
          })
        } catch (error) {
          // A file the archive refuses (over 50 MB) names itself.
          if (error instanceof SIEJobValidationError) return sieJobValidationResponse(error, moduleLog, ctx?.requestId)
          log.error('arcim sie-data fetch failed', error as Error)
          // Fetched fine, but storage would not keep a file: say that, never
          // "could not fetch from the provider" (PH 193).
          if (error instanceof SIEArchiveUnavailableError) {
            return errorResponseFromCode('SIE_INTAKE_ARCHIVE_UNAVAILABLE', moduleLog, { requestId: ctx?.requestId })
          }
          return providerFailureResponse(error, 'PROVIDER_SIE_FETCH_FAILED')
        }
      },
    },

    // ── Import SIE data (accounts, balances, vouchers) ────────────
    {
      method: 'POST',
      path: '/import-sie',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const log = ctx.log
        const supabase = ctx.supabase

        const companyId = ctx.companyId

        // The file travels by path, never as content: /sie-data archived it
        // on the server, and a body carrying the text hit the hosting
        // gateway's 4.5 MB limit. No caller posts content any more.
        const body = await request.json().catch(() => null) as {
          storagePath?: unknown
          filename?: unknown
          mappings?: import('@/lib/import/types').AccountMapping[]
          options?: {
            createFiscalPeriod: boolean
            importOpeningBalances: boolean
            importTransactions: boolean
            voucherSeries?: string
            updateAccountNames?: boolean
            supersedesImportId?: string
            onlyUsedAccounts?: boolean
          }
        } | null
        const { storagePath, filename = 'migration.se', mappings, options } = body ?? {}
        if (typeof storagePath !== 'string' || !storagePath || typeof filename !== 'string' || !Array.isArray(mappings) || !options) {
          return errorResponseFromCode('VALIDATION_ERROR', moduleLog, {
            requestId: ctx?.requestId,
            details: { fields: ['storagePath', 'mappings', 'options'], reason: 'required' },
          })
        }

        // Only the active company's own intake is read: another company's
        // path (even one this user is a member of), a traversal or a made-up
        // key is refused before storage is asked, a missing file is a 404.
        let originalFile: File
        try {
          originalFile = await readSIEIntakeFile(supabase, companyId, storagePath, filename)
        } catch (error) {
          if (error instanceof SIEIntakePathError) {
            return errorResponseFromCode('FORBIDDEN', moduleLog, {
              requestId: ctx?.requestId,
              messageSv: 'SIE-filen hör inte till det här företaget.',
              messageEn: 'The SIE file does not belong to this company.',
              details: { field: 'storagePath' },
            })
          }
          if (error instanceof SIEIntakeNotFoundError) {
            return errorResponseFromCode('NOT_FOUND', moduleLog, {
              requestId: ctx?.requestId,
              messageSv: 'SIE-filen hittades inte. Hämta bokföringsdatan från leverantören igen.',
              messageEn: 'The SIE file was not found. Fetch the accounting data from the provider again.',
              details: { field: 'storagePath' },
            })
          }
          if (error instanceof SIEJobValidationError) return sieJobValidationResponse(error, moduleLog, ctx?.requestId)
          throw error
        }
        const rawContent = await originalFile.text()

        try {
          const parsed = parseSIEFile(rawContent)

          // Mojibake tripwire (warn, never block). The archived file holds
          // the ALREADY-DECODED text /sie-data fetched, so an upstream that
          // decoded CP437 bytes as windows-1252 has baked the corruption in
          // before we ever see it (an upstream gateway did
          // exactly that on 2026-03-17). Flag the signature so it can never
          // again land silently in posted entries; the import itself
          // proceeds untouched.
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
            // The structured envelope: the wizard used to print the legacy
            // tag "validation" as the whole message.
            return errorResponseFromCode('SIE_IMPORT_UNMAPPED_ACCOUNTS', moduleLog, {
              requestId: ctx.requestId,
              details: {
                unmappedAccounts: unmapped.map((m: import('@/lib/import/types').AccountMapping) => ({
                  account: m.sourceAccount,
                  name: m.sourceName,
                })),
              },
            })
          }

          const job = await submitSIEJob(supabase,companyId,ctx.userId,rawContent,mappings,{
            filename: 'migration-sie-'+parsed.stats.fiscalYearStart+'.se',
            ...options,updateAccountNames:options.updateAccountNames ?? true,
            onExistingPeriod:options.supersedesImportId ? 'replace' : 'block',
          },originalFile,'provider_migration',{source:'migration',via:'provider_migration',
            fetchedBy:{type:'user',user_id:ctx.userId,label:'provider-migration'}})
          after(async () => { await runSIEWorker({importId:job.id}) })
          return NextResponse.json({importId:job.id,state:job.job_state,
            warnings:artifactScan.flagged ? [formatSieArtifactWarning(artifactScan)] : [],
            statusUrl:'/api/import/sie/'+job.id}, {status:202})
        } catch (error) {
          // The validator's sentence names the voucher or account that
          // refused the file; wrapped as SIE_IMPORT_UNEXPECTED it reached the
          // wizard as "Importens resultat kunde inte bekräftas" with the
          // reason buried in details.reason.
          if (error instanceof SIEJobValidationError) return sieJobValidationResponse(error, moduleLog, ctx.requestId)
          // A job RPC that refused rolled back, so the outcome is known: nothing
          // started. Answer with the code the manual upload route gives it (409
          // SIE_IMPORT_PERIOD_ALREADY_IMPORTED for a year that already holds an
          // import), not the 500 "could not be confirmed", which is for a call
          // whose outcome really is unknown.
          if (error instanceof SIEJobDatabaseError && error.code && getErrorEntry(error.code)) {
            return errorResponse(error, moduleLog, { requestId: ctx.requestId })
          }
          // A sentence written for the reader (the year in the file overlaps
          // a company year without matching it, ensureFiscalPeriod) is the
          // answer here as on the upload door. Wrapped as SIE_IMPORT_UNEXPECTED
          // it was a 500 that said the outcome could not be confirmed, while
          // nothing had started and the sentence said what to change.
          if (userFacingCode(error)) return errorResponse(error, moduleLog, { requestId: ctx.requestId })
          log.error('arcim sie import failed', error as Error)
          return providerFailureResponse(error, 'SIE_IMPORT_UNEXPECTED')
        }
      },
    },

    // ── Company information and the asset register ──
    // Customers, suppliers and invoices are imported by the background job
    // (POST /migration-jobs), which reads every record in full. This route
    // read each Fortnox customer's and supplier's own record for at most 90
    // seconds and saved the rest from Fortnox's short list, without type,
    // active flag, VAT number, country or terms, so a large register came in
    // with its private customers as companies (crm#1436). It refuses them.
    {
      method: 'POST',
      path: '/migrate',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const log = ctx.log
        const supabase = ctx.supabase

        const companyId = ctx.companyId

        const body = await request.json() as {
          consentId: string
          importCompanyInfo?: boolean
          importCustomers?: boolean
          importSuppliers?: boolean
          importSalesInvoices?: boolean
          importSupplierInvoices?: boolean
          importAssets?: boolean
          reconcileVouchers?: boolean
          suggestParties?: boolean
          grantProven?: boolean
        }
        const {
          consentId,
          importCompanyInfo = true,
          // New option: an omitted field must behave exactly as it did before
          // this option existed, so it defaults OFF. An older client that omits
          // it neither imports assets nor trips the SIE guard below; the wizard
          // always sends it explicitly.
          importAssets = false,
          reconcileVouchers = true,
          // The wizard sends one request per step (#2469) and only the last
          // one finishes the run; an older client that omits this gets the
          // original end-of-request behaviour.
          suggestParties = true,
          // Set by the wizard once an earlier per-step request received rows
          // on this grant; only changes how a 403 is classified.
          grantProven = false,
        } = body

        if (!consentId) {
          return NextResponse.json({ error: 'consentId is required' }, { status: 400 })
        }
        if (body.importCustomers || body.importSuppliers || body.importSalesInvoices || body.importSupplierInvoices) {
          return errorResponseFromCode('PROVIDER_REGISTERS_VIA_JOB', moduleLog)
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
          // Provider APIs expose ONLY entity data (customers, suppliers,
          // invoices): never the general ledger. The GL (kontoplan, ingående
          // balanser, verifikationer) arrives via SIE, either uploaded by the
          // user or, for Fortnox, Briox, Björn Lundén and WINT, pulled over the
          // API by the wizard's /import-sie phase. Importing entities without
          // that ledger would leave an incomplete bokföring under BFL: a
          // subledger with no chart of accounts and no opening balances, so
          // every subsequent posting and balance is wrong.
          //
          // The rule is "a completed SIE import must EXIST for the company",
          // not "must be part of this run": an entities-only re-run after an
          // earlier full migration passes. No provider is exempt. Fortnox used
          // to be, on the assumption that the wizard always runs SIE-over-API
          // first, but the wizard lets the user uncheck "Bokföringsdata (SIE)"
          // while keeping entities checked (#2000), and a direct API call or a
          // stale client can skip it regardless.
          //
          // Company info (name, org number, VAT number) writes no accounts,
          // balances or subledger rows, so a run that imports only that is
          // not gated.
          // The asset register counts as entity data for this gate: its rows
          // carry BAS account triples and depreciation plans that only mean
          // something against an imported chart of accounts.
          const importsEntities = importAssets
          const { count: completedSieImports } = importsEntities
            ? await whereSieImportInPlace(
                supabase
                  .from('sie_imports')
                  .select('id', { count: 'exact', head: true })
                  .eq('company_id', companyId),
              )
            : { count: null }

          if (importsEntities && (!completedSieImports || completedSieImports < 1)) {
            // Providers that serve SIE over the API have no file to upload:
            // point the user at the wizard checkbox instead of the static
            // "ladda upp en SIE-fil" text. Same code and status either way so
            // the wizard's error path renders it unchanged.
            const sieViaApi = ARCIM_PROVIDERS.some(
              (p) => p.id === consent.provider && p.sieViaApi,
            )
            return errorResponseFromCode('PROVIDER_SIE_IMPORT_REQUIRED', moduleLog, {
              details: { provider: consent.provider },
              ...(sieViaApi
                ? {
                    messageSv:
                      'Bokföringsdata (SIE) måste importeras först. Kryssa i "Bokföringsdata (SIE)" i guiden så att kontoplan, ingående balanser och verifikationer hämtas innan kunder, leverantörer, fakturor och anläggningstillgångar importeras.',
                    messageEn:
                      'A completed SIE import is required first. Tick "Bokföringsdata (SIE)" in the wizard so the chart of accounts, opening balances and verifications are fetched before customers, suppliers, invoices and fixed assets are imported.',
                  }
                : {}),
            })
          }

          log.info(`Starting migration for user ${ctx.userId} from ${consent.provider}`)

          const migrationOptions = {
            consentId,
            companyId,
            userId: ctx.userId,
            supabase,
            suggestParties,
            grantProven: grantProven === true,
            importCompanyInfo,
            importAssets,
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
    //
    // Pass { consentId } to ALSO run the two provider-backed passes:
    //   `registrationLinks`: re-link registration vouchers (the verifikat that
    //     BOOKED each invoice). The imported rows do not store the provider's
    //     voucher ref, so the registers are re-fetched through the consent.
    //   `paymentRefresh`: refresh the payment state of migrated supplier
    //     invoices that are still open here, from what the provider reports
    //     now. This is the repair path for invoices imported by a mapper that
    //     could not read the provider's payment fields (Bokio, 2026-09-14).
    // Without a consentId both are skipped and the response carries neither.
    // The consent is validated (company-scoped) BEFORE the payment reconcile
    // writes anything, so a wrong id is a clean 404; a provider failure inside
    // either pass is reported beside the results that were already persisted,
    // as `registrationLinksError` / `paymentRefreshError`, rather than by
    // discarding them. A failed refresh defers registration linking for retry.
    {
      method: 'POST',
      path: '/reconcile',
      handler: async (request: Request, ctx: ExtensionContext) => {
        const log = ctx.log
        const supabase = ctx.supabase

        const companyId = ctx.companyId

        let dryRun = false
        let consentId: string | null = null
        let completeBokio = false
        try {
          const body = (await request.json()) as { dryRun?: boolean; consentId?: unknown; completeBokioSupplierInvoices?: unknown }
          if (body.completeBokioSupplierInvoices !== undefined && typeof body.completeBokioSupplierInvoices !== 'boolean') {
            return NextResponse.json({ error: 'completeBokioSupplierInvoices måste vara ett booleskt värde' }, { status: 400 })
          }
          completeBokio = body.completeBokioSupplierInvoices === true
          dryRun = body?.dryRun === true
          if (completeBokio) dryRun = body.dryRun !== false
          consentId = typeof body?.consentId === 'string' && body.consentId ? body.consentId : null
        } catch {
          // empty body is fine: default to a real run
        }

        if (consentId) {
          // A foreign consent throws the same ConsentNotFoundError as a
          // nonexistent one (no cross-tenant existence oracle).
          try {
            const consent = await getConsent(consentId, companyId)
            if (completeBokio && consent.provider !== 'bokio') {
              return NextResponse.json({ error: 'Välj en Bokio-anslutning för att komplettera leverantörsfakturor.' }, { status: 400 })
            }
          } catch (error) {
            log.error('arcim reconcile: consent lookup failed', error as Error)
            return migrateFailureResponse(error, consentId)
          }
        }

        if (completeBokio) {
          if (!consentId) return NextResponse.json({ error: 'Anslutningens consentId krävs.' }, { status: 400 })
          try {
            const supplierCompletion = await completeBokioSupplierInvoices({ supabase, companyId, consentId, dryRun, start: !dryRun })
            return NextResponse.json({ success: true, dryRun, supplierCompletion })
          } catch (error) {
            log.error('Bokio supplier completion failed', error as Error)
            return migrateFailureResponse(error, consentId)
          }
        }

        let result: Awaited<ReturnType<typeof reconcileSupplierInvoiceVouchers>>
        try {
          result = await reconcileSupplierInvoiceVouchers({
            supabase,
            companyId,
            userId: ctx.userId,
            dryRun,
          })
          log.info('arcim reconcile completed', {
            companyId,
            dryRun,
            autoLinked: result.autoLinked,
            ambiguous: result.ambiguous,
            unmatched: result.unmatched,
          })
        } catch (error) {
          log.error('arcim reconcile failed', error as Error)
          return errorResponseFromCode('PROVIDER_MIGRATE_FAILED', moduleLog, {
            details: { reason: error instanceof Error ? error.message : 'unknown' },
          })
        }

        if (!consentId) {
          return NextResponse.json({ success: true, dryRun, result })
        }

        // resolveConsent throws plain `{ status, message }` objects for a
        // consent that vanished or lost its tokens between the check above
        // and here; classifyProviderError handles the provider-side ones.
        const providerErrorCode = (error: unknown): string => {
          const status = typeof error === 'object' && error !== null && 'status' in error
            ? (error as { status?: unknown }).status
            : undefined
          return error instanceof ConsentNotFoundError || status === 404
            ? 'PROVIDER_CONSENT_NOT_FOUND'
            : classifyProviderError(error) ?? 'PROVIDER_MIGRATE_FAILED'
        }

        // The same consent also knows which migrated supplier invoices the
        // provider considers settled. A migration can only write what its
        // mapper read, and the Bokio supplier-invoice mapper read fields that
        // schema does not have, so those rows stand as "Registrerad" with
        // their whole total open. Ask the provider and write what it says,
        // by the same rule the import uses. This must run BEFORE the relink,
        // which makes open rows ineligible for a later refresh.
        let paymentRefresh: Awaited<ReturnType<typeof refreshMigratedSupplierPaymentState>> | null = null
        let paymentRefreshError: { code: string } | null = null
        try {
          paymentRefresh = await refreshMigratedSupplierPaymentState({
            supabase,
            companyId,
            consentId,
            dryRun,
            // Dry runs leave these rows untouched, but the real payment pass
            // has already made them ineligible for a provider-state refresh.
            excludeInvoiceIds: result.links.map(link => link.supplier_invoice_id),
          })
          log.info('arcim supplier payment-state refresh completed', {
            companyId,
            dryRun,
            providerInvoices: paymentRefresh.providerInvoices,
            matched: paymentRefresh.matched,
            updated: paymentRefresh.updated,
            unchanged: paymentRefresh.unchanged,
            unmatched: paymentRefresh.unmatched,
          })
        } catch (error) {
          log.error('arcim supplier payment-state refresh failed', error as Error)
          paymentRefreshError = { code: providerErrorCode(error) }
        }

        let registrationLinks: Awaited<ReturnType<typeof relinkRegistrationVouchers>> | null = null
        let registrationLinksError: { code: string } | null = null
        // Do not make a failed refresh permanently ineligible for retry.
        if (paymentRefreshError) {
          registrationLinksError = paymentRefreshError
        } else {
          try {
            registrationLinks = await relinkRegistrationVouchers({
              supabase,
              companyId,
              consentId,
              dryRun,
            })
            log.info('arcim registration relink completed', {
              companyId,
              dryRun,
              providerInvoices: registrationLinks.providerInvoices,
              matched: registrationLinks.matched,
              linked: registrationLinks.linked,
              refNotFetched: registrationLinks.refNotFetched,
              ambiguous: registrationLinks.ambiguous,
              amountMismatch: registrationLinks.amountMismatch,
            })
          } catch (error) {
            log.error('arcim registration relink failed', error as Error)
            registrationLinksError = { code: providerErrorCode(error) }
          }
        }

        return NextResponse.json({
          success: true,
          dryRun,
          result,
          registrationLinks,
          ...(registrationLinksError ? { registrationLinksError } : {}),
          paymentRefresh,
          ...(paymentRefreshError ? { paymentRefreshError } : {}),
        })
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const log = ctx.log
        const supabase = ctx.supabase

        const companyId = ctx.companyId

        let consentId: string | undefined
        let dryRun = false
        let cursor: string | null = null
        let run: string | null = null
        try {
          const body = (await request.json()) as {
            consentId?: string
            dryRun?: boolean
            cursor?: string
            run?: string
          }
          consentId = body?.consentId
          dryRun = body?.dryRun === true
          // Resume point from a previous partial call (the last handled
          // provider attachment id, see import-documents.ts); anything else
          // restarts from the top, which is always safe: already-archived
          // receipts are skipped by hash.
          cursor =
            typeof body?.cursor === 'string' && body.cursor.length > 0 && body.cursor.length <= 256
              ? body.cursor
              : null
          // The run id an earlier answer gave this tab (document-import-run.ts).
          run = typeof body?.run === 'string' && body.run.length > 0 && body.run.length <= 64 ? body.run : null
        } catch {
          // empty/invalid body: consentId check below rejects it
        }

        if (!consentId) {
          return NextResponse.json({ error: 'consentId is required' }, { status: 400 })
        }

        // The run the server keeps, read once before the slice for two rules
        // (crm#1581). An unreadable summary lets the slice run as it always
        // has, from the tab's cursor: at worst it repeats files the server is
        // on, which converge on one row.
        const kept =
          !dryRun && ctx.settings
            ? await readDocumentImportRun(ctx.settings).catch((readError: unknown) => {
                log.warn('arcim import-documents could not read the kept run', {
                  reason: readError instanceof Error ? readError.message : 'unknown',
                })
                return null
              })
            : null
        // Whether the server keeps the run for this request's connection, on
        // the facts its worker reads. A request on another connection, or
        // after a newer connection or ledger import, starts a run of its own:
        // the worker would let go of the kept one anyway, and the new run's
        // fold replaces the summary, so the worker's next compare-and-set
        // finds the row moved and stops. Facts that cannot be read leave the
        // server's hold standing.
        const serverKeepsRun = async (run: DocumentImportRunSummary, requestConsentId: string) => {
          try {
            const [allConsents, ledger] = await Promise.all([
              listConsents(companyId),
              whereSieImportInPlace(
                supabase
                  .from('sie_imports')
                  .select('imported_at, created_at')
                  .eq('company_id', companyId),
              )
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(),
            ])
            if (ledger.error) throw new Error(ledger.error.message)
            const facts = documentImportRunFacts(
              run,
              allConsents
                .filter(c => c.status === 1)
                .map(c => ({ id: c.id, provider: c.provider as string, createdAt: c.createdAt ?? null })),
              ledger.data as { imported_at: string | null; created_at: string | null } | null,
            )
            return facts.connection?.id === requestConsentId && documentImportRunStillCurrent(run, facts)
          } catch (factsError) {
            log.warn('arcim import-documents could not read the run facts', {
              reason: factsError instanceof Error ? factsError.message : 'unknown',
            })
            return true
          }
        }
        // The server carries a run on once its tab leaves it silent. While it
        // does, a tab's slice would be a second chain over the same files:
        // the page is told the run goes on without it.
        if (kept && documentImportDrivenByServer(kept, Date.now()) && (await serverKeepsRun(kept, consentId))) {
          log.info('arcim import-documents refused: the server is continuing the run', {
            cursor,
            scanned: kept.scanned,
            total: kept.total,
          })
          return errorResponseFromCode('PROVIDER_IMPORT_DOCUMENTS_RUNNING_ON_SERVER', moduleLog)
        }
        // The kept run owns the resume point of its own tab: a continuation
        // never starts before the point it reached, even when the tab lost
        // the answer that got there and retries an earlier cursor. Only the
        // run's own tab (same run id): a tab still looping on an older run
        // must not jump into a newer one, or the newer run would skip the
        // files in between. The fold reads the run again, so a run that
        // another tab moved meanwhile is not counted twice.
        const ownRun = cursor !== null && run !== null && kept?.startedAt === run ? kept : null

        try {
          const result = await importProviderDocuments({
            supabase,
            companyId,
            userId: ctx.userId,
            consentId,
            dryRun,
            cursor,
            savedRun: ownRun,
          })
          // Where this slice really started: the same rule the import applied.
          const startCursor = continuationCursor(ownRun, result.provider, cursor)
          log.info('arcim import-documents completed', {
            companyId,
            dryRun,
            cursor,
            startCursor,
            total: result.total,
            scanned: result.scanned,
            linked: result.linked,
            skipped: result.skipped,
            unmatched: result.unmatched,
            failed: result.failed,
            locked: result.locked,
            partial: result.partial,
            nextCursor: result.nextCursor,
          })
          // Keep the run's outcome past this tab (crm#1410). Best effort:
          // the files are linked either way, so a failed write never fails
          // the slice.
          let recorded: { startedAt: string } | null = null
          if (!dryRun && ctx.settings) {
            recorded = await recordDocumentImportSlice(ctx.settings, result, startCursor, undefined, {
              driver: 'browser',
              consentId,
              run,
            }).catch((recordError) => {
              log.warn('arcim import-documents run summary not stored', {
                reason: recordError instanceof Error ? recordError.message : 'unknown',
              })
              return null
            })
          }
          // The run this slice counts for, for the tab to send back with its
          // next slice: the one it joined or started, else the one it named.
          return NextResponse.json({ success: true, dryRun, result: { ...result, run: recorded?.startedAt ?? run } })
        } catch (error) {
          // The provider refused the connection itself: the token is dead (a
          // 401 a real refresh could not outlive, or a grant the refresh was
          // refused), or the files need a permission it lacks. That is the
          // customer's next step, not our fault: one warning, the run kept as
          // "needs reconnect" for the connections list, and a 4xx the page
          // answers with a reconnect instead of retrying (B11).
          const reconnectCode =
            error instanceof ProviderConnectionRefusedError
              ? error.code
              : error instanceof ProviderCallError && error.code === 'PROVIDER_AUTH_EXPIRED'
                ? error.code
                : error instanceof FortnoxDocumentScopesRequiredError && FORTNOX_DOCUMENT_SCOPES_APPROVED
                  ? error.code
                  : null
          if (reconnectCode) {
            log.warn('arcim import-documents stopped: the provider refused the connection', {
              code: reconnectCode,
              dryRun,
              cursor,
              providerStatus:
                error instanceof ProviderConnectionRefusedError ? error.providerStatus : undefined,
              // What Fortnox answered when it refused the files: a missing
              // scope, licence or user right all end here as "reconnect".
              ...(error instanceof FortnoxDocumentScopesRequiredError ? error.refusal : {}),
            })
            if (!dryRun && ctx.settings) {
              const resolvedProvider =
                error instanceof ProviderConnectionRefusedError
                  ? error.provider
                  : error instanceof ProviderCallError
                    ? error.provider
                    : 'fortnox'
              await recordDocumentImportNeedsReconnect(
                ctx.settings,
                resolvedProvider,
                continuationCursor(ownRun, resolvedProvider, cursor),
                undefined,
                run,
              ).catch(
                (recordError) =>
                  log.warn('arcim import-documents run summary not stored', {
                    reason: recordError instanceof Error ? recordError.message : 'unknown',
                  }),
              )
            }
            return errorResponseFromCode(reconnectCode, moduleLog, {
              details: { reason: error instanceof Error ? error.message : 'unknown' },
            })
          }
          // A refresh that failed for another reason (the provider blinked, a
          // rate limit, a missing licence) answers with its own code, so the
          // page retries a 5xx or 429 slice and states the rest.
          if (error instanceof ProviderCallError) {
            log.warn('arcim import-documents could not refresh the connection', { code: error.code, cursor })
            return providerFailureResponse(error, 'PROVIDER_IMPORT_DOCUMENTS_FAILED')
          }
          // "400 Bad Request" alone told us nothing when a live Fortnox
          // discovery failed (2026-08-20): keep status, Fortnox's own
          // message and a body excerpt in the log, and hand the message
          // to the UI so the user sees what the source system said.
          const providerStatus = error instanceof FortnoxApiError ? error.statusCode : undefined
          const providerMessage = fortnoxErrorMessage(error)
          log.error('arcim import-documents failed', error as Error, {
            providerStatus,
            providerMessage,
            ...(error instanceof FortnoxDocumentScopesRequiredError ? error.refusal : {}),
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const supabase = ctx.supabase

        const companyId = ctx.companyId
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
      handler: async (request: Request, ctx: ExtensionContext) => {
        const log = ctx.log
        const supabase = ctx.supabase

        const companyId = ctx.companyId
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

          if (ctx.settings) {
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
