import { describe, expect, it } from 'vitest'
import type { ArsredovisningData } from '../types'
import {
  emptyAnnualReportProfile,
  type AnnualReportEligibilityResult,
  type AnnualReportProfile,
} from '../compliance-types'
import {
  validateAnnualReportCompleteness,
  validateStatementIntegrity,
} from '../completeness'
import { mapTrialBalancesToK2 } from '../../ixbrl/k2-mapper'
import { buildBrRows, buildRrRows } from '../statement-rows'

const eligibility: AnnualReportEligibilityResult = {
  k2_eligible: true,
  digital_filing_eligible: true,
  size_classification: 'smaller',
  k2_relief_rule: 'eligible',
  issues: [],
  digital_issues: [],
}

function report(): ArsredovisningData {
  return {
    accounting_framework: 'k2',
    company: { name: 'Test AB', org_number: '556012-5790', city: 'Stockholm' },
    fiscal_period: {
      id: 'period-1',
      name: '2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    },
    previous_period: null,
    forvaltningsberattelse: {
      description: 'Bolaget bedriver konsultverksamhet.',
      important_events: 'Inga väsentliga händelser.',
      resultatdisposition: 'Resultatet balanseras i ny räkning.',
      proposed_dividend: 0,
      resultatdisposition_amounts: {
        retained_earnings: 80,
        share_premium_reserve: 0,
        current_year_result: 20,
        total: 100,
        proposed_dividend: 0,
        carried_forward: 100,
      },
      agm_date: '2026-03-15',
    },
    balansrakning: {
      total_assets: 100,
      total_equity_liabilities: 100,
      total_assets_previous: null,
      total_equity_liabilities_previous: null,
      assets: [{ label: 'Bank', current: 100, previous: null }],
      equity_liabilities: [
        { label: 'Eget kapital', current: 100, previous: null },
        { label: 'Årets resultat', current: 20, previous: null },
      ],
    },
    resultatrakning: [
      { label: 'Nettoomsättning', current: 20, previous: null },
      { label: 'Årets resultat', current: 20, previous: null, is_total: true },
    ],
    noter: [{ number: 1, title: 'Principer', body: 'K2' }],
    signatures: [{ role: 'Styrelseledamot', name: 'Anna Andersson', signed_at: '2026-03-01' }],
    warnings: [],
  } as unknown as ArsredovisningData
}

function input(stage: 'draft' | 'signing' | 'filing') {
  const profile: AnnualReportProfile = {
    ...emptyAnnualReportProfile('company-1', 'period-1'),
    k2_assessment_confirmed_at: '2026-02-01T10:00:00Z',
    narrative_confirmed_at: '2026-02-01T10:00:00Z',
    signer_roster_confirmed_at: '2026-02-01T10:00:00Z',
    is_in_liquidation: false,
    auditor_report_required: false,
  }
  return {
    report: report(),
    profile,
    eligibility,
    stage,
    todayIso: '2026-03-20',
    disclosures: {
      long_term_debt_over_five_years_confirmed: true,
      securities_pledged_confirmed: true,
      contingent_liabilities_confirmed: true,
      parent_company_confirmed: true,
      agm_disposition_outcome: 'proposal_approved' as
        | 'proposal_approved'
        | 'alternative_decision'
        | null,
      agm_disposition_decision: null,
    },
  }
}

describe('validateAnnualReportCompleteness', () => {
  it('accepts a complete filing model', () => {
    const result = validateAnnualReportCompleteness(input('filing'))
    expect(result.ok).toBe(true)
    expect(result.error_count).toBe(0)
  })

  it('keeps an unsupported reporting currency blocking at signing stage', () => {
    const value = input('signing')
    const currencyIssue = {
      code: 'AR-SCOPE-CURRENCY',
      severity: 'error' as const,
      section: 'scope' as const,
      message: 'Accounteds årsredovisningsflöde stöder ännu endast SEK som redovisningsvaluta.',
    }
    value.eligibility = {
      ...eligibility,
      k2_eligible: false,
      digital_filing_eligible: false,
      issues: [currencyIssue],
      digital_issues: [currencyIssue],
    }

    const result = validateAnnualReportCompleteness(value)

    expect(result.ok).toBe(false)
    expect(result.issues).toEqual(expect.arrayContaining([currencyIssue]))
  })

  it('does not infer an unanswered disclosure confirmation', () => {
    const value = input('draft')
    value.disclosures.securities_pledged_confirmed = false
    const result = validateAnnualReportCompleteness(value)
    expect(result.ok).toBe(false)
    expect(result.issues.some((issue) => issue.code === 'AR-NOTE-SECURITIES-UNCONFIRMED')).toBe(
      true,
    )
  })

  it('requires signers before a version can be locked', () => {
    const value = input('signing')
    value.report.signatures = []
    const result = validateAnnualReportCompleteness(value)
    expect(result.issues.some((issue) => issue.code === 'AR-SIGNERS-MISSING')).toBe(true)
  })

  it('validates the organisation number check digit', () => {
    const value = input('draft')
    value.report.company.org_number = '556012-5791'
    const result = validateAnnualReportCompleteness(value)
    expect(result.issues.some((issue) => issue.code === 'AR-COMPANY-ORGNR')).toBe(true)
  })

  it('requires confirmation that the signer roster matches Bolagsverket', () => {
    const value = input('signing')
    value.profile.signer_roster_confirmed_at = null
    const result = validateAnnualReportCompleteness(value)
    expect(result.issues.some((issue) => issue.code === 'AR-SIGNER-ROSTER-UNCONFIRMED')).toBe(true)
  })

  it('blocks impossible signature and AGM chronology', () => {
    const value = input('filing')
    value.report.signatures[0].signed_at = '2025-12-30'
    value.report.forvaltningsberattelse.agm_date = '2025-12-29'
    const result = validateAnnualReportCompleteness(value)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['AR-SIGNATURE-BEFORE-PERIOD-END', 'AR-AGM-BEFORE-PERIOD-END']),
    )
  })

  it('keeps K3 output draft-only until the complete K3 disclosure matrix exists', () => {
    const value = input('signing')
    value.report.accounting_framework = 'k3'
    const result = validateAnnualReportCompleteness(value)
    expect(result.issues.some((issue) => issue.code === 'AR-K3-DRAFT-ONLY')).toBe(true)
  })

  it('requires the AGM decision and evidence dates at filing stage', () => {
    const value = input('filing')
    value.report.signatures[0].signed_at = null
    value.disclosures.agm_disposition_outcome = null
    const result = validateAnnualReportCompleteness(value)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['AR-SIGNATURES-INCOMPLETE', 'AR-AGM-DISPOSITION-OUTCOME']),
    )
  })

  it('blocks a proposed dividend above distributable equity', () => {
    const value = input('draft')
    value.report.forvaltningsberattelse.resultatdisposition_amounts.proposed_dividend = 101
    const result = validateAnnualReportCompleteness(value)
    expect(result.issues.some((issue) => issue.code === 'AR-DIVIDEND-EXCEEDS-EQUITY')).toBe(true)
  })

  it('blocks a version whose income-statement result differs from equity', () => {
    const value = input('draft')
    value.report.resultatrakning = [
      { label: 'Årets resultat', current: 790_296, previous: null, is_total: true },
    ]
    value.report.forvaltningsberattelse.resultatdisposition_amounts.current_year_result = 469_542

    const result = validateAnnualReportCompleteness(value)

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AR-RESULT-MISMATCH', severity: 'error' }),
      ]),
    )
  })

  it('compares annual-report results at whole-ore precision', () => {
    const value = report()
    value.resultatrakning = [
      { label: 'Årets resultat', current: 0.1 + 0.2, previous: null, is_total: true },
    ]
    value.balansrakning.equity_liabilities = [
      { label: 'Årets resultat', current: 0.3, previous: null },
    ]
    value.forvaltningsberattelse.resultatdisposition_amounts.current_year_result = 0.3

    expect(validateStatementIntegrity(value)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AR-RESULT-MISMATCH' }),
      ]),
    )
  })

  it('blocks a version when the income statement has no final result row', () => {
    const value = input('draft')
    value.report.resultatrakning = [
      { label: 'Nettoomsättning', current: 100, previous: null },
    ]

    const result = validateAnnualReportCompleteness(value)

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AR-RESULT-MISSING', severity: 'error' }),
      ]),
    )
  })

  it('identifies the statutory result by semantic key instead of its K2 label', () => {
    const value = report()
    value.resultatrakning = [{
      label: 'Årets resultat/förlust',
      semantic_key: 'income_statement_result',
      current: 20,
      previous: null,
      is_total: true,
    }]
    value.balansrakning.equity_liabilities = [{
      label: 'Periodens resultat',
      semantic_key: 'balance_sheet_current_year_result',
      current: 20,
      previous: null,
    }]

    expect(validateStatementIntegrity(value)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AR-RESULT-MISSING' }),
      ]),
    )
  })

  it('detects a line reclassification between PDF and iXBRL with unchanged totals', () => {
    const value = input('draft')
    const full = [
      { account_number: '1930', account_name: 'Bank', closing_debit: 100, closing_credit: 0 },
      { account_number: '2081', account_name: 'Share capital', closing_debit: 0, closing_credit: 80 },
      { account_number: '2099', account_name: 'Current result', closing_debit: 0, closing_credit: 20 },
      { account_number: '3010', account_name: 'Revenue', closing_debit: 20, closing_credit: 20 },
    ]
    const preClosing = [
      { account_number: '1930', account_name: 'Bank', closing_debit: 100, closing_credit: 0 },
      { account_number: '2081', account_name: 'Share capital', closing_debit: 0, closing_credit: 80 },
      { account_number: '3010', account_name: 'Revenue', closing_debit: 0, closing_credit: 20 },
    ]
    const mapping = mapTrialBalancesToK2({ full, preClosing }, null)
    const balanceRows = buildBrRows(mapping)
    value.report.resultatrakning = buildRrRows(mapping)
    value.report.balansrakning.assets = balanceRows.assets
    value.report.balansrakning.equity_liabilities = balanceRows.equityLiabilities
    value.report.balansrakning.total_assets = mapping.totals.tillgangar.current
    value.report.balansrakning.total_equity_liabilities =
      mapping.totals.egetKapitalSkulder.current
    const ixbrl = {
      rr: {
        ...mapping.rr,
        Nettoomsattning: { current: 0, previous: null },
        OvrigaRorelseintakter: { current: 20, previous: null },
      },
      br: mapping.br,
      totals: mapping.totals,
    }

    expect(validateStatementIntegrity(value.report, ixbrl as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AR-IXBRL-STATEMENT-MISMATCH' }),
      ]),
    )
  })

  it('requires a documented prudence assessment for a positive dividend', () => {
    const value = input('draft')
    value.report.forvaltningsberattelse.resultatdisposition_amounts.proposed_dividend = 50
    const result = validateAnnualReportCompleteness(value)
    expect(
      result.issues.some((issue) => issue.code === 'AR-DIVIDEND-PRUDENCE-UNCONFIRMED'),
    ).toBe(true)

    value.profile.dividend_prudence_confirmed = true
    const confirmed = validateAnnualReportCompleteness(value)
    expect(
      confirmed.issues.some((issue) => issue.code === 'AR-DIVIDEND-PRUDENCE-UNCONFIRMED'),
    ).toBe(false)
  })

  it('does not report a dividend error for zero dividend and negative equity', () => {
    const value = input('draft')
    value.report.forvaltningsberattelse.resultatdisposition_amounts.total = -100
    value.report.forvaltningsberattelse.resultatdisposition_amounts.carried_forward = -100
    const result = validateAnnualReportCompleteness(value)
    expect(result.issues.some((issue) => issue.code.startsWith('AR-DIVIDEND-'))).toBe(false)
  })
})
