import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import {
  createConsent,
  getConsent,
  listConsents,
  generateOtc,
  getAuthUrl,
  exchangeAuthToken,
  submitProviderToken,
  acceptConsent,
  deleteConsent,
  resolveConsent,
  fetchCompanyInfoDirect,
  ProviderTokenInvalidError,
  ConsentNotFoundError,
} from './lib/provider-client'
import { providerSupportsSie, fetchProviderSieFiles, getAllowedFiscalYears } from './lib/sie-fetcher'
import { mapCompanyInfo } from './lib/entity-mapper'
import { executeMigration } from './lib/migration-orchestrator'
import { importProviderDocuments } from './lib/import-documents'
import { reconcileSupplierInvoiceVouchers } from '@/lib/invoices/bulk-reconcile-supplier-vouchers'
import type { ArcimProvider } from './types'
import { ARCIM_PROVIDERS } from './types'
import { parseSIEFile, validateSIEFile } from '@/lib/import/sie-parser'
import { suggestMappings, getMappingStats, isSystemAccount } from '@/lib/import/account-mapper'
import { loadMappings, generateImportPreview, executeSIEImport, saveMappings } from '@/lib/import/sie-import'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'
import type { ProviderName } from '@/lib/providers/types'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { classifyProviderError } from '@/lib/providers/with-provider-call'
import { createLogger } from '@/lib/logger'

const moduleLog = createLogger('extensions/arcim-migration')

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
 * Build a provider OAuth authorization URL bound to an EXISTING consent id.
 * Used by both first-time connect and reconnect (token revival): the callback
 * runs exchangeAuthToken(consentId, …) which upserts the fresh tokens keyed by
 * consent_id, so re-running OAuth against the same consent overwrites a dead
 * refresh-token pair in place: no disconnect/recreate needed.
 */
