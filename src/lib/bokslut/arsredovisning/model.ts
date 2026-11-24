import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildArsredovisningData,
  buildArsredovisningReport,
  K3_CASH_FLOW_FAILED_WARNING,
  K3_CASH_FLOW_TAX_ALLOCATION_WARNING,
  k3ContentsNotice,
} from './build-data'
import { cashFlowOmissionRule, resolveCashFlowOmission } from './cash-flow-omission'
import { cashFlowStatementRequirement, isEntityType, keepsShareRegister } from '@/lib/company/entity-type'
import { isReliableFrameworkSource } from '@/lib/company/accounting-framework'
import type { K3BuildContext } from './build-data'
import {
  evaluateDisclosures,
  temporaryDifferenceSignals,
  type DisclosureEvaluation,
  type K3FirstYearStatus,
} from './disclosures'
import { k3ArsredovisningReleasedFor } from './k3-release'
import type { NoteEntry } from './types'
import type { PreviousYearFramework } from '@/lib/company/accounting-framework'
import { listSignatureRequests } from './signature-service'
import { getAnnualReportProfile } from './profile-service'
import { evaluateAnnualReportEligibility } from './eligibility'
import {
  validateAnnualReportCompleteness,
  validateStatementIntegrity,
} from './completeness'
import {
  ANNUAL_REPORT_SCHEMA_VERSION,
  type AnnualReportDisclosureState,
  type AnnualReportEligibilityResult,
  type AnnualReportProfile,
  type AnnualReportSizeMetrics,
  type AnnualReportValidationStage,
  type CanonicalAnnualReport,
} from './compliance-types'
import { buildIxbrlInput, type BuildIxbrlOptions } from '@/lib/bokslut/ixbrl/build-input'
import { k3IxbrlEnabled } from '@/lib/bokslut/ixbrl/k3-release'
import { resolveMedelantalAnstallda } from '@/lib/salary/medelantal'
import { getMedelantalOverride } from './narrative-service'

export interface BuildCanonicalAnnualReportOptions extends BuildIxbrlOptions {
  stage?: AnnualReportValidationStage
  generatedAt?: string
  includeIxbrl?: boolean
}

interface EmployeeRow {
  employment_start: string
  employment_end: string | null
  employment_degree: number
}

/**
 * Size metrics for the ÅRL 1:3 § and K2-relief thresholds. The employee
 * figure is the same one the note and the iXBRL fact disclose: a manual
 * override on arsredovisning_narratives for the period wins over the FTE
 * average, so the eligibility verdict and the document cannot disagree
 * about how many people the company employs.
 */
export function reportMetrics(
  report: Awaited<ReturnType<typeof buildArsredovisningData>>,
  employees: EmployeeRow[],
  previousMedelantalOverride: number | null = null,
): AnnualReportSizeMetrics {
  const currentOverview = report.forvaltningsberattelse.flerarsoversikt.find(
    (row) => row.year === report.fiscal_period.name,
  )
  const previousOverview = report.previous_period
    ? report.forvaltningsberattelse.flerarsoversikt.find(
        (row) => row.year === report.previous_period?.name,
      )
    : null
  return {
    current: {
      employees: resolveMedelantalAnstallda(
        report.disclosures.medelantal_anstallda_override,
        employees,
        report.fiscal_period.period_start,
        report.fiscal_period.period_end,
      ),
      balance_sheet_total: report.balansrakning.total_assets,
      net_revenue: currentOverview?.net_revenue ?? null,
    },
    previous: report.previous_period
      ? {
          employees: resolveMedelantalAnstallda(
            previousMedelantalOverride,
            employees,
            report.previous_period.period_start,
            report.previous_period.period_end,
          ),
          balance_sheet_total: report.balansrakning.total_assets_previous,
          net_revenue: previousOverview?.net_revenue ?? null,
        }
      : null,
  }
}

