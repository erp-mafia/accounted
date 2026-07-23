import type { SupabaseClient } from '@supabase/supabase-js'
import { buildArsredovisningData } from './build-data'
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
  type AnnualReportSizeMetrics,
  type AnnualReportValidationStage,
  type CanonicalAnnualReport,
} from './compliance-types'
import { buildIxbrlInput, type BuildIxbrlOptions } from '@/lib/bokslut/ixbrl/build-input'
import { computeMedelantalAnstallda } from '@/lib/salary/medelantal'

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

function reportMetrics(
  report: Awaited<ReturnType<typeof buildArsredovisningData>>,
  employees: EmployeeRow[],
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
      employees: computeMedelantalAnstallda(
        employees,
        report.fiscal_period.period_start,
        report.fiscal_period.period_end,
      ),
      balance_sheet_total: report.balansrakning.total_assets,
      net_revenue: currentOverview?.net_revenue ?? null,
    },
    previous: report.previous_period
      ? {
          employees: computeMedelantalAnstallda(
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

export async function buildCanonicalAnnualReport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: BuildCanonicalAnnualReportOptions = {},
): Promise<CanonicalAnnualReport> {
  const [report, profile, signatures, employeesResult] = await Promise.all([
    buildArsredovisningData(supabase, companyId, fiscalPeriodId),
    getAnnualReportProfile(supabase, companyId, fiscalPeriodId),
    listSignatureRequests(supabase, companyId, fiscalPeriodId),
    supabase
      .from('employees')
      .select('employment_start, employment_end, employment_degree')
      .eq('company_id', companyId),
  ])

  if (employeesResult.error) {
    throw new Error(`Failed to load annual report employee metrics: ${employeesResult.error.message}`)
  }
  const activeSignatures = signatures.filter((signature) => signature.status !== 'declined')
  report.signatures = activeSignatures.map((signature) => ({
    role: signature.role,
    name: signature.signer_name,
    signed_at: signature.signed_at,
  }))

  const metrics = reportMetrics(report, (employeesResult.data ?? []) as EmployeeRow[])
  const eligibility = evaluateAnnualReportEligibility({
    entityType: report.company.entity_type,
    framework: report.accounting_framework,
    periodStart: report.fiscal_period.period_start,
    periodEnd: report.fiscal_period.period_end,
    profile,
    metrics,
  })
  const disclosures = disclosureState(report)
  let validation = validateAnnualReportCompleteness({
    report,
    profile,
    disclosures,
    eligibility,
    stage: options.stage ?? 'draft',
    todayIso: options.todayIso,
  })

  let ixbrl = null
  if (report.accounting_framework === 'k2' && options.includeIxbrl !== false) {
    ixbrl = await buildIxbrlInput(supabase, companyId, fiscalPeriodId, {
      undertecknare: options.undertecknare,
      proposedDividend: options.proposedDividend,
      todayIso: options.todayIso,
      reportData: report,
      signatureRequests: activeSignatures,
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
    profile,
    disclosures,
    eligibility,
    validation,
    ixbrl,
  }
}
