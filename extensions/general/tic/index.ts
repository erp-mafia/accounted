import type { Extension } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import {
  searchCompanyByOrgNumber,
  getBankAccounts,
  getSNICodes,
  getEmails,
  getPhones,
  getCompanyPurpose,
  getFinancialReportSummaries,
  getBeneficialOwners,
} from './lib/tic-client'
import {
  startBankIdAuth,
  pollBankIdSession,
  collectBankIdResult,
  cancelBankIdSession,
  requestEnrichment,
  fetchEnrichmentData,
} from './lib/bankid-client'
import { TICAPIError } from './lib/tic-types'
import type { TICCompanyProfile } from './lib/tic-types'
import type { BankIdCompleteRequest } from './lib/bankid-types'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import { hashPersonalNumber, encryptPersonalNumber } from '@/lib/auth/bankid'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'

const log = createLogger('tic/bankid')

/**
 * Request SPAR + CompanyRoles enrichment for a completed BankID session and
 * cache the CompanyRoles slice in `bankid_enrichment` for the
 * /select-company picker.
 *
 * Stored in `bankid_enrichment` (user-keyed) rather than `extension_data`
 * because enrichment runs before the user has a company; `extension_data`
 * has been company-scoped (NOT NULL company_id) since the multi-tenant
 * refactor.
 *
 * SPAR (personnummer, address, name, birth date) is requested so TIC will
 * complete the enrichment, but is intentionally NOT persisted: personnummer
 * is already hashed + encrypted in `bankid_identities`, names live there too,
 * and no UI currently consumes the address. Storing the SPAR blob alongside
 * company roles would expose national-ID-level PII. If/when address pre-fill
 * is built, encrypt the relevant fields the same way `encryptPersonalNumber`
 * does for pnr.
 *
 * Non-blocking: any failure is logged and swallowed — BankID auth must still
 * succeed even if enrichment is down.
 */
async function fetchAndStoreEnrichment(
  sessionId: string,
  userId: string,
  supabase: SupabaseClient,
): Promise<void> {
  try {
    // Both 'SPAR' and 'CompanyRoles' are enabled on our TIC tenant as of
    // 2026-05-06 (TIC ticket re. enrichment). Verify with:
    //   curl -H "X-Api-Key: $KEY" https://id.tic.io/api/v1/enrichment/types
    //
    // If a requested type is disabled on the tenant, TIC rejects the WHOLE
    // enrichment with body field `error: 'Session not completed'` (HTTP 200,
    // not a real HTTP error). The message is misleading — it does NOT mean
    // the BankID session is incomplete. The hint mapping below catches it.
    const enrichment = await requestEnrichment(sessionId, ['SPAR', 'CompanyRoles'])
    log.info('enrichment request returned', {
      status: enrichment.status,
      requestedTypes: enrichment.requestedTypes,
      completedTypes: enrichment.completedTypes,
      hasSecureUrl: !!enrichment.secureUrl,
    })

    // Case-insensitive status comparison: TIC has been observed returning
    // lowercase values ('completed', 'failed') in addition to the docs' canonical
    // capitalized form. Accept both fully and partially completed runs.
    const statusLower = String(enrichment.status ?? '').toLowerCase()
    const isCompleted = statusLower === 'completed' || statusLower === 'partiallycompleted'
    const usable = isCompleted && enrichment.secureUrl
    if (!usable) {
      // Log the full response shape (sans secureUrl — time-limited token)
      // so we can diagnose why a real-user enrichment comes back non-usable.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { secureUrl: _omit, ...responseDiagnostic } = enrichment

      // Interpret common failure shapes into actionable hints so developers
      // don't have to re-trace this every time. TIC returns these as body
      // fields with HTTP 200, not as errors — see TIC_AUTH.md §enrichment.
      const errField = (enrichment as { error?: string }).error ?? ''
      let hint: string | undefined
      if (errField === 'Session not completed') {
        // Two distinct causes produce this identical error:
        //   1. We requested a type not enabled on the tenant (most common —
        //      verify via GET /api/v1/enrichment/types)
        //   2. The BankID session genuinely never went through the
        //      consent-to-enrich dialog
        hint = 'Likely cause: a requested enrichment type is not enabled on the TIC tenant. Run `curl -H "X-Api-Key: $KEY" https://id.tic.io/api/v1/enrichment/types` to verify which types have `enabled: true` and adjust the requestEnrichment call to match.'
      } else if (errField.toLowerCase().includes('not enabled')) {
        hint = 'Enrichment explicitly disabled on TIC tenant — contact support@tic.io.'
      } else if (errField.toLowerCase().includes('too old')) {
        hint = '>30 min between auth completion and enrichment call — check for slow server-side work between /bankid/complete and fetchAndStoreEnrichment.'
      }

      log.warn('enrichment not usable', { ...responseDiagnostic, hint })
      return
    }

    const enrichmentData = await fetchEnrichmentData(enrichment.secureUrl)

    // Log a PII-free snapshot so we can debug the role filter in production.
    // Raw personnummer / names / address values are deliberately omitted —
    // only flat booleans and counts.
    const firstRole = enrichmentData.companyRoles?.[0]
    const spar = enrichmentData.spar
    log.info('enrichment data shape', {
      companyCount: enrichmentData.companyRoles?.length ?? 0,
      firstRoleStatuses: firstRole
        ? {
            companyStatus: firstRole.companyStatus,
            positionEndIsNull: firstRole.positionEnd === null,
            positionTypes: firstRole.positionTypes,
            legalEntityType: firstRole.legalEntityType,
          }
        : null,
      hasSpar: !!spar,
      sparHasAddress: !!spar?.Folkbokforingsadress_SvenskAdress_Utdelningsadress1,
      sparHasProtection: !!(spar?.Skydd_Sekretessmarkering || spar?.Skydd_SkyddadFolkbokforing),
    })

    // Persist only what consumers actually read. See block comment on
    // fetchAndStoreEnrichment for why SPAR + personnummer + name are excluded.
    const { error: upsertError } = await supabase
      .from('bankid_enrichment')
      .upsert({
        user_id: userId,
        company_roles: enrichmentData.companyRoles ?? [],
        enriched_at_utc: enrichmentData.enrichedAtUtc ?? null,
      }, { onConflict: 'user_id' })

    if (upsertError) {
      log.warn('enrichment upsert failed (non-blocking)', {
        message: upsertError.message,
        code: upsertError.code,
        details: upsertError.details,
        hint: upsertError.hint,
      })
    } else {
      log.info('enrichment persisted to bankid_enrichment', {
        roleCount: enrichmentData.companyRoles?.length ?? 0,
      })
    }
  } catch (enrichError) {
    log.warn('enrichment failed (non-blocking)', enrichError)
  }
}