async function buildArcimOAuthUrl(consentId: string, provider: ArcimProvider): Promise<string> {
  const otc = await generateOtc(consentId)

  // Prefer a provider-specific redirect override (e.g. VISMA_REDIRECT_URI) when
  // set: lets dev environments route through a single registered URI rather
  // than registering every ngrok URL on the OAuth client. Falls back to
  // NEXT_PUBLIC_APP_URL + the canonical callback path.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  const providerRedirectEnv =
    provider === 'visma'
      ? process.env.VISMA_REDIRECT_URI
      : provider === 'fortnox'
        ? process.env.FORTNOX_REDIRECT_URI
        : undefined
  const callbackUrl =
    providerRedirectEnv && providerRedirectEnv.trim().length > 0
      ? providerRedirectEnv
      : `${appUrl}/api/extensions/ext/arcim-migration/callback`

  // Encode consentId + provider in state so the callback rebinds to this consent
  const statePayload = JSON.stringify({ otc: otc.code, consentId, provider })
  const stateEncoded = Buffer.from(statePayload).toString('base64url')

  const { url } = await getAuthUrl(provider, stateEncoded, callbackUrl)
  return url
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
        return NextResponse.json({ providers: ARCIM_PROVIDERS })
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

        const { provider, companyName, orgNumber, reconnect } = await request.json() as {
          provider: ArcimProvider
          companyName?: string
          orgNumber?: string
          reconnect?: boolean
        }

        if (!provider) {
          return errorResponseFromCode('VALIDATION_ERROR', moduleLog, {
            details: { field: 'provider', reason: 'required' },
          })
        }

        const providerInfo = ARCIM_PROVIDERS.find(p => p.id === provider)
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
                const authUrl = await buildArcimOAuthUrl(stale.id, provider)
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
        // the application token; Bokio/BL need their company GUID.
        if ((provider === 'bokio' || provider === 'bjornlunden' || provider === 'briox') && !providerCompanyId) {
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
          // Wrong credentials (provider actively rejected them): tell the
          // user to re-check the pasted values instead of a generic 500.
          if (error instanceof ProviderTokenInvalidError) {
            return errorResponseFromCode('PROVIDER_TOKEN_INVALID', moduleLog, {
              details: { provider, reason: error.message },
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

        const respondWithError = (reason: string) => {
          const fallbackUrl = new URL(`${appUrl}/import`)
          fallbackUrl.searchParams.set('migration', 'error')
          fallbackUrl.searchParams.set('reason', reason)

          const escapedReason = reason
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')

          const html = `<!DOCTYPE html><html><body><script>
            if (window.opener) {
              window.opener.postMessage({ type: 'arcim-oauth-error', reason: ${jsLiteral(reason)} }, ${jsLiteral(appUrl)});
              window.close();
            } else {
              window.location.href = ${jsLiteral(fallbackUrl.toString())};
            }
          </script><p>Anslutningen misslyckades: ${escapedReason}</p></body></html>`

          return new Response(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
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
          return respondWithError(translateOAuthError(oauthError, oauthErrorDescription))
        }

        if (!code || !stateRaw) {
          log.error('OAuth callback missing code or state', {
            hasCode: !!code,
            hasState: !!stateRaw,
            queryKeys: Array.from(url.searchParams.keys()),
          })
          return respondWithError('Återanropet saknade code eller state. Försök igen.')
        }

        try {
          let consentId: string | null = null
          let provider: ArcimProvider | null = null

          try {
            const decoded = JSON.parse(Buffer.from(stateRaw, 'base64url').toString())
            if (decoded.consentId && decoded.provider) {
              consentId = decoded.consentId
              provider = decoded.provider as ArcimProvider
            }
          } catch {
            // Legacy fallback
          }

          if (!consentId || !provider) {
            consentId = ctx?.settings
              ? await ctx.settings.get<string>('consent_id')
              : null
            provider = ctx?.settings
              ? await ctx.settings.get<ArcimProvider>('provider')
              : null
          }

          if (!consentId || !provider) {
            log.error('OAuth callback could not resolve consent or provider', {
              hasConsentId: !!consentId,
              hasProvider: !!provider,
            })
            return respondWithError('Ingen aktiv migrationssession hittades. Starta om anslutningen.')
          }

          const redirectUri = `${appUrl}/api/extensions/ext/arcim-migration/callback`

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
            headers: { 'Content-Type': 'text/html' },
          })
        } catch (error) {
          log.error('OAuth callback exchange failed', error)
          const reason = error instanceof Error ? error.message : 'Okänt fel vid tokenutbyte.'
          return respondWithError(reason)
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
          const consent = await getConsent(consentId)
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
            log.info('Company info fetch failed:', err instanceof Error ? err.message : String(err))
          }

          // Try to fetch SIE data (Fortnox and Briox serve SIE over the API)
          let sieAvailable = false
          let sieStats: { accountCount: number; transactionCount: number; fiscalYears: number[] } | null = null

          if (providerSupportsSie(provider)) {
            try {
              log.info(`Fetching SIE export from ${provider} for consent ${consentId}...`)
              // Fetch SIE type 4 for the most recent allowed year to get stats
              const { files, availableYears } = await fetchProviderSieFiles(
                provider,
                resolved.accessToken,
                resolved.providerCompanyId,
                { latestOnly: true },
              )
              if (files.length > 0) {
                const parsed = parseSIEFile(files[files.length - 1].rawContent)
                sieAvailable = true
                sieStats = {
                  accountCount: parsed.accounts.length,
                  transactionCount: parsed.vouchers.length,
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

          // Parse most recent file for preview/validation
          const sieFile = sieFiles[sieFiles.length - 1]
          const parsed = parseSIEFile(sieFile.rawContent)
          const validation = validateSIEFile(parsed)

          if (!validation.valid) {
            log.warn(
              `arcim sie-data validation failed for ${provider} fiscal year ${sieFile.fiscalYear}: ` +
              `${validation.errors.length} error(s): ${validation.errors.slice(0, 3).join(' | ')}`,
            )
            return NextResponse.json({
              error: 'validation',
              message: 'SIE file validation failed',
              validation,
            }, { status: 400 })
          }

          // Collect ALL unique accounts across ALL fiscal year files
          const allAccountsMap = new Map<string, { number: string; name: string }>()
          for (const file of sieFiles) {
            const fileParsed = parseSIEFile(file.rawContent)
            for (const acc of fileParsed.accounts) {
              if (!allAccountsMap.has(acc.number)) {
                allAccountsMap.set(acc.number, { number: acc.number, name: acc.name })
              }
            }
          }
          const allAccounts = [...allAccountsMap.values()]
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

          const preview = generateImportPreview(parsed, mappings)

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
          for (const file of sieFiles) {
            const fileParsed = parseSIEFile(file.rawContent)
            const fyStart = fileParsed.stats.fiscalYearStart
            const fyEnd = fileParsed.stats.fiscalYearEnd

            let priorImport: {
              imported_at: string | null
              fiscal_year_start: string | null
              fiscal_year_end: string | null
            } | null = null

            if (fyStart && fyEnd) {
              const { data } = await supabase
                .from('sie_imports')
                .select('imported_at, fiscal_year_start, fiscal_year_end')
                .eq('company_id', companyId)
                .eq('status', 'completed')
                .lte('fiscal_year_start', fyEnd)
                .gte('fiscal_year_end', fyStart)
                .limit(1)
                .maybeSingle()
              priorImport = data
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
            parsed,
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
          // that used to live here was a duplicate of that logic.
          await saveMappings(supabase, user.id, mappings)

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
          const consent = await getConsent(consentId)
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

          const results = await executeMigration({
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
          })

          log.info('Migration completed:', results)

          // Mark consent as fully accepted now that data has been imported
          await acceptConsent(consentId)

          return NextResponse.json({ success: true, results })
        } catch (error) {
          log.error('arcim migration failed', error as Error)
          const classified = classifyProviderError(error)
          return errorResponseFromCode(classified ?? 'PROVIDER_MIGRATE_FAILED', moduleLog, {
            details: {
              reason: error instanceof Error ? error.message : 'unknown',
              classified: classified ?? 'unclassified',
            },
          })
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
    // Best-effort, re-runnable. Kept off the migration's critical path: the
    // Bokio document API is rate-limited (200 req/60s) and a full receipt
    // sweep issues hundreds of download calls, which would blow the 300s
    // migration window. Pages /uploads, resolves each receipt's verifikat via
    // the SIE-preserved Bokio voucher number, and archives it idempotently
    // (skips content already stored for the company). Pass { dryRun: true } to
    // preview the match plan without downloading or writing.
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
        try {
          const body = (await request.json()) as { consentId?: string; dryRun?: boolean }
          consentId = body?.consentId
          dryRun = body?.dryRun === true
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
          })
          log.info('arcim import-documents completed', {
            companyId,
            dryRun,
            scanned: result.scanned,
            linked: result.linked,
            skipped: result.skipped,
            unmatched: result.unmatched,
            failed: result.failed,
          })
          return NextResponse.json({ success: true, dryRun, result })
        } catch (error) {
          log.error('arcim import-documents failed', error as Error)
          return errorResponseFromCode('PROVIDER_IMPORT_DOCUMENTS_FAILED', moduleLog, {
            details: { reason: error instanceof Error ? error.message : 'unknown' },
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
