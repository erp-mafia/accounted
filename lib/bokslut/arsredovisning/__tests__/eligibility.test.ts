import { describe, expect, it } from 'vitest'
import { emptyAnnualReportProfile } from '../compliance-types'
import { evaluateAnnualReportEligibility } from '../eligibility'

const metrics = {
  current: { employees: 2, balance_sheet_total: 1_000_000, net_revenue: 2_000_000 },
  previous: { employees: 2, balance_sheet_total: 900_000, net_revenue: 1_800_000 },
}

function completeProfile() {
  return {
    ...emptyAnnualReportProfile('company-1', 'period-1'),
    is_public_limited_company: false,
    is_in_liquidation: false,
    securities_traded_on_regulated_market: false,
    is_parent_company: false,
    has_foreign_branch: false,
    has_crypto_assets: false,
    has_share_based_payments: false,
    has_convertible_debt: false,
    building_revenue_share_pct: 0,
    has_material_deferred_tax: false,
    auditor_report_required: false,
  }
}

describe('evaluateAnnualReportEligibility', () => {
  it('accepts a confirmed smaller private K2 company without auditor report', () => {
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: completeProfile(),
      metrics,
    })
    expect(result.k2_eligible).toBe(true)
    expect(result.digital_filing_eligible).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('blocks EUR reports before they can be finalized or filed digitally', () => {
    const profile = completeProfile()
    profile.reporting_currency = 'EUR'
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile,
      metrics,
    })

    expect(result.k2_eligible).toBe(false)
    expect(result.digital_filing_eligible).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'AR-SCOPE-CURRENCY', severity: 'error' }),
      ]),
    )
    expect(result.digital_issues.filter((item) => item.code === 'AR-SCOPE-CURRENCY')).toHaveLength(
      1,
    )
    expect(
      result.digital_issues.filter((item) => item.code === 'AR-DIGITAL-CURRENCY'),
    ).toHaveLength(0)
  })

  it('does not treat unanswered legal facts as false', () => {
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: emptyAnnualReportProfile('company-1', 'period-1'),
      metrics,
    })
    expect(result.k2_eligible).toBe(false)
    expect(result.issues.some((item) => item.code === 'AR-K2-PUBLIC-UNKNOWN')).toBe(true)
    expect(result.digital_issues.some((item) => item.code === 'AR-DIGITAL-AUDIT-UNKNOWN')).toBe(
      true,
    )
  })

  it('blocks a larger company after two consecutive threshold years', () => {
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k2',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      profile: completeProfile(),
      metrics: {
        current: { employees: 51, balance_sheet_total: 41_000_000, net_revenue: 10_000_000 },
        previous: { employees: 52, balance_sheet_total: 42_000_000, net_revenue: 10_000_000 },
      },
    })
    expect(result.size_classification).toBe('larger')
    expect(result.issues.some((item) => item.code === 'AR-K2-LARGE')).toBe(true)
  })

  it('blocks liquidation reports because they need a separate measurement model', () => {
    const profile = completeProfile()
    profile.is_in_liquidation = true
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile,
      metrics,
    })
    expect(result.issues.some((item) => item.code === 'AR-SCOPE-LIQUIDATION')).toBe(true)
  })

  it('applies the new K2 exclusions to financial years starting in 2026', () => {
    const profile = completeProfile()
    profile.has_crypto_assets = true
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile,
      metrics,
    })
    expect(result.issues.some((item) => item.code === 'AR-K2-CRYPTO')).toBe(true)
  })

  it('keeps K3 available for paper but does not claim digital K3 support', () => {
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k3',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: completeProfile(),
      metrics,
    })
    expect(result.k2_eligible).toBe(false)
    expect(result.digital_filing_eligible).toBe(false)
    expect(result.digital_issues.some((item) => item.code === 'AR-DIGITAL-FRAMEWORK')).toBe(true)
  })
})
