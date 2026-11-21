import {
  searchCompanyByOrgNumber,
  getCompanyDocuments,
  getFiscalYears,
  getPayrolls,
  getRepresentatives,
  getCompanyStatus,
  getBeneficialOwners,
} from './tic-client'
import type { TICCompanyProfile, TICFinancialReportSummary } from './tic-types'
import { pickCompanyName, registrationDateToMs } from './lookup'
import { isLensDocumentCeased } from './lens-status'
import type { TicCallContext } from '@/lib/tic-budget/budget'

/**
 * The company profile behind the extension's `fetchCompanyProfile` service:
 * the Lens search document plus six detail calls (documents, fiscal years,
 * payrolls, representatives, status, beneficial owners), folded into the
 * shape the company snapshot (lib/agent/composer/tic-fetch) reads.
 *
 * Null when TIC has no company under the org number. Throws what the TIC
 * client throws (not configured, quota, timeout, upstream errors); the
 * service caller degrades to its cache.
 */

interface ProfileLog {
  warn(message: string, ...args: unknown[]): void
}

/**
 * Map a v2 `CompanyDocument` (financial-report subset) into the legacy
 * `TICFinancialReportSummary` shape the profile carries. v2 nests
 * the metadata under `financialReportMetadata` and replaces v1's
 * `isAudited` boolean / `auditOpinion` string with auditor identity
 * fields: we derive `isAudited` from the presence of an auditor.
 */
function toFinancialReportSummary(
  doc: import('./tic-types').TICDocument
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

export async function buildCompanyProfile(
  orgNumber: string,
  log: ProfileLog,
  ctx: TicCallContext = {},
): Promise<TICCompanyProfile | null> {
  const cleanedOrgNumber = orgNumber.replace(/[\s-]/g, '')
  // Every call of the fan-out is charged to the caller's purpose ('profile'
  // when it named none).
  const callCtx: TicCallContext = { ...ctx, purpose: ctx.purpose ?? 'profile' }
  const doc = await searchCompanyByOrgNumber(orgNumber, callCtx)

  if (!doc) return null

  const companyName = pickCompanyName(doc.names)
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
    getCompanyDocuments(companyId, callCtx),
    getFiscalYears(companyId, callCtx),
    getPayrolls(companyId, callCtx),
    getRepresentatives(companyId, callCtx),
    getCompanyStatus(companyId, callCtx),
    getBeneficialOwners(companyId, callCtx),
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
  // Whether the list below is complete: a failed or empty-handed documents
  // call leaves it empty, which must not read as "nothing registered".
  const financialReportsComplete =
    documentsResult.status === 'fulfilled' && Array.isArray(documentsResult.value)
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
  const fiscalYearHistory: import('./tic-types').TICProfileFiscalYear[] = []
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
  const statuses: import('./tic-types').TICProfileStatus[] =
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

  // Translate v2's activityStatus enum into the v1 string ('ceased'
  // for a deregistered company) that the profile has always carried.
  const isCeasedProfile = isLensDocumentCeased(doc)
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
    financialReportsComplete,
    fiscalYear,
    fiscalYearHistory,
    signatory,
    board,
    representatives,
    payrolls,
    statuses,
    fetchedAt: new Date().toISOString(),
  }

  return profile
}
