import type { Extension } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import {
  searchCompanyByOrgNumber,
  getBankAccounts,
  getIndustryCodes,
  getEmails,
  getPhones,
  getCompanyPurpose,
  getCompanyDocuments,
  getFiscalYears,
  getPayrolls,
  getSignatory,
  getRepresentatives,
  getCompanyStatus,
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
import type { TICCompanyProfile, TICFinancialReportSummary } from './lib/tic-types'
import {
  BANKID_FLOW_ID_HEADER,
  FLOW_VERIFIED_WINDOW_SECONDS,
  FLOW_WINDOW_SECONDS,
  clearBankIdFlowCookies,
  isBankIdFlowMode,
  readBankIdFlow,
  setBankIdFlowCookies,
} from './lib/bankid-flow-cookie'
import { lookupCompanyByOrgNumber, registrationDateToMs } from './lib/lookup'
import {
  hasForeignCredential,
  isUnadoptedPendingAccount,
  revokePendingIdentity,
} from './lib/bankid-pending'
import { sendBankIdSignupConfirmation } from './lib/bankid-confirmation-mail'
import { mintPendingSession, signupRequiresMailConfirmation } from './lib/bankid-session-grant'
import { bankIdPendingRoutes, sendPendingVerificationMail } from './lib/bankid-pending-routes'
import { hashPersonalNumber, encryptPersonalNumberForStorage } from '@/lib/auth/bankid'
import {
  evaluateBrandSignupGate,
  readInviteTokenFromCookieHeader,
} from '@/lib/auth/brand-signup-gate'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import crypto from 'crypto'

const log = createLogger('tic/bankid')

const SIGNUP_FAILED = { error: 'internal_error', message: 'Kunde inte skapa kontot. Försök igen.' }

/** Host the browser is on, as the proxy forwarded it. '' when unknown. */
function forwardedHost(request: Request): string {
  return request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
}

/**
 * Login attempt by a BankID identity whose address was never proven
 * (`email_verified_at IS NULL`, see lib/bankid-pending.ts). Never mints a
 * session. Two outcomes:
 *
 *  - The account has since been adopted through another credential (the real
 *    owner of the address set a password or signed in with Google): the
 *    pending link is revoked so it can never be promoted, and the BankID
 *    holder is told there is no account, which for them is now true.
 *  - Otherwise the account is still the unconfirmed shell the signup made:
 *    the confirmation mail is re-sent (best effort; every attempt costs a
 *    BankID identification, which bounds the volume) and the caller is asked
 *    to confirm first. The message surfaces in the login page, so Swedish.
 */
async function refusePendingLogin(
  supabase: SupabaseClient,
  userId: string,
  user: User | null | undefined,
  names: { givenName?: string; surname?: string },
  request: Request,
): Promise<NextResponse> {
  if (!user || hasForeignCredential(user)) {
    if (user) {
      log.warn('pending bankid identity revoked at login: account adopted by another credential', {
        userId,
      })
    }
    await revokePendingIdentity(supabase, userId, user?.app_metadata)
    return NextResponse.json({ error: 'no_account', ...names }, { status: 404 })
  }

  if (user.email) {
    // /auth/callback only looks for a pending identity when the flag is set.
    // Rows created by the old flow (before the column existed) have the flag
    // missing; heal it here so the re-sent mail can actually promote them.
    if (user.app_metadata?.bankid_pending !== true) {
      await supabase.auth.admin.updateUserById(userId, {
        app_metadata: { ...(user.app_metadata ?? {}), bankid_pending: true },
      })
    }
    const sent = await sendBankIdSignupConfirmation({
      supabase,
      email: user.email,
      host: forwardedHost(request),
      proto: request.headers.get('x-forwarded-proto'),
    })
    if (!sent.ok) {
      log.warn('could not re-send bankid confirmation mail', { userId, step: sent.step })
    }
  }

  return NextResponse.json(
    {
      error: 'email_unconfirmed',
      message:
        'Bekräfta din e-postadress först. Vi har skickat ett nytt bekräftelsemail till adressen du angav när kontot skapades.',
    },
    { status: 403 }
  )
}

/**
 * The same BankID signs up again while an earlier signup is still pending
 * (typo'd address, lost mail). Clear the stale link so this attempt can start
 * over with the address typed now. The stale account is deleted outright only
 * while it is still the unconfirmed shell the signup made (bankid_identities
 * cascades); if somebody else has adopted it in the meantime, only the BankID
 * link is removed and their account is left alone. False = could not clear.
 */
async function clearStalePendingSignup(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await supabase.auth.admin.getUserById(userId)
  const user = data?.user

  if (user && isUnadoptedPendingAccount(user)) {
    const { error } = await supabase.auth.admin.deleteUser(userId)
    if (error) {
      log.error('could not delete stale pending bankid signup', { userId, message: error.message })
      return false
    }
    log.info('stale pending bankid signup deleted for re-signup', { userId })
    return true
  }

  if (user) {
    log.warn('pending bankid identity revoked at re-signup: account adopted by another credential', {
      userId,
    })
  }
  return revokePendingIdentity(supabase, userId, user?.app_metadata)
}

/**
 * Claim a BankID session, atomically and exactly once.
 *
 * The flow lives in a cookie now, so every tab of the browser shares one
 * session and two of them can observe `status: complete` in the same poll tick.
 * Both would call generateLink(), and the second magic link invalidates the
 * first, so the tab the user is actually looking at may be the one that fails.
 * Expiring the cookie on the way out does not prevent it: a Set-Cookie only
 * applies once a response reaches the browser, and two requests that already
 * carried the cookie both pass. The primary key is the only genuinely atomic
 * thing available (serverless has no shared memory), so the loser of the race
 * gets 23505 and stops before minting anything.
 *
 * Returns false when the session was already spent.
 */
async function consumeBankIdSession(
  supabase: SupabaseClient,
  sessionId: string
): Promise<boolean> {
  const { error } = await supabase
    .from('bankid_consumed_sessions')
    .insert({ session_id: sessionId })

  if (!error) return true
  // 23505 unique_violation: another request got here first.
  if (error.code === '23505') return false

  // Anything else (table missing, connection lost) must fail closed: minting a
  // second magic link is worse than making the user authenticate again.
  log.error('could not claim bankid session; refusing to complete', {
    code: error.code,
    message: error.message,
  })
  return false
}

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
 * Non-blocking: any failure is logged and swallowed: BankID auth must still
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
    // not a real HTTP error). The message is misleading: it does NOT mean
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
      // Log the full response shape (sans secureUrl, time-limited token)
      // so we can diagnose why a real-user enrichment comes back non-usable.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { secureUrl: _omit, ...responseDiagnostic } = enrichment

      // Interpret common failure shapes into actionable hints so developers
      // don't have to re-trace this every time. TIC returns these as body
      // fields with HTTP 200, not as errors: see TIC_AUTH.md §enrichment.
      const errField = (enrichment as { error?: string }).error ?? ''
      let hint: string | undefined
      if (errField === 'Session not completed') {
        // Two distinct causes produce this identical error:
        //   1. We requested a type not enabled on the tenant (most common,
        //      verify via GET /api/v1/enrichment/types)
        //   2. The BankID session genuinely never went through the
        //      consent-to-enrich dialog
        hint = 'Likely cause: a requested enrichment type is not enabled on the TIC tenant. Run `curl -H "X-Api-Key: $KEY" https://id.tic.io/api/v1/enrichment/types` to verify which types have `enabled: true` and adjust the requestEnrichment call to match.'
      } else if (errField.toLowerCase().includes('not enabled')) {
        hint = 'Enrichment explicitly disabled on TIC tenant: contact support@tic.io.'
      } else if (errField.toLowerCase().includes('too old')) {
        hint = '>30 min between auth completion and enrichment call: check for slow server-side work between /bankid/complete and fetchAndStoreEnrichment.'
      }

      log.warn('enrichment not usable', { ...responseDiagnostic, hint })
      return
    }

    const enrichmentData = await fetchEnrichmentData(enrichment.secureUrl)

    // Log a PII-free snapshot so we can debug the role filter in production.
    // Raw personnummer / names / address values are deliberately omitted:
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

