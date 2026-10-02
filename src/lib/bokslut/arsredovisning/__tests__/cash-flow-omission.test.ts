/**
 * K3 kassaflödesanalys omission (ÅRL 2 kap. 1 § andra stycket: a större
 * företag always includes one; BFNAR 2012:1 kap. 7: voluntary for mindre
 * företag; större företag defined in ÅRL 1 kap. 3 §).
 */
import { describe, it, expect } from 'vitest'
import {
  cashFlowOmissionIssues,
  cashFlowOmissionRule,
  resolveCashFlowOmission,
} from '../cash-flow-omission'
import { applyCashFlowOmission } from '../model'
import { K3_CASH_FLOW_FAILED_WARNING, K3_CASH_FLOW_TAX_ALLOCATION_WARNING, k3ContentsNotice } from '../build-data'
import {
  emptyAnnualReportProfile,
  type AnnualReportEligibilityResult,
  type AnnualReportSizeMetrics,
} from '../compliance-types'
import type { ArsredovisningData } from '../types'

const year = { employees: 2, balance_sheet_total: 1_000_000, net_revenue: 2_000_000 }
const twoYears: AnnualReportSizeMetrics = { current: year, previous: year }
const oneYear: AnnualReportSizeMetrics = { current: year, previous: null }

describe('cashFlowOmissionRule', () => {
  it('allows omission for a determined smaller, unlisted company', () => {
    expect(
      cashFlowOmissionRule({
        framework: 'k3',
        sizeClassification: 'smaller',
        metrics: twoYears,
        securitiesTradedOnRegulatedMarket: false,
      }),
    ).toBe('allowed')
  })

  it('forbids omission for a larger company', () => {
    expect(
      cashFlowOmissionRule({
        framework: 'k3',
        sizeClassification: 'larger',
        metrics: twoYears,
        securitiesTradedOnRegulatedMarket: false,
      }),
    ).toBe('forbidden')
  })

  it('forbids omission when securities are traded on a regulated market, whatever the size', () => {
    expect(
      cashFlowOmissionRule({
        framework: 'k3',
        sizeClassification: 'smaller',
        metrics: twoYears,
        securitiesTradedOnRegulatedMarket: true,
      }),
    ).toBe('forbidden')
  })

  it.each([
    ['unknown size', 'unknown' as const, twoYears, false],
    ['missing jämförelseår', 'smaller' as const, oneYear, false],
    ['unanswered listing question', 'smaller' as const, twoYears, null],
  ])('requires confirmation on %s', (_label, size, metrics, listed) => {
    expect(
      cashFlowOmissionRule({
        framework: 'k3',
        sizeClassification: size,
        metrics,
        securitiesTradedOnRegulatedMarket: listed,
      }),
    ).toBe('requires_confirmation')
  })
})

describe('resolveCashFlowOmission', () => {
  it('omits only on request', () => {
    expect(resolveCashFlowOmission({ rule: 'allowed', requested: false, confirmed: false }).omitted).toBe(false)
    expect(resolveCashFlowOmission({ rule: 'allowed', requested: true, confirmed: false }).omitted).toBe(true)
  })

  it('needs the confirmation when the size cannot be determined', () => {
    expect(
      resolveCashFlowOmission({ rule: 'requires_confirmation', requested: true, confirmed: false }).omitted,
    ).toBe(false)
    expect(
      resolveCashFlowOmission({ rule: 'requires_confirmation', requested: true, confirmed: true }).omitted,
    ).toBe(true)
  })

  it('never omits for a larger company, even with a confirmation', () => {
    expect(
      resolveCashFlowOmission({ rule: 'forbidden', requested: true, confirmed: true }).omitted,
    ).toBe(false)
  })
})

describe('cashFlowOmissionIssues', () => {
  it('warns when a larger company asked to omit', () => {
    const issues = cashFlowOmissionIssues(
      resolveCashFlowOmission({ rule: 'forbidden', requested: true, confirmed: false }),
    )
    expect(issues.map((i) => i.code)).toEqual(['AR-K3-CASHFLOW-REQUIRED'])
  })

  it('warns when the confirmation is missing', () => {
    const issues = cashFlowOmissionIssues(
      resolveCashFlowOmission({ rule: 'requires_confirmation', requested: true, confirmed: false }),
    )
    expect(issues.map((i) => i.code)).toEqual(['AR-K3-CASHFLOW-CONFIRMATION-MISSING'])
  })

  it('is silent when honoured or not requested', () => {
    expect(
      cashFlowOmissionIssues(resolveCashFlowOmission({ rule: 'allowed', requested: true, confirmed: false })),
    ).toEqual([])
    expect(
      cashFlowOmissionIssues(resolveCashFlowOmission({ rule: 'forbidden', requested: false, confirmed: false })),
    ).toEqual([])
    expect(cashFlowOmissionIssues(undefined)).toEqual([])
  })
})

function makeReport(framework: 'k2' | 'k3', omit: boolean, confirmed = false): ArsredovisningData {
  return {
    accounting_framework: framework,
    kassaflodesanalys: { total_cash_flow: 1 },
    warnings: [K3_CASH_FLOW_FAILED_WARNING, k3ContentsNotice(true), 'annan varning'],
    disclosures: {
      omit_kassaflodesanalys: omit,
      kassaflodesanalys_omission_confirmed: confirmed,
    },
  } as unknown as ArsredovisningData
}

function eligibility(size: AnnualReportEligibilityResult['size_classification']): AnnualReportEligibilityResult {
  return {
    k2_eligible: false,
    digital_filing_eligible: false,
    size_classification: size,
    k2_relief_rule: 'eligible',
    issues: [],
    digital_issues: [],
  }
}

const unlistedProfile = {
  ...emptyAnnualReportProfile('co1', 'fp1'),
  securities_traded_on_regulated_market: false,
}

describe('applyCashFlowOmission', () => {
  it('drops the statement and its warnings when the omission is honoured', () => {
    const report = makeReport('k3', true)
    report.warnings.push(K3_CASH_FLOW_TAX_ALLOCATION_WARNING)
    applyCashFlowOmission(report, eligibility('smaller'), twoYears, unlistedProfile)
    expect(report.kassaflodesanalys).toBeUndefined()
    expect(report.kassaflodesanalys_omission).toMatchObject({ rule: 'allowed', omitted: true })
    expect(report.warnings).toEqual([k3ContentsNotice(false), 'annan varning'])
  })

  it('keeps the statement for a larger company that asked to omit it', () => {
    const report = makeReport('k3', true, true)
    applyCashFlowOmission(report, eligibility('larger'), twoYears, unlistedProfile)
    expect(report.kassaflodesanalys).toBeDefined()
    expect(report.kassaflodesanalys_omission).toMatchObject({ rule: 'forbidden', omitted: false })
    expect(report.warnings).toContain(k3ContentsNotice(true))
  })

  it('keeps the statement until the user confirms an undeterminable size', () => {
    const report = makeReport('k3', true, false)
    applyCashFlowOmission(report, eligibility('smaller'), oneYear, unlistedProfile)
    expect(report.kassaflodesanalys).toBeDefined()
    const confirmed = makeReport('k3', true, true)
    applyCashFlowOmission(confirmed, eligibility('smaller'), oneYear, unlistedProfile)
    expect(confirmed.kassaflodesanalys).toBeUndefined()
  })

  it('leaves K2 untouched', () => {
    const report = makeReport('k2', true)
    applyCashFlowOmission(report, eligibility('smaller'), twoYears, unlistedProfile)
    expect(report.kassaflodesanalys_omission).toBeUndefined()
  })
})