function disclosureState(
  report: Awaited<ReturnType<typeof buildArsredovisningData>>,
): AnnualReportDisclosureState {
  return {
    long_term_debt_over_five_years_confirmed:
      report.disclosures.confirmations.long_term_debt_over_five_years,
    securities_pledged_confirmed: report.disclosures.confirmations.securities_pledged,
    contingent_liabilities_confirmed:
      report.disclosures.confirmations.contingent_liabilities,
    parent_company_confirmed: report.disclosures.confirmations.parent_company,
    agm_disposition_outcome: report.forvaltningsberattelse.agm_disposition_outcome,
    agm_disposition_decision: report.forvaltningsberattelse.agm_disposition_decision,
  }
}

/**
 * K3 kassaflödesanalys omission: decided here, not in buildArsredovisningData,
 * because the law keys it on the ÅRL 1:3 § size classification computed from
 * the finished report (cash-flow-omission.ts). A request the law does not
 * allow leaves the statement in; completeness then says why.
 */
export function applyCashFlowOmission(
  report: Awaited<ReturnType<typeof buildArsredovisningData>>,
  eligibility: AnnualReportEligibilityResult,
  metrics: AnnualReportSizeMetrics,
  profile: AnnualReportProfile,
): void {
  if (report.accounting_framework !== 'k3') return
  const entityType = report.company.entity_type
  const formRequirement = isEntityType(entityType) ? cashFlowStatementRequirement(entityType) : null
  const rule = cashFlowOmissionRule({
    framework: report.accounting_framework,
    sizeClassification: eligibility.size_classification,
    metrics,
    securitiesTradedOnRegulatedMarket: profile.securities_traded_on_regulated_market,
    formRequirement,
  })
  // A mindre företag's K3 document carries no kassaflödesanalys: the
  // statement is voluntary for it (ÅRL 2 kap. 1 §) and the generated one
  // does not yet meet K3 kapitel 7, so it is left out rather than offered.
  // A större företag (blocked as AR-K3-STORRE-UNSUPPORTED) keeps it, and so
  // does a form that must always have one (a bostadsrättsförening, ÅRL 2 kap.
  // 1 §): the rule is then 'forbidden' and the statement is never withheld.
  const withheld = rule !== 'forbidden'
  const omission = withheld
    ? {
        rule,
        requested: report.disclosures.omit_kassaflodesanalys,
        confirmed: report.disclosures.kassaflodesanalys_omission_confirmed,
        omitted: true,
        withheld: true,
      }
    : resolveCashFlowOmission({
        rule,
        requested: report.disclosures.omit_kassaflodesanalys,
        confirmed: report.disclosures.kassaflodesanalys_omission_confirmed,
        requiredByForm: formRequirement === 'always',
      })
  report.kassaflodesanalys_omission = omission
  if (omission.omitted) {
    delete report.kassaflodesanalys
    report.warnings = report.warnings
      .filter((warning) => warning !== K3_CASH_FLOW_FAILED_WARNING && warning !== K3_CASH_FLOW_TAX_ALLOCATION_WARNING)
      .map((warning) => (warning === k3ContentsNotice(true) ? k3ContentsNotice(false) : warning))
  }
}

/**
 * Whether this is the company's first K3 year (K3 35.3). The per-year
 * framework record wins when it can be relied on (an election, or a year
 * that followed its own previous year); otherwise the profile answer
 * decides, and a contradiction (no previous report although Accounted holds
 * a previous year) or no answer is unknown.
 */
export function k3FirstYearStatus(input: {
  previousYear: PreviousYearFramework
  hasPreviousPeriod: boolean
  profileAnswer: AnnualReportProfile['previous_year_framework']
}): K3FirstYearStatus {
  const { previousYear, profileAnswer } = input
  if (previousYear.fiscal_period_id && previousYear.reliable && previousYear.framework) {
    return previousYear.framework === 'k3' ? 'not_first' : 'after_k2'
  }
  if (profileAnswer === 'k3') return 'not_first'
  if (profileAnswer === 'k2') return 'after_k2'
  if (profileAnswer === 'none') {
    return previousYear.fiscal_period_id || input.hasPreviousPeriod ? 'unknown' : 'new_company'
  }
  return 'unknown'
}