// Server-side per-IP rate limit for /bankid/start (each call = billable TIC session)
const bankIdStartCooldowns = new Map<string, number>()
const BANKID_START_COOLDOWN_MS = 5_000

/** Map TIC bankAccountType enum to human-readable string */
function bankAccountTypeLabel(type?: number): string {
  switch (type) {
    case 0: return 'bankkonto'
    case 1: return 'bankgiro'
    case 2: return 'plusgiro'
    case 3: return 'iban'
    default: return 'bankkonto'
  }
}

/**
 * Translate any error from the TIC pipeline into a structured HTTP response.
 *
 * Status mapping:
 *   - NOT_CONFIGURED       → 503 (proxy URL missing)
 *   - RATE_LIMIT_EXCEEDED  → 429 (TIC quota hit)
 *   - TIMEOUT              → 504 (TIC took longer than 15s)
 *   - upstream 4xx         → 400 (TIC rejected the input — typically a malformed org number)
 *   - upstream 5xx         → 502 (TIC outage)
 *   - other / unknown      → 500
 *
 * Always logs the cleaned org number so we can correlate failures with input
 * in Vercel logs.
 */
function handleTicError(
  error: unknown,
  log: { error: (msg: string, meta?: unknown) => void } | Console,
  route: 'lookup' | 'profile',
  orgNumber: string,
  fallbackMessage: string
): Response {
  if (error instanceof TICAPIError) {
    const meta = {
      route,
      orgNumber,
      message: error.message,
      statusCode: error.statusCode,
      code: error.code,
    }

    if (error.code === 'NOT_CONFIGURED') {
      log.error(`[tic] ${route}: not configured`, meta)
      return NextResponse.json({ error: 'TIC is not configured' }, { status: 503 })
    }

    if (error.code === 'RATE_LIMIT_EXCEEDED') {
      log.error(`[tic] ${route}: rate limit exceeded`, meta)
      return NextResponse.json({ error: 'Rate limit exceeded, try again later' }, { status: 429 })
    }

    if (error.code === 'TIMEOUT') {
      log.error(`[tic] ${route}: upstream timeout`, meta)
      return NextResponse.json(
        { error: 'TIC service did not respond in time' },
        { status: 504 }
      )
    }

    // Upstream returned a non-OK status we surfaced as a TICAPIError
    if (typeof error.statusCode === 'number') {
      if (error.statusCode >= 400 && error.statusCode < 500) {
        log.error(`[tic] ${route}: upstream rejected request`, meta)
        return NextResponse.json(
          { error: 'Invalid request to TIC (upstream rejected)' },
          { status: 400 }
        )
      }
      if (error.statusCode >= 500) {
        log.error(`[tic] ${route}: upstream error`, meta)
        return NextResponse.json(
          { error: 'TIC service is temporarily unavailable' },
          { status: 502 }
        )
      }
    }

    // Network/DNS/parse failure surfaced as a TICAPIError without code or statusCode
    log.error(`[tic] ${route}: upstream failure`, meta)
    return NextResponse.json(
      { error: 'TIC service is temporarily unavailable' },
      { status: 502 }
    )
  }

  log.error(`[tic] ${route}: unexpected error`, {
    route,
    orgNumber,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  })
  return NextResponse.json({ error: fallbackMessage }, { status: 500 })
}