/**
 * Map a v2 `CompanyDocument` (financial-report subset) into the legacy
 * `TICFinancialReportSummary` shape consumed by TicWorkspace. v2 nests
 * the metadata under `financialReportMetadata` and replaces v1's
 * `isAudited` boolean / `auditOpinion` string with auditor identity
 * fields: we derive `isAudited` from the presence of an auditor.
 */
function toFinancialReportSummary(
  doc: import('./lib/tic-types').TICDocument
): TICFinancialReportSummary {
  const meta = doc.financialReportMetadata ?? {}
  const hasAuditor = Boolean(meta.auditor || meta.auditorFullName || meta.auditCompanyName)
  return {
    title: doc.type === 'annualReport' ? 'Årsredovisning' : doc.type,
    arrivalDate: meta.arrivalDate ?? undefined,
    registrationDate: meta.registrationDate ?? undefined,
    periodStart: meta.periodStart ?? undefined,
    periodEnd: meta.periodEnd ?? undefined,
    isInterimReport: meta.isInterimReport ?? undefined,
    isConsolidatedAccounts: meta.isConsolidatedAccounts ?? undefined,
    isAudited: hasAuditor ? true : undefined,
    auditOpinion: meta.auditorFullName ?? meta.auditCompanyName ?? undefined,
  }
}