/** The order matrix notes take among the notes: right after the principles, or last. */
const NOTES_AFTER_PRINCIPLES = new Set([
  'not.avvikelser',
  'not.principbyte',
  'not.rattelse',
  'not.jamforelsetal',
  'not.forsta_k3_aret',
])

/**
 * The K3 disclosure matrix, applied once the size class is known: the
 * evaluation the completeness check and the editor read, the
 * förvaltningsberättelse sections, the principle paragraphs (appended to
 * note 1, also after a user's own text for the note: the matrix answer is
 * where they are edited) and the notes. Notes are renumbered in document
 * order; nothing references a note by number.
 */
export function applyK3Disclosures(
  report: Awaited<ReturnType<typeof buildArsredovisningData>>,
  k3: K3BuildContext,
  eligibility: AnnualReportEligibilityResult,
  profile: AnnualReportProfile,
  firstYear: K3FirstYearStatus,
): DisclosureEvaluation[] {
  const evaluations = evaluateDisclosures({
    framework: 'k3',
    size: eligibility.size_classification === 'larger' ? 'larger' : 'smaller',
    facts: { ...k3.facts, publicCompany: profile.is_public_limited_company },
    answers: k3.answers,
    firstYear,
  })
  report.k3_disclosures = evaluations
  report.k3_first_year = firstYear
  const printed = (placement: DisclosureEvaluation['placement']) =>
    evaluations.filter((e) => e.placement === placement && e.status === 'met' && e.content)

  report.k3_forvaltningsberattelse = printed('management_report').map((e) => ({
    concept: e.concept,
    heading: e.title,
    text: e.content as string,
  }))

  const principles = printed('principles').map((e) => e.content as string)
  const notes = report.noter.map((note) => ({ ...note }))
  const principlesNote = notes.find((note) => note.key === 'redovisningsprinciper')
  if (principlesNote && principles.length > 0) {
    principlesNote.body = [principlesNote.body, ...principles].join('\n\n')
  }
  const matrixNotes = printed('note').map((e) => ({ id: e.id, note: { number: 0, title: e.title, body: e.content as string } }))
  const early = matrixNotes.filter((n) => NOTES_AFTER_PRINCIPLES.has(n.id)).map((n) => n.note)
  const late = matrixNotes.filter((n) => !NOTES_AFTER_PRINCIPLES.has(n.id)).map((n) => n.note)
  const principlesIndex = principlesNote ? notes.indexOf(principlesNote) + 1 : 0
  const ordered: NoteEntry[] = [...notes.slice(0, principlesIndex), ...early, ...notes.slice(principlesIndex), ...late]
  report.noter = ordered.map((note, index) => ({ ...note, number: index + 1 }))
  return evaluations
}

