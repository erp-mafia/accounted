import type { ArsredovisningData } from './types'
import type { IxbrlArsredovisningInput } from '@/lib/bokslut/ixbrl/types'
import type { AccountingFramework } from '@/types'

export const ANNUAL_REPORT_SCHEMA_VERSION = '1.0' as const

export type AnnualReportFramework = AccountingFramework
export type AnnualReportValidationStage = 'draft' | 'signing' | 'filing'

export type ParentGroupSize = 'none' | 'small' | 'large'

/**
 * Facts that determine whether the selected framework may be used. Nullable
 * booleans are intentional: an unanswered eligibility question must never be
 * interpreted as a legal assertion that the condition does not apply.
 */
export interface AnnualReportProfile {
  id: string | null
  company_id: string
  fiscal_period_id: string
  is_public_limited_company: boolean | null
  is_in_liquidation: boolean | null
  securities_traded_on_regulated_market: boolean | null
  is_parent_company: boolean | null
  parent_group_size: ParentGroupSize | null
  prepares_consolidated_accounts: boolean | null
  has_foreign_branch: boolean | null
  has_crypto_assets: boolean | null
  has_share_based_payments: boolean | null
  has_convertible_debt: boolean | null
  building_revenue_share_pct: number | null
  has_material_deferred_tax: boolean | null
  reporting_currency: 'SEK' | 'EUR'
  auditor_report_required: boolean | null
  auditor_report_included: boolean
  dividend_prudence_confirmed: boolean | null
  narrative_confirmed_at: string | null
  k2_assessment_confirmed_at: string | null
  signer_roster_confirmed_at: string | null
  updated_at: string | null
}

export interface AnnualReportDisclosureState {
  long_term_debt_over_five_years_confirmed: boolean
  securities_pledged_confirmed: boolean
  contingent_liabilities_confirmed: boolean
  parent_company_confirmed: boolean
  agm_disposition_outcome: 'proposal_approved' | 'alternative_decision' | null
  agm_disposition_decision: string | null
}

export interface AnnualReportMetricsYear {
  employees: number | null
  balance_sheet_total: number | null
  net_revenue: number | null
}

export interface AnnualReportSizeMetrics {
  current: AnnualReportMetricsYear
  previous: AnnualReportMetricsYear | null
}

export type AnnualReportIssueSeverity = 'error' | 'warning' | 'info'

export interface AnnualReportComplianceIssue {
  code: string
  severity: AnnualReportIssueSeverity
  section:
    | 'scope'
    | 'company'
    | 'management_report'
    | 'statements'
    | 'notes'
    | 'signatures'
    | 'agm'
    | 'filing'
  message: string
  remediation?: string
}

export interface AnnualReportEligibilityResult {
  k2_eligible: boolean
  digital_filing_eligible: boolean
  size_classification: 'smaller' | 'larger' | 'unknown'
  k2_relief_rule: 'eligible' | 'not_eligible' | 'unknown'
  issues: AnnualReportComplianceIssue[]
  digital_issues: AnnualReportComplianceIssue[]
}

export interface AnnualReportValidationResult {
  stage: AnnualReportValidationStage
  ok: boolean
  error_count: number
  warning_count: number
  issues: AnnualReportComplianceIssue[]
}

export interface AnnualReportVersionValidationSnapshot extends AnnualReportValidationResult {
  digital_filing_eligible: boolean
  digital_issues: AnnualReportComplianceIssue[]
  profile: AnnualReportProfile
  disclosures: AnnualReportDisclosureState
  eligibility: AnnualReportEligibilityResult
}

export interface CanonicalAnnualReport {
  schema_version: typeof ANNUAL_REPORT_SCHEMA_VERSION
  generated_at: string
  company_id: string
  fiscal_period_id: string
  entity_type: string
  report: ArsredovisningData
  profile: AnnualReportProfile
  disclosures: AnnualReportDisclosureState
  eligibility: AnnualReportEligibilityResult
  validation: AnnualReportValidationResult
  ixbrl: IxbrlArsredovisningInput | null
}

export interface AnnualReportVersionSummary {
  id: string
  version_number: number
  status: 'draft' | 'ready_for_signature' | 'signed' | 'filed' | 'registered' | 'superseded'
  framework: AnnualReportFramework
  content_hash: string
  taxonomy_version: string | null
  entry_point: string | null
  finalized_at: string | null
  created_at: string
  digital_filing_eligible?: boolean
  certificate_signer?: {
    first_name: string
    last_name: string
    role: string
  } | null
}

export function emptyAnnualReportProfile(
  companyId: string,
  fiscalPeriodId: string,
): AnnualReportProfile {
  return {
    id: null,
    company_id: companyId,
    fiscal_period_id: fiscalPeriodId,
    is_public_limited_company: null,
    is_in_liquidation: null,
    securities_traded_on_regulated_market: null,
    is_parent_company: null,
    parent_group_size: null,
    prepares_consolidated_accounts: null,
    has_foreign_branch: null,
    has_crypto_assets: null,
    has_share_based_payments: null,
    has_convertible_debt: null,
    building_revenue_share_pct: null,
    has_material_deferred_tax: null,
    reporting_currency: 'SEK',
    auditor_report_required: null,
    auditor_report_included: false,
    dividend_prudence_confirmed: null,
    narrative_confirmed_at: null,
    k2_assessment_confirmed_at: null,
    signer_roster_confirmed_at: null,
    updated_at: null,
  }
}