/**
 * Translate any error from the TIC pipeline into a structured HTTP response.
 *
 * Status mapping:
 *   - NOT_CONFIGURED       → 503 (proxy URL missing)
 *   - RATE_LIMIT_EXCEEDED  → 429 (TIC quota hit)
 *   - TIMEOUT              → 504 (TIC took longer than 15s)
 *   - upstream 4xx         → 400 (TIC rejected the input: typically a malformed org number)
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
      // BankID picker): user is authenticated but does not yet have a
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
          // Single Lens call: the search-public document already includes
          // sniCodes, bankAccounts, emailAddresses, phoneNumbers, and the
          // registration flags at the top level: we used to fan out to
          // five dedicated endpoints for the same data (6 calls total) and
          // the 3 000/mo TIC budget couldn't sustain it. This endpoint now
          // costs ~1 call. Fiscal-year MM-DD is derived from
          // mostRecentFinancialSummary.periodStart/periodEnd when present;
          // newly-registered companies without a financial summary return
          // fiscalYear: null and the client-side first-year derivation
          // takes over (see deriveFirstYearDefaults).
          const result = await lookupCompanyByOrgNumber(orgNumber)

          if (!result) {
            return NextResponse.json(
              { error: 'Company not found' },
              { status: 404 }
            )
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
      // Used during onboarding to render richer company profile details:
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

          // Phase 2: ONLY data not already present at the top level of the
          // search doc. We dropped bank-accounts, industries, email-addresses,
          // phone-numbers, purposes, and signatory: those duplicate the
          // search-doc fields and were burning 6 Lens calls per /profile
          // for nothing. Per-/profile cost: 13 → 7 calls.
          const [
            documentsResult,
            fiscalYearResult,
            payrollsResult,
            representativesResult,
            statusResult,
            beneficialOwnersResult,
          ] = await Promise.allSettled([
            getCompanyDocuments(companyId),
            getFiscalYears(companyId),
            getPayrolls(companyId),
            getRepresentatives(companyId),
            getCompanyStatus(companyId),
            getBeneficialOwners(companyId),
          ])

          // Bankgiro list from search-doc (v2 `bankAccounts` array with
          // `{accountNumber, bankAccountType}`).
          const bankAccounts = (doc.bankAccounts ?? [])
            .filter((ba) => ba.accountNumber != null && ba.bankAccountType === 'bankgiro')
            .map((ba) => ({
              type: 'bankgiro',
              accountNumber: String(ba.accountNumber),
              bic: null,
            }))

          // SNI codes from search-doc (`sniCodes` array with `sni_2007Code`).
          const sniCodes = (doc.sniCodes ?? [])
            .filter((s) => s.sni_2007Code)
            .map((s) => ({
              code: s.sni_2007Code ?? '',
              name: s.sni_2007Name ?? '',
            }))

          const email = doc.emailAddresses?.[0]?.emailAddress ?? null

          const phone =
            doc.phoneNumbers?.[0]?.phoneNumberFormatted
              ?? doc.phoneNumbers?.[0]?.e164PhoneNumber
              ?? null

          // v2 `/companies/{id}/documents` returns every document the
          // company has filed; filter to annualReport rows and map into
          // the legacy summary shape the workspace expects. Kept as a
          // dedicated call: doc.documents has a different shape
          // (`companyDocumentType` vs `type`) so direct substitution
          // would silently drop annualReport detection.
          const financialReports =
            documentsResult.status === 'fulfilled' && documentsResult.value
              ? documentsResult.value
                  .filter((d) => d.type === 'annualReport')
                  .map(toFinancialReportSummary)
              : []

          // Purpose: take `doc.mostRecentPurpose` directly. Dropped the
          // /purposes call (which sorted history descending and picked
          // the latest non-empty entry): the search doc's
          // mostRecentPurpose is the same most-recently-registered string.
          const purpose = doc.mostRecentPurpose ?? null

          // ── New v2 sections ─────────────────────────────────────────
          // Fiscal years: pick most-recently-updated row with both
          // start and end populated, plus a deduped history of distinct
          // start/end pairs sorted newest first.
          const fiscalYearRows =
            fiscalYearResult.status === 'fulfilled' && fiscalYearResult.value
              ? [...fiscalYearResult.value].sort((a, b) =>
                  (b.lastUpdatedAtUtc ?? '').localeCompare(a.lastUpdatedAtUtc ?? '')
                )
              : []
          const fiscalYearCurrent = fiscalYearRows.find(
            (fy) => fy.startMonthDay && fy.endMonthDay
          )
          const fiscalYear = fiscalYearCurrent
            ? {
                startMonthDay: fiscalYearCurrent.startMonthDay ?? null,
                endMonthDay: fiscalYearCurrent.endMonthDay ?? null,
                description: fiscalYearCurrent.startEndDescription ?? null,
              }
            : null

          const fiscalYearHistorySeen = new Set<string>()
          const fiscalYearHistory: import('./lib/tic-types').TICProfileFiscalYear[] = []
          for (const fy of fiscalYearRows) {
            if (!fy.startMonthDay && !fy.endMonthDay) continue
            const key = `${fy.startMonthDay ?? ''}|${fy.endMonthDay ?? ''}`
            if (fiscalYearHistorySeen.has(key)) continue
            fiscalYearHistorySeen.add(key)
            fiscalYearHistory.push({
              startMonthDay: fy.startMonthDay ?? null,
              endMonthDay: fy.endMonthDay ?? null,
              description: fy.startEndDescription ?? null,
            })
          }

          // Signatory: free-form firmateckning descriptions. v2 search doc
          // exposes `mostRecentSignatory` directly (single entry). Drops the
          // dedicated /signatory call: historical signatory entries are rare
          // to use in onboarding and the current entry is what the review
          // card surfaces.
          const signatory = (() => {
            const desc = doc.mostRecentSignatory?.signatureDescription?.trim()
            return desc ? [{ description: desc }] : []
          })()

          // Board summary: most recently updated row from
          // representativeInformation
          const reprInfoRows =
            representativesResult.status === 'fulfilled' && representativesResult.value?.representativeInformation
              ? [...representativesResult.value.representativeInformation].sort((a, b) =>
                  (b.lastUpdatedAtUtc ?? '').localeCompare(a.lastUpdatedAtUtc ?? '')
                )
              : []
          const reprInfo = reprInfoRows[0]
          const board = reprInfo
            ? {
                numberOfBoardMembers: reprInfo.numberOfBoardMembers ?? null,
                numberOfDeputyBoardMembers: reprInfo.numberOfDeputyBoardMembers ?? null,
                hasVacancy: reprInfo.hasVacancy ?? null,
                missingCEODate: reprInfo.missingCEODate ?? null,
                missingAuditor: reprInfo.missingAuditor ?? null,
                lastChangeDate: reprInfo.lastChangeDate ?? null,
              }
            : null

          // Representatives: filter to currently-active positions
          // (positionEnd null or in the future) sorted by start date desc
          const nowIso = new Date().toISOString()
          const representatives =
            representativesResult.status === 'fulfilled' && representativesResult.value?.representatives
              ? representativesResult.value.representatives
                  .filter((p) => !p.positionEnd || p.positionEnd > nowIso)
                  .sort((a, b) => (b.positionStart ?? '').localeCompare(a.positionStart ?? ''))
                  .map((p) => ({
                    name: p.roleByPersonName ?? null,
                    positionType: p.positionType ?? null,
                    positionDescription: p.positionDescription ?? null,
                    positionStart: p.positionStart ?? null,
                    positionEnd: p.positionEnd ?? null,
                  }))
              : []

          // Payrolls: map the modern payroll2 array, newest first
          const payrolls =
            payrollsResult.status === 'fulfilled' && payrollsResult.value?.payroll2
              ? [...payrollsResult.value.payroll2]
                  .sort((a, b) => (b.periodEnd ?? '').localeCompare(a.periodEnd ?? ''))
                  .map((p) => ({
                    periodStart: p.periodStart ?? null,
                    periodEnd: p.periodEnd ?? null,
                    numberOfEmployees: p.numberOfEmployees ?? null,
                    sumPayrollTax: p.sumPayrollTax ?? null,
                    calculatedPersonnelCosts: p.calculatedPersonnelCosts ?? null,
                    personnelCostsInAnnualReport: p.personnelCostsInAnnualReport ?? null,
                    deviation: p.deviation ?? null,
                    numberOfLateFeesForPeriod: p.numberOfLateFeesForPeriod ?? null,
                  }))
              : []

          // Statuses: most recent first; map traffic-light color through
          // unchanged so the UI can render a badge.
          const statuses: import('./lib/tic-types').TICProfileStatus[] =
            statusResult.status === 'fulfilled' && statusResult.value
              ? [...statusResult.value]
                  .sort((a, b) => (b.statusDate ?? '').localeCompare(a.statusDate ?? ''))
                  .map((s) => {
                    const color = s.statusColor
                    const validColor: 'red' | 'yellow' | 'green' | 'neutral' | null =
                      color === 'red' || color === 'yellow' || color === 'green' || color === 'neutral'
                        ? color
                        : null
                    return {
                      code: s.companyStatusDescription?.code ?? null,
                      description:
                        s.companyStatusDescription?.name_SE
                          ?? s.statusDescription
                          ?? s.companyStatusDescription?.name_EN
                          ?? null,
                      color: validColor,
                      statusDate: s.statusDate ?? null,
                      isCeased: s.companyStatusDescription?.isCeased ?? null,
                    }
                  })
              : []

          // Log Phase 2 failures
          if (documentsResult.status === 'rejected') {
            log.warn('[tic] profile: documents fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(documentsResult.reason) })
          }
          if (fiscalYearResult.status === 'rejected') {
            log.warn('[tic] profile: fiscal years fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(fiscalYearResult.reason) })
          }
          if (payrollsResult.status === 'rejected') {
            log.warn('[tic] profile: payrolls fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(payrollsResult.reason) })
          }
          if (representativesResult.status === 'rejected') {
            log.warn('[tic] profile: representatives fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(representativesResult.reason) })
          }
          if (statusResult.status === 'rejected') {
            log.warn('[tic] profile: status fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(statusResult.reason) })
          }
          if (beneficialOwnersResult.status === 'rejected') {
            log.warn('[tic] profile: beneficial-owners fetch failed', { orgNumber: cleanedOrgNumber, companyId, reason: String(beneficialOwnersResult.reason) })
          }

          // Flatten the beneficial-owners response. Bolagsverket returns one
          // notification per registration event; the latest active
          // notification's owners are the current ones. v2 returns the
          // notifications as a top-level array (v1's wrapper with
          // `.notifications` / `.exempts` is gone). Personnummer is
          // intentionally excluded: PII we don't need cached and we
          // don't want it persisted on `companies.tic_snapshot`.
          let beneficialOwners: TICCompanyProfile['beneficialOwners'] = []
          if (beneficialOwnersResult.status === 'fulfilled' && beneficialOwnersResult.value) {
            const notifications = Array.isArray(beneficialOwnersResult.value)
              ? beneficialOwnersResult.value
              : []
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

          // Translate v2's activityStatus enum into the v1 string the
          // TicWorkspace `!== 'ceased'` check still compares against, so
          // the UI keeps showing "Avregistrerat" for deregistered
          // companies without UI changes.
          const isCeasedProfile = doc.isCeased ?? doc.activityStatus === 'isNoLongerActive'
          const profile: TICCompanyProfile = {
            companyId,
            orgNumber: doc.registrationNumber,
            companyName,
            legalEntityType: doc.legalEntityType,
            registrationDate: registrationDateToMs(doc.registrationDate) ?? 0,
            activityStatus: isCeasedProfile ? 'ceased' : (doc.activityStatus ?? null),
            purpose,
            address: doc.mostRecentRegisteredAddress
              ? {
                  street: doc.mostRecentRegisteredAddress.streetAddress ?? null,
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
            financials,
            financialReports,
            fiscalYear,
            fiscalYearHistory,
            signatory,
            board,
            representatives,
            payrolls,
            statuses,
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

          // The flow a session is opened for is fixed here and read back at
          // /complete, so a 'link' session can never be finished as a 'login'.
          // Validated before the rate limit: a malformed request starts no
          // billable session, so it should not spend the caller's cooldown and
          // lock them out of the retry that would have worked.
          const body = await request.json().catch(() => ({}))
          const mode = body?.mode
          if (!isBankIdFlowMode(mode)) {
            return NextResponse.json({ error: 'mode is required' }, { status: 400 })
          }

          // A link flow is owned by the user who opened it. /bankid/link binds
          // the personnummer to whoever is authenticated when it runs, so an
          // unowned link flow left behind in a shared browser would let the
          // next person to sign in pick it up and bind the FIRST person's
          // identity to their own account. Login and signup have no user yet
          // and stay anonymous.
          let userId: string | undefined
          if (mode === 'link') {
            const auth = await requireAuth()
            if (auth.error) return auth.error
            userId = auth.user.id
          }

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
          const flowId = crypto.randomUUID()

          // sessionId is deliberately NOT in the response. It is a bearer
          // credential for the holder's personnummer and for a Supabase
          // session; it goes into the signed HttpOnly cookie instead, and the
          // client drives the flow without ever seeing it.
          const response = NextResponse.json({
            data: {
              flowId,
              autoStartToken: session.autoStartToken,
              qrStartToken: session.qrStartToken,
              qrStartSecret: session.qrStartSecret,
            },
          })
          await setBankIdFlowCookies(response, {
            version: 1,
            sessionId: session.sessionId,
            flowId,
            mode,
            userId,
            startedAt: Date.now(),
            expiresAt: Date.now() + FLOW_WINDOW_SECONDS * 1000,
          })
          return response
        } catch (error) {
          if (error instanceof TICAPIError) {
            if (error.code === 'NOT_CONFIGURED') {
              return NextResponse.json({ error: 'not_configured', message: 'BankID is not configured' }, { status: 503 })
            }
            if (error.code === 'RATE_LIMIT_EXCEEDED') {
              return NextResponse.json({ error: 'rate_limit', message: 'Rate limit exceeded' }, { status: 429 })
            }
            if (error.code === 'TIMEOUT') {
              log.error('start timed out: TIC Identity API unreachable', { statusCode: error.statusCode })
              return NextResponse.json({ error: 'service_unavailable', message: 'BankID service is not responding' }, { status: 503 })
            }
            // TIC API returned an error (e.g. 5xx)
            log.error('start failed: TIC API error', { statusCode: error.statusCode, code: error.code, message: error.message })
            return NextResponse.json({ error: 'service_unavailable', message: 'BankID service is temporarily unavailable' }, { status: 502 })
          }
          log.error('start failed: unexpected error', error)
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
          const flow = await readBankIdFlow(request)
          if (!flow) {
            // No live flow in this browser: the tab is polling something that
            // has finished, expired, or never belonged to it. Terminal, not an
            // error, so the client can settle instead of spinning.
            return NextResponse.json({ error: 'no_session' }, { status: 404 })
          }

          // The caller says which mode it is showing, and a flow only answers
          // to its own. Without this a login session started on /login is
          // picked up by the signup panel (or the reverse) whenever the user
          // navigates between them. Deliberately NOT clearing: the flow is
          // still legitimate for the page that started it.
          const pollBody = await request.json().catch(() => ({}))
          if (!isBankIdFlowMode(pollBody?.mode) || pollBody.mode !== flow.mode) {
            return NextResponse.json({ error: 'no_session' }, { status: 404 })
          }
          const isProbe = pollBody?.probe === true

          // The cookie is shared by every tab. A newer same-mode /start can
          // replace it while an older tab is still polling, so mode alone is
          // not enough: without the flow id, that stale tab would silently
          // follow and complete the newer person's identification. A mount
          // probe has no id yet and may discover it, but every active poll must
          // present the id returned by /start or by that probe.
          if (!isProbe && request.headers.get(BANKID_FLOW_ID_HEADER) !== flow.flowId) {
            return NextResponse.json({ error: 'no_session' }, { status: 404 })
          }

          let result: Awaited<ReturnType<typeof pollBankIdSession>>
          try {
            result = await pollBankIdSession(flow.sessionId)
          } catch (error) {
            // TIC no longer knows this session (404), or answered 410 for an
            // expired one. Report it as no_session so the client settles
            // instead of counting it as a service outage.
            //
            // Deliberately does NOT clear the cookie. A clearing Set-Cookie is
            // untargeted: a slow response about a dead session would delete
            // whatever flow is in the jar by the time it lands, including one
            // the user has just started in another tab. The stale cookie is
            // harmless (it answers no_session again and expires on its own),
            // whereas deleting a live flow costs a billable session.
            if (error instanceof TICAPIError && (error.statusCode === 404 || error.statusCode === 410)) {
              return NextResponse.json({ error: 'no_session' }, { status: 404 })
            }
            throw error
          }

          // An expired-session body comes back with no `status` at all
          // (identityFetch returns a 410 body verbatim). Same treatment.
          if (!result?.status) {
            return NextResponse.json({ error: 'no_session' }, { status: 404 })
          }

          if (result.status !== 'pending') {
            log.info('poll status', { status: result.status, hintCode: result.hintCode, hasUser: !!result.user?.personalNumber })
          }

          // Whitelist the fields the UI renders. The raw TIC payload carries
          // user.personalNumber, which the client has never used and must
          // never receive: this endpoint is skipAuth, so anything it returns
          // is readable by whoever holds the flow cookie.
          //
          // The name (givenName/surname) is withheld from a PROBE. A probe runs
          // before the person here has confirmed the flow is theirs, so
          // returning the name would hand a stranger's identity to whoever
          // opened the page on a shared machine, defeating the confirm card.
          // The signup e-mail step needs the name, but it is reached only
          // through the active poll loop (no probe mode), which does get it.
          const response = NextResponse.json({
            data: {
              flowId: isProbe ? flow.flowId : undefined,
              status: result.status,
              message: result.message,
              hintCode: result.hintCode,
              qrStartToken: result.qrStartToken,
              qrStartSecret: result.qrStartSecret,
              user: !isProbe && result.user
                ? { givenName: result.user.givenName, surname: result.user.surname }
                : undefined,
            },
          })

          // A failed or cancelled order is over. Not cleared here for the same
          // reason as the dead-session branch above: the Set-Cookie cannot be
          // aimed at one flow, so a late response would delete a newer one.
          // The client settles on this status, and the cookie expires.
          if (result.status === 'complete') {
            // Identification is done; what remains is the signup e-mail step,
            // which is a person typing. Re-issue with the longer window so a
            // user hunting for the right address does not have the session
            // expire under them: on the old client-state design this step was
            // bounded only by TIC's own retention.
            await setBankIdFlowCookies(response, {
              ...flow,
              expiresAt: Date.now() + FLOW_VERIFIED_WINDOW_SECONDS * 1000,
            })
          }
          return response
        } catch (error) {
          if (error instanceof TICAPIError) {
            if (error.code === 'RATE_LIMIT_EXCEEDED') {
              return NextResponse.json({ error: 'rate_limit', message: 'Rate limit exceeded' }, { status: 429 })
            }
            if (error.code === 'TIMEOUT') {
              log.error('poll timed out: TIC Identity API unreachable')
              return NextResponse.json({ error: 'service_unavailable', message: 'BankID service is not responding' }, { status: 503 })
            }
            log.error('poll failed: TIC API error', { statusCode: error.statusCode, code: error.code, message: error.message })
            return NextResponse.json({ error: 'service_unavailable', message: 'BankID service is temporarily unavailable' }, { status: 502 })
          }
          log.error('poll failed: unexpected error', error)
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
          // Session id and mode come from the signed cookie, never the body:
          // a caller who could name both could complete any session it had
          // seen, in whatever flow suited it.
          const flow = await readBankIdFlow(request)
          if (!flow) {
            return NextResponse.json(
              { error: 'session_invalid', message: 'BankID-sessionen är inte längre giltig. Försök igen.' },
              { status: 400 }
            )
          }
          const { sessionId, mode } = flow

          // The shared cookie may have been replaced by a newer flow after
          // this tab started. Only the tab that started or explicitly resumed
          // the current flow may complete it.
          if (request.headers.get(BANKID_FLOW_ID_HEADER) !== flow.flowId) {
            return NextResponse.json(
              { error: 'session_invalid', message: 'BankID-sessionen är inte längre giltig. Försök igen.' },
              { status: 400 }
            )
          }

          if (mode === 'link') {
            // Linking runs on the authenticated /bankid/link route, which
            // proves who is being linked. Completing a link flow here would
            // create or sign in an account off a session opened for something
            // else entirely.
            return NextResponse.json(
              { error: 'session_invalid', message: 'BankID-sessionen är inte längre giltig. Försök igen.' },
              { status: 400 }
            )
          }

          const body = await request.json().catch(() => ({}))
          const trimmedEmail = typeof body?.email === 'string'
            ? body.email.trim().toLowerCase()
            : undefined

          if (mode === 'signup' && !trimmedEmail) {
            return NextResponse.json(
              { error: 'email is required for signup' },
              { status: 400 }
            )
          }

          /**
           * Every exit from here clears the flow, so a session is usable
           * exactly once. Two tabs that both observe completion cannot both
           * mint a magic link: the second finds no cookie and gets
           * session_invalid, instead of a generateLink that silently
           * invalidates the first tab's link and breaks the sign-in.
           */
          const settle = (response: NextResponse): NextResponse => {
            clearBankIdFlowCookies(response)
            return response
          }

          // Verify BankID session is complete. The message surfaces directly
          // in the register-page toast, so it must be Swedish.
          const session = await collectBankIdResult(sessionId)
          if (session.status !== 'complete' || !session.user) {
            return settle(NextResponse.json(
              { error: 'session_invalid', message: 'BankID-sessionen är inte längre giltig. Försök igen.' },
              { status: 400 }
            ))
          }

          const { personalNumber, givenName, surname, name } = session.user
          const pnrHash = hashPersonalNumber(personalNumber)
          const supabase = createServiceClient()

          // Look up existing BankID identity. email_verified_at NULL means the
          // address on the account was never proven (pending signup): such an
          // identity signs nobody in and is not "linked" for signup purposes.
          const { data: existing, error: lookupError } = await supabase
            .from('bankid_identities')
            .select('user_id, email_verified_at')
            .eq('personal_number_hash', pnrHash)
            .single()

          // PGRST116 is .single() finding no row, which is the normal "not
          // linked" answer. Anything else (schema behind the code, connection
          // lost) must not read as "no account": that would send every
          // returning BankID user to signup. Not settled, so the completed
          // identification survives a retry.
          if (lookupError && lookupError.code !== 'PGRST116') {
            log.error('bankid_identities lookup failed', {
              code: lookupError.code,
              message: lookupError.message,
            })
            return NextResponse.json(
              { error: 'service_unavailable', message: 'Tillfälligt fel. Försök igen om en stund.' },
              { status: 503 }
            )
          }

          if (mode === 'login') {
            if (!existing) {
              // Terminal for a login flow: the user is sent to signup, which
              // starts its own session.
              return settle(NextResponse.json({
                error: 'no_account',
                givenName,
                surname,
              }, { status: 404 }))
            }

            // Returning user. Load the account before deciding anything: a
            // pending identity is refused (never a magic link), see
            // refusePendingLogin.
            const { data: userData } = await supabase.auth.admin.getUserById(existing.user_id)

            if (existing.email_verified_at === null) {
              const pendingUser = userData?.user
              // Adopted by the address owner (or gone): revoke and refuse.
              // Mail-gated mode (rollback flag): refuse and re-send, as
              // before instant login.
              if (
                signupRequiresMailConfirmation() ||
                !pendingUser?.email ||
                hasForeignCredential(pendingUser)
              ) {
                return settle(
                  await refusePendingLogin(
                    supabase,
                    existing.user_id,
                    pendingUser,
                    { givenName, surname },
                    request,
                  )
                )
              }

              // BankID instant login: the holder is proven, only the mailbox
              // is not. Sign them in with a password grant (never a magic
              // link: that would void the verification mail in flight, see
              // bankid-session-grant.ts) and keep the identity pending.
              if (!await consumeBankIdSession(supabase, sessionId)) {
                return settle(NextResponse.json(
                  { error: 'session_invalid', message: 'BankID-sessionen är inte längre giltig. Försök igen.' },
                  { status: 400 }
                ))
              }

              // Rows from the old flow may lack the flag; /auth/callback,
              // the MFA gate and the invite acceptance all key on it.
              if (pendingUser.app_metadata?.bankid_pending !== true) {
                await supabase.auth.admin.updateUserById(existing.user_id, {
                  app_metadata: { ...(pendingUser.app_metadata ?? {}), bankid_pending: true },
                })
              }

              const minted = await mintPendingSession(supabase, existing.user_id, pendingUser.email)
              if (!minted.ok) {
                return settle(NextResponse.json(
                  { error: 'Failed to create session' },
                  { status: 500 }
                ))
              }

              await fetchAndStoreEnrichment(sessionId, existing.user_id, supabase)

              return settle(NextResponse.json({
                data: {
                  type: 'session',
                  session: minted.session,
                  isNewUser: false,
                  emailPending: true,
                },
              }))
            }

            if (!userData?.user?.email) {
              // Data problem, not a transient one: an identity with no user
              // email will never complete. settle() so it is not re-offered as
              // a resumable flow on the next page load.
              return settle(NextResponse.json(
                { error: 'session_invalid', message: 'User account not found' },
                { status: 500 }
              ))
            }

            // Claim the session BEFORE minting anything. Two tabs sharing this
            // browser's flow cookie can both arrive here; only one may mint,
            // because the second magic link invalidates the first.
            if (!await consumeBankIdSession(supabase, sessionId)) {
              return settle(NextResponse.json(
                { error: 'session_invalid', message: 'BankID-sessionen är inte längre giltig. Försök igen.' },
                { status: 400 }
              ))
            }

            const { data: link, error: linkError } = await supabase.auth.admin.generateLink({
              type: 'magiclink',
              email: userData.user.email,
            })

            if (linkError || !link?.properties?.hashed_token) {
              log.error('generateLink failed for login', { message: linkError?.message, code: linkError?.code })
              // The session is already consumed, so a retry would fail with
              // session_invalid anyway; settle() clears the cookie now instead
              // of leaving a spent flow to be re-offered as resumable.
              return settle(NextResponse.json(
                { error: 'Failed to create session' },
                { status: 500 }
              ))
            }

            // Refresh enrichment so /select-company sees current Bolagsverket roles.
            await fetchAndStoreEnrichment(sessionId, existing.user_id, supabase)

            // settle(): the magic link is minted, so the flow is spent. A
            // second tab reaching here would mint another and invalidate this
            // one; it now gets session_invalid instead.
            return settle(NextResponse.json({
              data: {
                tokenHash: link.properties.hashed_token,
                type: 'magiclink',
                isNewUser: false,
              },
            }))
          }

          // mode === 'signup'
          if (existing && existing.email_verified_at !== null) {
            // Terminal: this BankID already has an account, so the answer is
            // to sign in, not to retry this session.
            return settle(NextResponse.json(
              { error: 'already_linked', message: 'This BankID is already linked to an account' },
              { status: 409 }
            ))
          }

          if (existing) {
            // Pending identity from an earlier signup by this same BankID.
            // Not settled: the identification is still good, only the stale
            // link is in the way. A failure here is transient by nature.
            if (!await clearStalePendingSignup(supabase, existing.user_id)) {
              return NextResponse.json(SIGNUP_FAILED, { status: 500 })
            }
          }

          const host = forwardedHost(request)

          // Invite-only brand domain gate (founder decision 2026-08-27):
          // same rule POST /api/auth/signup enforces on the email path. Runs
          // AFTER the existing-identity check so a returning user's login is
          // never blocked, and before anything is created or consumed:
          // deliberately NOT settled, so the visitor keeps the completed
          // BankID identification if the byrå allowlists them mid-flow.
          const gateResult = await evaluateBrandSignupGate({
            host,
            email: trimmedEmail!,
            inviteToken: readInviteTokenFromCookieHeader(request.headers.get('cookie')),
          })
          if (!gateResult.allowed && 'lookupFailed' in gateResult) {
            // Transient brands-table error: fail safe, do not create the
            // account. Not settled, so the completed BankID flow can retry.
            return NextResponse.json(
              {
                error: 'brand_lookup_failed',
                message: 'Tillfälligt fel. Försök igen om en stund.',
              },
              { status: 503 }
            )
          }
          if (!gateResult.allowed) {
            return NextResponse.json(
              {
                error: 'signup_not_allowed',
                message: 'Registrering på den här domänen kräver inbjudan.',
              },
              { status: 403 }
            )
          }

          // Create new Supabase user. Email uniqueness is checked by createUser
          // itself against auth.users: do NOT pre-check profiles.email instead.
          // The profile mirror can lack the address while the auth row still
          // holds it (anonymize_user_account scrubs profiles.email but keeps the
          // auth tombstone), which used to fall through to a dead-end 500 here.
          //
          // email_confirm: false. The address came from the request body and
          // nothing has proven it belongs to the person holding the BankID.
          // Confirming it here let anyone open an account on a stranger's
          // address and keep a BankID login into it after the stranger adopted
          // it (account pre-hijacking, security audit 2026-09). The address is
          // confirmed by the mail sent below, and only then does the identity
          // count (see lib/bankid-pending.ts).
          const randomPassword = crypto.randomBytes(32).toString('base64url')
          const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
            email: trimmedEmail!,
            email_confirm: false,
            password: randomPassword,
            user_metadata: { full_name: name },
          })

          if (createError || !newUser?.user) {
            // Email already registered (including deleted-account tombstones,
            // which keep their email on purpose): refuse signup. Linking BankID
            // to an existing account must go through the authenticated
            // /bankid/link route so email ownership is proven by password login
            // first. (CWE-287)
            if (createError?.code === 'email_exists') {
              // The session id is a bearer credential for a personnummer at
              // TIC; a prefix is enough to correlate log lines.
              log.warn('bankid signup rejected: email already registered', {
                sessionIdPrefix: sessionId.slice(0, 8),
                pnrHashPrefix: pnrHash.slice(0, 8),
              })
              // Deliberately NOT settled: nothing was consumed and the user
              // may simply have typed the wrong address. Leaving the flow
              // alive lets them correct it without a second BankID round trip.
              return NextResponse.json(
                {
                  error: 'account_exists',
                  message: 'Det finns redan ett konto med den här e-postadressen. Logga in och koppla BankID under Inställningar.',
                },
                { status: 409 }
              )
            }
            log.error('createUser failed', {
              emailHashPrefix: crypto.createHash('sha256').update(trimmedEmail!).digest('hex').slice(0, 8),
              status: createError?.status,
              code: createError?.code,
              message: createError?.message,
            })
            return NextResponse.json(SIGNUP_FAILED, { status: 500 })
          }

          const userId = newUser.user.id

          // All-or-nothing signup: if any step after createUser fails, delete
          // the just-created user so the same email/BankID can retry cleanly.
          // Leaving the half-created account behind strands the user: a retry
          // hits account_exists/already_linked, but the account only has a
          // random password they never saw, so "log in instead" requires a
          // password reset. bankid_identities cascades on user delete.
          const rollbackSignup = async (step: string) => {
            const { error: deleteError } = await supabase.auth.admin.deleteUser(userId)
            if (deleteError) {
              log.error(`signup rollback after failed ${step} could not delete user: orphaned account`, {
                userId,
                message: deleteError.message,
              })
            }
          }

          // Mark the BankID link as PENDING, not linked: bankid_linked (which
          // skips TOTP MFA, lib/auth/mfa.ts) is set by /auth/callback once the
          // confirmation mail is clicked. has_password: false records that the
          // BankID signup gave them a random server-side password they will
          // never see; it gates MFA enrollment (see lib/auth/has-password.ts).
          const { error: metaError } = await supabase.auth.admin.updateUserById(userId, {
            app_metadata: { bankid_pending: true, has_password: false },
          })

          if (metaError) {
            log.error('signup app_metadata update failed', { message: metaError.message, code: metaError.code })
            await rollbackSignup('app_metadata update')
            return NextResponse.json(SIGNUP_FAILED, { status: 500 })
          }

          // Store BankID identity, unverified until the mail is clicked.
          const { error: insertError } = await supabase
            .from('bankid_identities')
            .insert({
              user_id: userId,
              personal_number_hash: pnrHash,
              personal_number_enc: encryptPersonalNumberForStorage(personalNumber),
              given_name: givenName,
              surname,
              email_verified_at: null,
            })

          if (insertError) {
            log.error('insert bankid_identities failed', { message: insertError.message, code: insertError.code })
            await rollbackSignup('bankid_identities insert')
            return NextResponse.json(SIGNUP_FAILED, { status: 500 })
          }

          // Claim the session before mailing. Placed after createUser so the
          // recoverable account_exists path above leaves the flow reusable,
          // and before the mail so two tabs cannot both send one.
          if (!await consumeBankIdSession(supabase, sessionId)) {
            await rollbackSignup('session already consumed')
            return settle(NextResponse.json(
              { error: 'session_invalid', message: 'BankID-sessionen är inte längre giltig. Försök igen.' },
              { status: 400 }
            ))
          }

          if (signupRequiresMailConfirmation()) {
            // Mail-gated mode (rollback flag): the mail is the only way in.
            // The token never reaches the browser: whoever reads that inbox
            // proves the address, and /auth/callback promotes the identity
            // when they click.
            const sent = await sendBankIdSignupConfirmation({
              supabase,
              email: trimmedEmail!,
              host,
              proto: request.headers.get('x-forwarded-proto'),
            })

            if (!sent.ok) {
              log.error('bankid signup confirmation mail failed', { step: sent.step, message: sent.message })
              await rollbackSignup(`confirmation mail (${sent.step})`)
              // The session was already consumed above, so this flow cannot be
              // retried; settle() clears it rather than leaving a spent,
              // rolled-back flow to be re-offered as resumable.
              return settle(NextResponse.json(
                { error: 'internal_error', message: 'Kunde inte skicka bekräftelsemailet. Försök igen.' },
                { status: 500 }
              ))
            }

            // Enrichment (CompanyRoles): pre-fills /select-company picker.
            await fetchAndStoreEnrichment(sessionId, userId, supabase)

            // settle(): account created and the mail is out. The flow is spent.
            // Same shape as POST /api/auth/signup, so the register page can show
            // its existing "check your inbox" screen. No session, no token.
            return settle(NextResponse.json({
              data: {
                status: 'confirmation_sent',
                email: trimmedEmail!,
              },
            }))
          }

          // BankID instant login (default): BankID proved the person, so the
          // holder is signed in now. The mailbox is what the mail proves, and
          // until it does the identity stays pending: no invite acceptance,
          // no company mail, and the address owner can still take the
          // account over (see /auth/callback). The session is minted first
          // because without it the signup is worthless; the mail is best
          // effort because the in-app banner can re-send it.
          const minted = await mintPendingSession(supabase, userId, trimmedEmail!)
          if (!minted.ok) {
            log.error('bankid signup could not mint a session', { step: minted.step, message: minted.message })
            await rollbackSignup(`session mint (${minted.step})`)
            return settle(NextResponse.json(SIGNUP_FAILED, { status: 500 }))
          }

          const sent = await sendPendingVerificationMail(
            supabase,
            { id: userId, email: trimmedEmail!, app_metadata: { bankid_pending: true, has_password: false } },
            request,
          )
          if (!sent.ok) {
            log.warn('bankid signup verification mail failed; the banner offers a re-send', {
              userId,
              step: sent.step,
            })
          }

          // Enrichment (CompanyRoles): pre-fills /select-company picker.
          await fetchAndStoreEnrichment(sessionId, userId, supabase)

          // settle(): account created and signed in. The flow is spent.
          return settle(NextResponse.json({
            data: {
              type: 'session',
              session: minted.session,
              isNewUser: true,
              emailPending: true,
              email: trimmedEmail!,
            },
          }))
        } catch (error) {
          if (error instanceof TICAPIError) {
            log.error('complete failed: TIC API error', { statusCode: error.statusCode, code: error.code, message: error.message })
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
          log.error('complete failed: unexpected error', error)
          return NextResponse.json(
            { error: 'internal_error', message: 'Failed to complete BankID authentication' },
            { status: 500 }
          )
        }
      },
    },

    {
      method: 'POST',
      // Was DELETE /bankid/:sessionId. The id is no longer something the
      // client knows, so cancelling is now "end whatever flow this browser
      // holds": it cannot be aimed at anyone else's session.
      path: '/bankid/cancel',
      skipAuth: true,
      handler: async (request: Request) => {
        // A malformed cookie must still be clearable rather than turning
        // Avbryt into a 500.
        const flow = await readBankIdFlow(request).catch(() => null)

        if (flow && request.headers.get(BANKID_FLOW_ID_HEADER) !== flow.flowId) {
          // A newer tab replaced the shared cookie. This caller may settle its
          // own stale UI, but it must not cancel or clear the newer flow.
          return NextResponse.json({ data: { cancelled: false, replaced: true } })
        }

        const response = NextResponse.json({ data: { cancelled: true } })
        clearBankIdFlowCookies(response)

        if (flow) {
          try {
            await cancelBankIdSession(flow.sessionId)
          } catch (error) {
            log.error('cancel failed', error)
          }
        }
        return response
      },
    },

    {
      method: 'POST',
      path: '/bankid/link',
      // Requires a Supabase session but NOT a company: a user who just
      // signed up (or hasn't finished onboarding) must be able to manage
      // their BankID connection from /settings/account. Without this flag
      // the dispatcher's requireCompanyId() throws 'No company context'
      // for zero-company users. skipCompanyContext dispatches without ctx,
      // so the handler resolves the caller itself via requireAuth() (same
      // MFA/AAL2 enforcement the dispatcher applies).
      skipCompanyContext: true,
      handler: async (request: Request) => {
        try {
          const auth = await requireAuth()
          if (auth.error) return auth.error
          const userId = auth.user.id

          // Cookie, not body, and the mode must be the one the session was
          // opened for. Otherwise a session started to sign SOMEONE ELSE in
          // could be redirected into binding their personnummer to whoever is
          // currently logged in on this browser.
          const flow = await readBankIdFlow(request)
          if (!flow || flow.mode !== 'link') {
            return NextResponse.json(
              { error: 'session_invalid', message: 'BankID session is not complete' },
              { status: 400 }
            )
          }

          if (request.headers.get(BANKID_FLOW_ID_HEADER) !== flow.flowId) {
            return NextResponse.json(
              { error: 'session_invalid', message: 'BankID session is not complete' },
              { status: 400 }
            )
          }

          // The flow must belong to the caller. Mode alone is not enough: this
          // route binds a personnummer to whoever is authenticated right now,
          // so a link flow that someone else started and abandoned in this
          // browser would otherwise bind THEIR identity to THIS account, and
          // they could then sign in as this user with their own BankID.
          if (flow.userId !== userId) {
            log.warn('bankid link rejected: flow belongs to another user')
            return NextResponse.json(
              { error: 'session_invalid', message: 'BankID session is not complete' },
              { status: 400 }
            )
          }
          const { sessionId } = flow

          /** Linking is single-use for the same reason completing is. */
          const settle = (response: NextResponse): NextResponse => {
            clearBankIdFlowCookies(response)
            return response
          }

          // Verify BankID session
          const session = await collectBankIdResult(sessionId)
          if (session.status !== 'complete' || !session.user) {
            return settle(NextResponse.json(
              { error: 'session_invalid', message: 'BankID session is not complete' },
              { status: 400 }
            ))
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

          if (existing && existing.user_id !== userId) {
            return settle(NextResponse.json(
              { error: 'already_linked', message: 'This BankID is already linked to another account' },
              { status: 409 }
            ))
          }

          if (existing && existing.user_id === userId) {
            return settle(NextResponse.json({ data: { linked: true, alreadyLinked: true } }))
          }

          // Single-use, same reason as /complete: two tabs sharing this
          // browser's flow must not both act on one identification.
          if (!await consumeBankIdSession(supabase, sessionId)) {
            return settle(NextResponse.json(
              { error: 'session_invalid', message: 'BankID session is not complete' },
              { status: 400 }
            ))
          }

          // Link BankID to current user. The caller is authenticated, so the
          // address on the account is already theirs: verified from the start
          // (the column has no default; NULL would make this a pending link
          // that refuses to sign in).
          const { error: insertError } = await supabase
            .from('bankid_identities')
            .insert({
              user_id: userId,
              personal_number_hash: pnrHash,
              personal_number_enc: encryptPersonalNumberForStorage(personalNumber),
              given_name: givenName,
              surname,
              email_verified_at: new Date().toISOString(),
            })

          if (insertError) {
            log.error('link insert failed', { message: insertError.message, code: insertError.code })
            // Session already consumed above, so the flow is spent; clear it.
            return settle(NextResponse.json(
              { error: 'Failed to link BankID' },
              { status: 500 }
            ))
          }

          // Read-merge-write: updateUserById REPLACES app_metadata wholesale
          // (see app/api/account/password/route.ts). Passing just
          // { bankid_linked: true } would wipe has_password for users who
          // already set one, they'd then be incorrectly shown the
          // set-password banner on their next session.
          const { data: priorUser } = await supabase.auth.admin.getUserById(userId)
          const priorMeta = priorUser?.user?.app_metadata ?? {}
          await supabase.auth.admin.updateUserById(userId, {
            app_metadata: { ...priorMeta, bankid_linked: true },
          })

          return settle(NextResponse.json({ data: { linked: true } }))
        } catch (error) {
          if (error instanceof TICAPIError) {
            log.error('link failed: TIC API error', { statusCode: error.statusCode, code: error.code, message: error.message })
            return NextResponse.json(
              { error: 'service_unavailable', message: 'BankID service is temporarily unavailable' },
              { status: 502 }
            )
          }
          log.error('link failed: unexpected error', error)
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
      // Requires a Supabase session but NOT a company: see /bankid/link.
      // A brand-new BankID signup (zero companies) must be able to undo
      // the connection from /settings/account.
      skipCompanyContext: true,
      handler: async (_request: Request) => {
        try {
          const auth = await requireAuth()
          if (auth.error) return auth.error
          const userId = auth.user.id

          const supabase = createServiceClient()

          // Delete bankid_identities row
          const { error: deleteError } = await supabase
            .from('bankid_identities')
            .delete()
            .eq('user_id', userId)

          if (deleteError) {
            log.error('unlink delete failed', { message: deleteError.message, code: deleteError.code })
            return NextResponse.json({ error: 'Failed to unlink BankID' }, { status: 500 })
          }

          // Clear app_metadata.bankid_linked so MFA enforcement resumes.
          // Read-merge-write: updateUserById REPLACES app_metadata wholesale
          // (same rationale as /bankid/link above). Writing only
          // { bankid_linked: false } would wipe has_password: a BankID-only
          // user (has_password: false) would then be inferred as HAVING a
          // password (lib/auth/has-password.ts) and could strand themselves
          // with no working login method.
          const { data: priorUser } = await supabase.auth.admin.getUserById(userId)
          const priorMeta = priorUser?.user?.app_metadata ?? {}
          await supabase.auth.admin.updateUserById(userId, {
            app_metadata: { ...priorMeta, bankid_linked: false },
          })

          return NextResponse.json({ data: { unlinked: true } })
        } catch (error) {
          log.error('unlink failed', error)
          return NextResponse.json({ error: 'Failed to unlink BankID' }, { status: 500 })
        }
      },
    },

    // Re-send / change the unproven address of a pending BankID signup.
    ...bankIdPendingRoutes,
  ],

  eventHandlers: [],
}