export async function buildCanonicalAnnualReport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: BuildCanonicalAnnualReportOptions = {},
): Promise<CanonicalAnnualReport> {
  const [built, profile, signatures, employeesResult] = await Promise.all([
    buildArsredovisningReport(supabase, companyId, fiscalPeriodId),
    getAnnualReportProfile(supabase, companyId, fiscalPeriodId),
    listSignatureRequests(supabase, companyId, fiscalPeriodId),
    supabase
      .from('employees')
      .select('employment_start, employment_end, employment_degree')
      .eq('company_id', companyId),
  ])

  const report = built.data
  if (employeesResult.error) {
    throw new Error(`Failed to load annual report employee metrics: ${employeesResult.error.message}`)
  }
  const activeSignatures = signatures.filter((signature) => signature.status !== 'declined')
  report.signatures = activeSignatures.map((signature) => ({
    role: signature.role,
    name: signature.signer_name,
    signed_at: signature.signed_at,
  }))

  // The jämförelseår's manual figure lives on that period's narrative row;
  // without it a SIE-migrated company with no employees rows would count
  // as 0 last year and dodge the two-year ÅRL 1:3 § test.
  // The aktiebok against the share count the aktiekapital note prints, for a
  // form that keeps one (bolaget/reconcile.ts, the share register's check).
  const entityType = report.company.entity_type
  const [previousMedelantalOverride, shareRegister] = await Promise.all([
    report.previous_period ? getMedelantalOverride(supabase, companyId, report.previous_period.id) : null,
    isEntityType(entityType) && keepsShareRegister(entityType)
      ? import('@/lib/bolaget/share-register').then(({ loadShareCapitalReconciliation }) =>
          loadShareCapitalReconciliation(supabase, companyId),
        )
      : null,
  ])
  const metrics = reportMetrics(
    report,
    (employeesResult.data ?? []) as EmployeeRow[],
    previousMedelantalOverride,
  )
  const k3 = report.accounting_framework === 'k3' ? built.k3 ?? null : null
  const firstYear = k3
    ? k3FirstYearStatus({
        previousYear: k3.previousYear,
        hasPreviousPeriod: report.previous_period !== null,
        profileAnswer: profile.previous_year_framework,
      })
    : null
  const signals = k3 ? temporaryDifferenceSignals(k3.facts) : null
  const eligibility = evaluateAnnualReportEligibility({
    entityType: report.company.entity_type,
    framework: report.accounting_framework,
    periodStart: report.fiscal_period.period_start,
    periodEnd: report.fiscal_period.period_end,
    profile,
    metrics,
    ...(k3 && firstYear && signals
      ? { k3: { firstYear, deferredTaxBooked: signals.booked, temporaryDifferenceHints: signals.hints } }
      : {}),
  })
  applyCashFlowOmission(report, eligibility, metrics, profile)
  if (report.accounting_framework === 'k3') {
    // Released only for the form the K3 document is built for (the
    // aktiebolag): any other form's K3 document stays watermarked.
    report.k3_release = k3ArsredovisningReleasedFor(report.company.entity_type) ? 'final' : 'review_draft'
    if (k3 && firstYear) applyK3Disclosures(report, k3, eligibility, profile, firstYear)
  }
  const disclosures = disclosureState(report)
  let validation = validateAnnualReportCompleteness({
    report,
    profile,
    disclosures,
    eligibility,
    stage: options.stage ?? 'draft',
    todayIso: options.todayIso,
    shareRegister,
  })

  let ixbrl = null
  // K3 gets its iXBRL input only while the K3 document is switched on
  // (lib/bokslut/ixbrl/k3-release.ts); off, a K3 version freezes no iXBRL.
  const ixbrlFramework = report.accounting_framework === 'k2' || k3IxbrlEnabled()
  if (ixbrlFramework && options.includeIxbrl !== false) {
    ixbrl = await buildIxbrlInput(supabase, companyId, fiscalPeriodId, {
      undertecknare: options.undertecknare,
      proposedDividend: options.proposedDividend,
      todayIso: options.todayIso,
      // The report as amended above, with the statements it was built from:
      // the iXBRL input builds no trial balance of its own.
      report: built,
      signatureRequests: activeSignatures,
      profile,
    })
  }

  const crossDocumentIssues = validateStatementIntegrity(report, ixbrl).filter(
    (issue) => issue.code === 'AR-IXBRL-STATEMENT-MISMATCH',
  )
  if (crossDocumentIssues.length > 0) {
    validation = {
      ...validation,
      ok: false,
      error_count: validation.error_count + crossDocumentIssues.length,
      issues: [...validation.issues, ...crossDocumentIssues],
    }
  }

  return {
    schema_version: ANNUAL_REPORT_SCHEMA_VERSION,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    company_id: companyId,
    fiscal_period_id: fiscalPeriodId,
    entity_type: report.company.entity_type,
    report,
    framework_source: built.frameworkSource ?? null,
    framework_confirmed: isReliableFrameworkSource(built.frameworkSource),
    profile,
    disclosures,
    eligibility,
    validation,
    ixbrl,
  }
}
