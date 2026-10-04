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
import { K3_CASH_FLOW_TAX_ALLOCATION_WARNING } from '../build-data'

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
    company: { name: 'Test AB', org_number: '556012-5790', registered_office: 'Stockholm' },
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

  it('blocks the report when the säte is unknown', () => {
    const value = input('draft')
    value.report.company.registered_office = null
    const result = validateAnnualReportCompleteness(value)
    const issue = result.issues.find((item) => item.code === 'AR-COMPANY-REGISTERED-OFFICE')
    expect(issue?.severity).toBe('error')
    expect(result.ok).toBe(false)
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

  it.each(['signing', 'filing'] as const)('blocks %s after a tax-allocation failure for a larger K3 company', (stage) => {
    const value = input(stage)
    value.report.accounting_framework = 'k3'
    value.eligibility = { ...eligibility, size_classification: 'larger' }
    value.report.kassaflodesanalys = undefined
    value.report.warnings = [K3_CASH_FLOW_TAX_ALLOCATION_WARNING]
    value.report.kassaflodesanalys_omission = {
      rule: 'forbidden', requested: false, confirmed: false, omitted: false,
    }
    const result = validateAnnualReportCompleteness(value)
    expect(result.ok).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'AR-K3-DRAFT-ONLY', severity: 'error',
    }))
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'AR-SOURCE-WARNING', message: K3_CASH_FLOW_TAX_ALLOCATION_WARNING,
    }))
  })

  it('reports a cash-flow omission the law does not allow, and nothing when honoured', () => {
    const value = input('draft')
    value.report.accounting_framework = 'k3'
    value.report.kassaflodesanalys_omission = {
      rule: 'forbidden',
      requested: true,
      confirmed: false,
      omitted: false,
    }
    expect(
      validateAnnualReportCompleteness(value).issues.map((issue) => issue.code),
    ).toContain('AR-K3-CASHFLOW-REQUIRED')

    value.report.kassaflodesanalys_omission = {
      rule: 'allowed',
      requested: true,
      confirmed: false,
      omitted: true,
    }
    expect(
      validateAnnualReportCompleteness(value).issues.map((issue) => issue.code),
    ).not.toContain('AR-K3-CASHFLOW-REQUIRED')
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

describe('validateAnnualReportCompleteness: ekonomisk förening', () => {
  function foreningReport(memberCountChange: string | null): ArsredovisningData {
    const base = report()
    return {
      ...base,
      company: { ...base.company, name: 'Testkooperativet ek. för.', entity_type: 'ekonomisk_forening' },
      forvaltningsberattelse: {
        ...base.forvaltningsberattelse,
        member_disclosures: {
          member_count_change: memberCountChange,
          insatser_repayable_next_year: null,
          forlagsinsatser_dividend_right: null,
          forlagsinsatser_redeemable_two_years: null,
        },
      },
    } as unknown as ArsredovisningData
  }

  it('requires the ÅRL 6 kap. 3 § member statement before filing', () => {
    const base = input('filing')
    const missing = validateAnnualReportCompleteness({ ...base, report: foreningReport(null) })
    expect(missing.issues.map((issue) => issue.code)).toContain('AR-EF-MEMBER-INFO')
    const present = validateAnnualReportCompleteness({
      ...base,
      report: foreningReport('Medlemsantalet ökade från 40 till 52.'),
    })
    expect(present.issues.map((issue) => issue.code)).not.toContain('AR-EF-MEMBER-INFO')
  })

  it('requires the dividend-right statement when förlagsinsatser are on the balance sheet (ÅRL 6 kap. 3 §)', () => {
    const base = input('filing')
    const withForlag = (dividendRight: string | null): ArsredovisningData => {
      const r = foreningReport('Medlemsantalet ökade från 40 till 52.')
      return {
        ...r,
        balansrakning: {
          ...r.balansrakning,
          equity_liabilities: [
            ...r.balansrakning.equity_liabilities,
            { label: 'Förlagsinsatser', semantic_key: 'balance_sheet_forlagsinsatser', current: 50_000, previous: null },
          ],
        },
        forvaltningsberattelse: {
          ...r.forvaltningsberattelse,
          member_disclosures: {
            ...r.forvaltningsberattelse.member_disclosures,
            forlagsinsatser_dividend_right: dividendRight,
          },
        },
      } as unknown as ArsredovisningData
    }
    const missing = validateAnnualReportCompleteness({ ...base, report: withForlag(null) })
    expect(missing.issues.map((issue) => issue.code)).toContain('AR-EF-FORLAGSINSATSER-DIVIDEND')
    const present = validateAnnualReportCompleteness({
      ...base,
      report: withForlag('Förlagsinsatserna ger rätt till 4 % årlig utdelning enligt stadgarna.'),
    })
    expect(present.issues.map((issue) => issue.code)).not.toContain('AR-EF-FORLAGSINSATSER-DIVIDEND')
    // No förlagsinsatser: the text is optional and the PDF prints "inga".
    const none = validateAnnualReportCompleteness({ ...base, report: foreningReport('Oförändrat medlemsantal.') })
    expect(none.issues.map((issue) => issue.code)).not.toContain('AR-EF-FORLAGSINSATSER-DIVIDEND')
  })

  it('demands the revisionsberättelse even when the profile says none is required (EFL 8 kap. 1 §)', () => {
    const base = input('filing')
    const profile: AnnualReportProfile = {
      ...base.profile,
      auditor_report_required: false,
      auditor_report_included: false,
    }
    const result = validateAnnualReportCompleteness({
      ...base,
      profile,
      report: foreningReport('Oförändrat medlemsantal.'),
    })
    expect(result.issues.map((issue) => issue.code)).toContain('AR-AUDITOR-REPORT-MISSING')
  })

  it('never files an unanswered ÅRL 6 kap. 3 § amount as "inga"; an entered 0 is an answer', () => {
    const base = input('filing')
    const withAmounts = (
      repayable: number | null,
      redeemable: number | null,
      forlagsinsatser: number,
    ): ArsredovisningData => {
      const r = foreningReport('Oförändrat medlemsantal.')
      return {
        ...r,
        balansrakning: {
          ...r.balansrakning,
          equity_liabilities: [
            ...r.balansrakning.equity_liabilities,
            { label: 'Förlagsinsatser', semantic_key: 'balance_sheet_forlagsinsatser', current: forlagsinsatser, previous: null },
          ],
        },
        forvaltningsberattelse: {
          ...r.forvaltningsberattelse,
          member_disclosures: {
            ...r.forvaltningsberattelse.member_disclosures,
            forlagsinsatser_dividend_right: forlagsinsatser ? 'Rätt till 4 % utdelning enligt stadgarna.' : null,
            insatser_repayable_next_year: repayable,
            forlagsinsatser_redeemable_two_years: redeemable,
          },
        },
      } as unknown as ArsredovisningData
    }
    const codes = (r: ArsredovisningData) =>
      validateAnnualReportCompleteness({ ...base, report: r }).issues.map((issue) => issue.code)

    expect(codes(withAmounts(null, null, 0))).toContain('AR-EF-MEMBER-AMOUNTS')
    // Without förlagsinsatser only the repayable insatser are asked.
    expect(codes(withAmounts(0, null, 0))).not.toContain('AR-EF-MEMBER-AMOUNTS')
    expect(codes(withAmounts(12_500, null, 50_000))).toContain('AR-EF-MEMBER-AMOUNTS')
    expect(codes(withAmounts(12_500, 0, 50_000))).not.toContain('AR-EF-MEMBER-AMOUNTS')
  })

  it('cites the förening\'s own prudence rule (EFL 12 kap. 4 §), not the aktiebolag\'s', () => {
    const value = input('draft')
    const r = foreningReport('Oförändrat medlemsantal.')
    r.forvaltningsberattelse.resultatdisposition_amounts.proposed_dividend = 50
    const issue = validateAnnualReportCompleteness({ ...value, report: r }).issues.find(
      (i) => i.code === 'AR-DIVIDEND-PRUDENCE-UNCONFIRMED',
    )
    expect(issue?.remediation).toContain('12 kap. 4 § lagen om ekonomiska föreningar')
    expect(issue?.remediation).not.toContain('ABL')
  })
})

// Feedback seq 740922: a K2 aktiebolag closed its year with eget kapital
// 68 021,75 against a registered aktiekapital of 150 000, and its board drew
// up the kontrollbalansräkning after balansdagen. The validation warns (ABL 25
// kap. 13 §) and leaves kontrollbalans_required alone: that flag prints
// "upprättats under räkenskapsåret", which would be false here.
describe('kontrollbalansräkning warning (ABL 25 kap. 13 §)', () => {
  const CODE = 'AR-EQUITY-BELOW-HALF-SHARE-CAPITAL'

  function withEquity(equity: number, shareCapital: number | null, framework: 'k2' | 'k3' = 'k2') {
    const value = input('draft')
    value.report.accounting_framework = framework
    value.report.forvaltningsberattelse.kontrollbalans_required = false
    value.report.balansrakning.equity_liabilities = [
      ...(shareCapital === null
        ? []
        : [{
            label: 'Aktiekapital',
            current: shareCapital,
            previous: null,
            indent: 2,
            semantic_key: 'balance_sheet_share_capital' as const,
          }]),
      { label: 'Årets resultat', current: 20, previous: null },
      {
        label: 'Summa eget kapital',
        current: equity,
        previous: null,
        is_total: true,
        semantic_key: 'balance_sheet_equity_total' as const,
      },
    ]
    return value
  }

  it('warns below half the registered aktiekapital, naming the rule and where to disclose', () => {
    const value = withEquity(68022, 150000)
    const result = validateAnnualReportCompleteness(value)
    const warning = result.issues.find((issue) => issue.code === CODE)

    expect(warning?.severity).toBe('warning')
    expect(warning?.section).toBe('management_report')
    expect(warning?.message).toMatch(/\(68\s022 kr\)/)
    expect(warning?.message).toMatch(/\(150\s000 kr\)/)
    expect(warning?.message).toContain('kontrollbalansräkning (ABL 25 kap. 13 §)')
    expect(warning?.remediation).toContain('förvaltningsberättelsen')
    expect(warning?.remediation).toContain('efter balansdagen')
    expect(warning?.remediation).toContain('K2 punkt 18.22')
    // A warning: the draft still validates, and the flag is not touched.
    expect(result.ok).toBe(true)
    expect(result.warning_count).toBeGreaterThanOrEqual(1)
    expect(value.report.forvaltningsberattelse.kontrollbalans_required).toBe(false)
  })

  it('warns on negative equity too', () => {
    const result = validateAnnualReportCompleteness(withEquity(-12000, 25000))
    expect(result.issues.some((issue) => issue.code === CODE)).toBe(true)
  })

  it('does not warn at exactly half or above', () => {
    for (const equity of [75000, 75000.004, 150000, 1_000_000]) {
      const result = validateAnnualReportCompleteness(withEquity(equity, 150000))
      expect(result.issues.some((issue) => issue.code === CODE), `equity ${equity}`).toBe(false)
    }
    const justBelow = validateAnnualReportCompleteness(withEquity(74999.99, 150000))
    expect(justBelow.issues.some((issue) => issue.code === CODE)).toBe(true)
  })

  it('does not warn without an aktiekapital to test against', () => {
    for (const shareCapital of [null, 0]) {
      const result = validateAnnualReportCompleteness(withEquity(-5000, shareCapital))
      expect(result.issues.some((issue) => issue.code === CODE)).toBe(false)
    }
  })

  it('points a K3 report to punkt 3.11', () => {
    const result = validateAnnualReportCompleteness(withEquity(68022, 150000, 'k3'))
    const warning = result.issues.find((issue) => issue.code === CODE)
    expect(warning?.remediation).toContain('K3 punkt 3.11')
    expect(warning?.remediation).not.toContain('18.22')
  })

  it('reads the rows the statement builder produces (the reported company\'s balance sheet)', () => {
    const value = input('draft')
    const full = [
      { account_number: '1930', account_name: 'Bank', closing_debit: 68021.75, closing_credit: 0 },
      { account_number: '2081', account_name: 'Aktiekapital', closing_debit: 0, closing_credit: 150000 },
      { account_number: '2091', account_name: 'Balanserat resultat', closing_debit: 36787.5, closing_credit: 0 },
      { account_number: '2093', account_name: 'Erhållna aktieägartillskott', closing_debit: 0, closing_credit: 1460000 },
      { account_number: '2099', account_name: 'Årets resultat', closing_debit: 1505190.75, closing_credit: 0 },
    ]
    const mapping = mapTrialBalancesToK2({ full, preClosing: full }, null)
    value.report.balansrakning.equity_liabilities = buildBrRows(mapping).equityLiabilities

    const warning = validateAnnualReportCompleteness(value).issues.find((issue) => issue.code === CODE)

    expect(warning?.message).toMatch(/\(68\s022 kr\)/)
    expect(warning?.message).toMatch(/\(150\s000 kr\)/)
  })
})