export const ticExtension: Extension = {
  id: 'tic',
  name: 'Bolagsuppgifter',
  version: '1.0.0',
  sector: 'general',

  apiRoutes: [
    {
      method: 'GET',
      path: '/lookup',
      // Used during onboarding (Step2CompanyDetails debounced lookup + the
      // BankID picker) — user is authenticated but does not yet have a
      // company. Must not require a company context.
      skipCompanyContext: true,
      handler: async (request: Request, ctx?) => {
        const log = ctx?.log ?? console
        const url = new URL(request.url)
        const orgNumber = url.searchParams.get('org_number')

        if (!orgNumber) {
          return NextResponse.json(
            { error: 'org_number query parameter is required' },
            { status: 400 }
          )
        }

        const cleanedOrgNumber = orgNumber.replace(/[\s-]/g, '')

        try {
          // Phase 1: Search — returns name, address, registration flags
          const doc = await searchCompanyByOrgNumber(orgNumber)

          if (!doc) {
            return NextResponse.json(
              { error: 'Company not found' },
              { status: 404 }
            )
          }

          // Extract company name (prefer 'name' type over other naming types)
          const nameEntry =
            doc.names.find((n) => n.companyNamingType === 'name') ?? doc.names[0]
          const companyName = nameEntry?.nameOrIdentifier ?? ''

          const isCeased = doc.activityStatus === 'ceased'

          const address = doc.mostRecentRegisteredAddress
            ? {
                street: doc.mostRecentRegisteredAddress.streetAddress
                  ?? doc.mostRecentRegisteredAddress.street
                  ?? null,
                postalCode: doc.mostRecentRegisteredAddress.postalCode ?? null,
                city: doc.mostRecentRegisteredAddress.city ?? null,
              }
            : null

          const registration = {
            fTax: doc.isRegisteredForFTax ?? false,
            vat: doc.isRegisteredForVAT ?? false,
          }

          // Phase 2: Supplementary data (non-blocking)
          const companyId = doc.companyId
          const [bankResult, sniResult, emailResult, phoneResult] =
            await Promise.allSettled([
              getBankAccounts(companyId),
              getSNICodes(companyId),
              getEmails(companyId),
              getPhones(companyId),
            ])

          const bankAccounts =
            bankResult.status === 'fulfilled' && bankResult.value
              ? bankResult.value.map((ba) => ({
                  type: bankAccountTypeLabel(ba.bankAccountType),
                  accountNumber: ba.accountNumber ?? '',
                  bic: ba.swift_BIC ?? null,
                }))
              : []

          const sniCodes =
            sniResult.status === 'fulfilled' && sniResult.value
              ? sniResult.value.map((s) => ({
                  code: s.sni_2007Code ?? '',
                  name: s.sni_2007Name ?? '',
                }))
              : []

          const email =
            emailResult.status === 'fulfilled' && emailResult.value?.[0]?.emailAddress
              ? emailResult.value[0].emailAddress
              : null

          const phone =
            phoneResult.status === 'fulfilled' && phoneResult.value?.[0]?.phoneNumber
              ? phoneResult.value[0].phoneNumber
              : null

          // Log Phase 2 failures for debugging
          if (bankResult.status === 'rejected') {
            log.warn('[tic] bank accounts fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(bankResult.reason) })
          }
          if (sniResult.status === 'rejected') {
            log.warn('[tic] SNI codes fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(sniResult.reason) })
          }

          const result: CompanyLookupResult = {
            companyName,
            isCeased,
            address,
            registration,
            bankAccounts,
            email,
            phone,
            sniCodes,
          }

          return NextResponse.json({ data: result })
        } catch (error) {
          return handleTicError(error, log, 'lookup', cleanedOrgNumber, 'Failed to look up company')
        }
      },
    },
    {
      method: 'GET',
      path: '/profile',
      // Used during onboarding to render richer company profile details —
      // user is authenticated but may not yet have a company. See /lookup.
      skipCompanyContext: true,
      handler: async (request: Request, ctx?) => {
        const log = ctx?.log ?? console
        const url = new URL(request.url)
        const orgNumber = url.searchParams.get('org_number')

        if (!orgNumber) {
          return NextResponse.json(
            { error: 'org_number query parameter is required' },
            { status: 400 }
          )
        }

        const cleanedOrgNumber = orgNumber.replace(/[\s-]/g, '')

        try {
          const doc = await searchCompanyByOrgNumber(orgNumber)

          if (!doc) {
            return NextResponse.json(
              { error: 'Company not found' },
              { status: 404 }
            )
          }

          const nameEntry =
            doc.names.find((n) => n.companyNamingType === 'name') ?? doc.names[0]
          const companyName = nameEntry?.nameOrIdentifier ?? ''
          const companyId = doc.companyId

          // Phase 2: Supplementary data (non-blocking)
          const [
            bankResult,
            sniResult,
            emailResult,
            phoneResult,
            purposeResult,
            reportsResult,
            beneficialOwnersResult,
          ] = await Promise.allSettled([
            getBankAccounts(companyId),
            getSNICodes(companyId),
            getEmails(companyId),
            getPhones(companyId),
            getCompanyPurpose(companyId),
            getFinancialReportSummaries(companyId),
            getBeneficialOwners(companyId),
          ])

          const bankAccounts =
            bankResult.status === 'fulfilled' && bankResult.value
              ? bankResult.value.map((ba) => ({
                  type: bankAccountTypeLabel(ba.bankAccountType),
                  accountNumber: ba.accountNumber ?? '',
                  bic: ba.swift_BIC ?? null,
                }))
              : []

          const sniCodes =
            sniResult.status === 'fulfilled' && sniResult.value
              ? sniResult.value.map((s) => ({
                  code: s.sni_2007Code ?? '',
                  name: s.sni_2007Name ?? '',
                }))
              : []

          const email =
            emailResult.status === 'fulfilled' && emailResult.value?.[0]?.emailAddress
              ? emailResult.value[0].emailAddress
              : null

          const phone =
            phoneResult.status === 'fulfilled' && phoneResult.value?.[0]?.phoneNumber
              ? phoneResult.value[0].phoneNumber
              : null

          const financialReports =
            reportsResult.status === 'fulfilled' && reportsResult.value
              ? reportsResult.value
              : []

          // Use dedicated purpose endpoint, fall back to search result
          const purpose =
            purposeResult.status === 'fulfilled' && purposeResult.value?.[0]?.purpose
              ? purposeResult.value[0].purpose
              : doc.mostRecentPurpose ?? null

          // Log Phase 2 failures
          if (bankResult.status === 'rejected') {
            log.warn('[tic] profile: bank accounts fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(bankResult.reason) })
          }
          if (sniResult.status === 'rejected') {
            log.warn('[tic] profile: SNI codes fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(sniResult.reason) })
          }
          if (reportsResult.status === 'rejected') {
            log.warn('[tic] profile: financial reports fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(reportsResult.reason) })
          }
          if (beneficialOwnersResult.status === 'rejected') {
            log.warn('[tic] profile: beneficial-owners fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(beneficialOwnersResult.reason) })
          }

          // Flatten the beneficial-owners response. Bolagsverket returns one
          // notification per registration event; the latest active
          // notification's owners are the current ones. Personnummer is
          // intentionally excluded — it's PII we don't need cached and we
          // don't want it persisted on `companies.tic_snapshot`.
          let beneficialOwners: TICCompanyProfile['beneficialOwners'] = []
          let beneficialOwnerExempt = false
          if (beneficialOwnersResult.status === 'fulfilled' && beneficialOwnersResult.value) {
            const response = beneficialOwnersResult.value
            beneficialOwnerExempt = Array.isArray(response.exempts) && response.exempts.length > 0
            const notifications = Array.isArray(response.notifications) ? response.notifications : []
            // Prefer the latest notification by notificationDate (already
            // sorted descending in practice, but we sort defensively).
            const latest = [...notifications]
              .filter((n) => n && Array.isArray(n.bolagsverket_BeneficialOwner))
              .sort((a, b) => {
                const ad = a.notificationDate ?? ''
                const bd = b.notificationDate ?? ''
                return bd.localeCompare(ad)
              })[0]
            if (latest?.bolagsverket_BeneficialOwner) {
              beneficialOwners = latest.bolagsverket_BeneficialOwner
                .map((o) => {
                  const nameParts = [o.firstName, o.middleName, o.lastName]
                    .map((p) => (p ?? '').trim())
                    .filter((p) => p.length > 0)
                  const name = nameParts.length > 0 ? nameParts.join(' ') : (o.fallbackName ?? '').trim()
                  if (!name) return null
                  return {
                    name,
                    extentCode: o.extentCode ?? null,
                    extentDescription: o.extentDescription ?? null,
                    citizenshipCountryCode: o.citizenshipCountryCode ?? null,
                    countryOfResidenceCode: o.countryOfResidenceCode ?? null,
                    registeredAt: latest.fromDate ?? latest.notificationDate ?? null,
                  }
                })
                .filter((o): o is NonNullable<typeof o> => o !== null)
            }
          }

          const fin = doc.mostRecentFinancialSummary
          const financials = fin
            ? {
                periodStart: fin.periodStart,
                periodEnd: fin.periodEnd,
                netSalesK: fin.rs_NetSalesK ?? null,
                operatingProfitK: fin.rs_OperatingProfitOrLossK ?? null,
                totalAssetsK: fin.bs_TotalAssetsK ?? null,
                numberOfEmployees: fin.fn_NumberOfEmployees ?? null,
                operatingMargin: fin.km_OperatingMargin ?? null,
                netProfitMargin: fin.km_NetProfitMargin ?? null,
                equityAssetsRatio: fin.km_EquityAssetsRatio ?? null,
              }
            : null

          const profile: TICCompanyProfile = {
            companyId,
            orgNumber: doc.registrationNumber,
            companyName,
            legalEntityType: doc.legalEntityType,
            registrationDate: doc.registrationDate,
            activityStatus: doc.activityStatus ?? null,
            purpose,
            address: doc.mostRecentRegisteredAddress
              ? {
                  street: doc.mostRecentRegisteredAddress.streetAddress
                    ?? doc.mostRecentRegisteredAddress.street
                    ?? null,
                  postalCode: doc.mostRecentRegisteredAddress.postalCode ?? null,
                  city: doc.mostRecentRegisteredAddress.city ?? null,
                }
              : null,
            registration: {
              fTax: doc.isRegisteredForFTax ?? false,
              vat: doc.isRegisteredForVAT ?? false,
              payroll: doc.isRegisteredForPayroll ?? false,
            },
            sector: doc.cSector
              ? { code: doc.cSector.categoryCode, description: doc.cSector.categoryCodeDescription }
              : null,
            employeeRange: doc.cNbrEmployeesInterval?.categoryCodeDescription ?? null,
            turnoverRange: doc.cTurnoverInterval?.categoryCodeDescription ?? null,
            email,
            phone,
            sniCodes,
            bankAccounts,
            beneficialOwners,
            beneficialOwnerExempt,
            financials,
            financialReports,
            fetchedAt: new Date().toISOString(),
          }

          return NextResponse.json({ data: profile })
        } catch (error) {
          return handleTicError(error, log, 'profile', cleanedOrgNumber, 'Failed to fetch company profile')
        }
      },
    },
    // ── BankID Authentication ──────────────────────────────────────
    // Routes for BankID login/signup via TIC Identity API.
    // skipAuth: true on auth routes (user has no Supabase session yet).

    {
      method: 'POST',
      path: '/bankid/start',
      skipAuth: true,
      handler: async (request: Request) => {
        try {
          const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || request.headers.get('x-real-ip')
            || '127.0.0.1'

          // Per-IP rate limit (each start = billable TIC session)
          const now = Date.now()
          const lastStart = bankIdStartCooldowns.get(ip) ?? 0
          if (now - lastStart < BANKID_START_COOLDOWN_MS) {
            return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
          }
          bankIdStartCooldowns.set(ip, now)

          // Prevent map from growing unbounded
          if (bankIdStartCooldowns.size > 10_000) {
            const cutoff = now - BANKID_START_COOLDOWN_MS
            for (const [k, v] of bankIdStartCooldowns) {
              if (v < cutoff) bankIdStartCooldowns.delete(k)
            }
          }

          const userAgent = request.headers.get('user-agent') || undefined

          const session = await startBankIdAuth(ip, userAgent)
          return NextResponse.json({ data: session })
        } catch (error) {
          if (error instanceof TICAPIError) {
            if (error.code === 'NOT_CONFIGURED') {
              return NextResponse.json({ error: 'not_configured', message: 'BankID is not configured' }, { status: 503 })
            }
            if (error.code === 'RATE_LIMIT_EXCEEDED') {
              return NextResponse.json({ error: 'rate_limit', message: 'Rate limit exceeded' }, { status: 429 })
            }
            if (error.code === 'TIMEOUT') {
              log.error('start timed out — TIC Identity API unreachable', { statusCode: error.statusCode })
              return NextResponse.json({ error: 'service_unavailable', message: 'BankID service is not responding' }, { status: 503 })
            }
            // TIC API returned an error (e.g. 5xx)
            log.error('start failed — TIC API error', { statusCode: error.statusCode, code: error.code, message: error.message })
            return NextResponse.json({ error: 'service_unavailable', message: 'BankID service is temporarily unavailable' }, { status: 502 })
          }
          log.error('start failed — unexpected error', error)
          return NextResponse.json({ error: 'internal_error', message: 'Failed to start BankID session' }, { status: 500 })
        }
      },
    },

    {
      method: 'POST',
      path: '/bankid/poll',
      skipAuth: true,
      handler: async (request: Request) => {
        try {
          const body = await request.json()
          const sessionId = body?.sessionId
          if (!sessionId || typeof sessionId !== 'string') {
            return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
          }

          const result = await pollBankIdSession(sessionId)
          if (result.status !== 'pending') {
            log.info('poll status', { status: result.status, hintCode: result.hintCode, hasUser: !!result.user?.personalNumber })
          }
          return NextResponse.json({ data: result })
        } catch (error) {
          if (error instanceof TICAPIError) {
            if (error.code === 'RATE_LIMIT_EXCEEDED') {
              return NextResponse.json({ error: 'rate_limit', message: 'Rate limit exceeded' }, { status: 429 })
            }
            if (error.code === 'TIMEOUT') {
              log.error('poll timed out — TIC Identity API unreachable')
              return NextResponse.json({ error: 'service_unavailable', message: 'BankID service is not responding' }, { status: 503 })
            }
            log.error('poll failed — TIC API error', { statusCode: error.statusCode, code: error.code, message: error.message })
            return NextResponse.json({ error: 'service_unavailable', message: 'BankID service is temporarily unavailable' }, { status: 502 })
          }
          log.error('poll failed — unexpected error', error)
          return NextResponse.json({ error: 'internal_error', message: 'Failed to poll BankID session' }, { status: 500 })
        }
      },
    },

    {
      method: 'POST',
      path: '/bankid/complete',
      skipAuth: true,
      handler: async (request: Request) => {
        try {
          const body: BankIdCompleteRequest = await request.json()
          const { sessionId, mode, email } = body

          if (!sessionId || !mode) {
            return NextResponse.json(
              { error: 'sessionId and mode are required' },
              { status: 400 }
            )
          }

          const trimmedEmail = email?.trim().toLowerCase()

          if (mode === 'signup' && !trimmedEmail) {
            return NextResponse.json(
              { error: 'email is required for signup' },
              { status: 400 }
            )
          }

          // Verify BankID session is complete
          const session = await collectBankIdResult(sessionId)
          if (session.status !== 'complete' || !session.user) {
            return NextResponse.json(
              { error: 'session_invalid', message: 'BankID session is not complete' },
              { status: 400 }
            )
          }

          const { personalNumber, givenName, surname, name } = session.user
          const pnrHash = hashPersonalNumber(personalNumber)
          const supabase = createServiceClient()

          // Look up existing BankID identity
          const { data: existing } = await supabase
            .from('bankid_identities')
            .select('user_id')
            .eq('personal_number_hash', pnrHash)
            .single()

          if (mode === 'login') {
            if (!existing) {
              return NextResponse.json({
                error: 'no_account',
                givenName,
                surname,
              }, { status: 404 })
            }

            // Returning user — generate magic link
            const { data: userData } = await supabase.auth.admin.getUserById(existing.user_id)
            if (!userData?.user?.email) {
              return NextResponse.json(
                { error: 'session_invalid', message: 'User account not found' },
                { status: 500 }
              )
            }

            const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
              type: 'magiclink',
              email: userData.user.email,
            })

            if (linkError || !link?.properties?.hashed_token) {
              log.error('generateLink failed for login', { message: linkError?.message, code: linkError?.code })
              return NextResponse.json(
                { error: 'Failed to create session' },
                { status: 500 }
              )
            }

            // Refresh enrichment so /select-company sees current Bolagsverket roles.
            await fetchAndStoreEnrichment(sessionId, existing.user_id, supabase)

            return NextResponse.json({
              data: {
                tokenHash: link.properties.hashed_token,
                type: 'magiclink',
                isNewUser: false,
              },
            })
          }

          // mode === 'signup'
          if (existing) {
            return NextResponse.json(
              { error: 'already_linked', message: 'This BankID is already linked to an account' },
              { status: 409 }
            )
          }

          // If the email is already registered, refuse signup. Linking BankID to an
          // existing account must go through the authenticated /bankid/link route so
          // email ownership is proven by password login first. (CWE-287)
          const { data: existingByEmail } = await supabase
            .from('profiles')
            .select('id')
            .eq('email', trimmedEmail!)
            .single()

          if (existingByEmail) {
            log.warn('bankid signup rejected — email already registered', {
              sessionId,
              pnrHashPrefix: pnrHash.slice(0, 8),
            })
            return NextResponse.json(
              {
                error: 'account_exists',
                message: 'An account with this email already exists. Log in and link BankID from settings.',
              },
              { status: 409 }
            )
          }

          // Create new Supabase user
          const randomPassword = crypto.randomBytes(32).toString('base64url')
          const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
            email: trimmedEmail!,
            email_confirm: true,
            password: randomPassword,
            user_metadata: { full_name: name },
          })

          if (createError || !newUser?.user) {
            log.error('createUser failed', { email: trimmedEmail, status: createError?.status, code: createError?.code, message: createError?.message })
            return NextResponse.json(
              { error: 'Failed to create account', message: createError?.message },
              { status: 500 }
            )
          }

          const userId = newUser.user.id

          // Mark user as BankID-linked (skips TOTP MFA)
          await supabase.auth.admin.updateUserById(userId, {
            app_metadata: { bankid_linked: true },
          })

          // Store BankID identity
          const { error: insertError } = await supabase
            .from('bankid_identities')
            .insert({
              user_id: userId,
              personal_number_hash: pnrHash,
              personal_number_enc: encryptPersonalNumber(personalNumber),
              given_name: givenName,
              surname,
            })

          if (insertError) {
            log.error('insert bankid_identities failed', { message: insertError.message, code: insertError.code })
            return NextResponse.json(
              { error: 'Failed to link BankID identity' },
              { status: 500 }
            )
          }

          // Generate magic link for session
          const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
            type: 'magiclink',
            email: trimmedEmail!,
          })

          if (linkError || !link?.properties?.hashed_token) {
            log.error('generateLink failed for signup', { message: linkError?.message, code: linkError?.code })
            return NextResponse.json(
              { error: 'Account created but failed to create session' },
              { status: 500 }
            )
          }

          // Enrichment (CompanyRoles) — pre-fills /select-company picker.
          await fetchAndStoreEnrichment(sessionId, userId, supabase)

          return NextResponse.json({
            data: {
              tokenHash: link.properties.hashed_token,
              type: 'magiclink',
              isNewUser: true,
            },
          })
        } catch (error) {
          if (error instanceof TICAPIError) {
            log.error('complete failed — TIC API error', { statusCode: error.statusCode, code: error.code, message: error.message })
            if (error.code === 'TIMEOUT') {
              return NextResponse.json(
                { error: 'service_unavailable', message: 'BankID service is not responding' },
                { status: 503 }
              )
            }
            return NextResponse.json(
              { error: 'service_unavailable', message: 'BankID verification failed' },
              { status: 502 }
            )
          }
          log.error('complete failed — unexpected error', error)
          return NextResponse.json(
            { error: 'internal_error', message: 'Failed to complete BankID authentication' },
            { status: 500 }
          )
        }
      },
    },

    {
      method: 'DELETE',
      path: '/bankid/:sessionId',
      skipAuth: true,
      handler: async (request: Request) => {
        try {
          const url = new URL(request.url)
          const sessionId = url.searchParams.get('_sessionId')
          if (!sessionId) {
            return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
          }

          await cancelBankIdSession(sessionId)
          return NextResponse.json({ data: { cancelled: true } })
        } catch (error) {
          log.error('cancel failed', error)
          return NextResponse.json({ error: 'Failed to cancel session' }, { status: 500 })
        }
      },
    },

    {
      method: 'POST',
      path: '/bankid/link',
      // skipAuth: false — requires existing Supabase session
      handler: async (request: Request, ctx?) => {
        try {
          const body = await request.json()
          const { sessionId } = body

          if (!sessionId || !ctx?.userId) {
            return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
          }

          // Verify BankID session
          const session = await collectBankIdResult(sessionId)
          if (session.status !== 'complete' || !session.user) {
            return NextResponse.json(
              { error: 'session_invalid', message: 'BankID session is not complete' },
              { status: 400 }
            )
          }

          const { personalNumber, givenName, surname } = session.user
          const pnrHash = hashPersonalNumber(personalNumber)
          const supabase = createServiceClient()

          // Check personnummer not already linked to another user
          const { data: existing } = await supabase
            .from('bankid_identities')
            .select('user_id')
            .eq('personal_number_hash', pnrHash)
            .single()

          if (existing && existing.user_id !== ctx.userId) {
            return NextResponse.json(
              { error: 'already_linked', message: 'This BankID is already linked to another account' },
              { status: 409 }
            )
          }

          if (existing && existing.user_id === ctx.userId) {
            return NextResponse.json({ data: { linked: true, alreadyLinked: true } })
          }

          // Link BankID to current user
          const { error: insertError } = await supabase
            .from('bankid_identities')
            .insert({
              user_id: ctx.userId,
              personal_number_hash: pnrHash,
              personal_number_enc: encryptPersonalNumber(personalNumber),
              given_name: givenName,
              surname,
            })

          if (insertError) {
            log.error('link insert failed', { message: insertError.message, code: insertError.code })
            return NextResponse.json(
              { error: 'Failed to link BankID' },
              { status: 500 }
            )
          }

          // Mark user as BankID-linked (skips TOTP MFA)
          await supabase.auth.admin.updateUserById(ctx.userId, {
            app_metadata: { bankid_linked: true },
          })

          return NextResponse.json({ data: { linked: true } })
        } catch (error) {
          if (error instanceof TICAPIError) {
            log.error('link failed — TIC API error', { statusCode: error.statusCode, code: error.code, message: error.message })
            return NextResponse.json(
              { error: 'service_unavailable', message: 'BankID service is temporarily unavailable' },
              { status: 502 }
            )
          }
          log.error('link failed — unexpected error', error)
          return NextResponse.json(
            { error: 'internal_error', message: 'Failed to link BankID' },
            { status: 500 }
          )
        }
      },
    },

    {
      method: 'POST',
      path: '/bankid/unlink',
      // skipAuth: false — requires existing Supabase session
      handler: async (_request: Request, ctx?) => {
        try {
          if (!ctx?.userId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
          }

          const supabase = createServiceClient()

          // Delete bankid_identities row
          const { error: deleteError } = await supabase
            .from('bankid_identities')
            .delete()
            .eq('user_id', ctx.userId)

          if (deleteError) {
            log.error('unlink delete failed', { message: deleteError.message, code: deleteError.code })
            return NextResponse.json({ error: 'Failed to unlink BankID' }, { status: 500 })
          }

          // Clear app_metadata.bankid_linked so MFA enforcement resumes
          await supabase.auth.admin.updateUserById(ctx.userId, {
            app_metadata: { bankid_linked: false },
          })

          return NextResponse.json({ data: { unlinked: true } })
        } catch (error) {
          log.error('unlink failed', error)
          return NextResponse.json({ error: 'Failed to unlink BankID' }, { status: 500 })
        }
      },
    },
  ],

  eventHandlers: [],
}
