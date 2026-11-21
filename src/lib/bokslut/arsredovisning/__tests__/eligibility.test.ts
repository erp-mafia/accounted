import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyAnnualReportProfile } from '../compliance-types'
import { evaluateAnnualReportEligibility } from '../eligibility'
import en from '@/messages/en.json'
import sv from '@/messages/sv.json'

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

afterEach(() => vi.unstubAllEnvs())

describe('evaluateAnnualReportEligibility', () => {
  it.each(['ideell_forening', 'enskild_firma', 'handelsbolag'])(
    'blocks a form whose profile prepares no årsredovisning (%s)',
    (entityType) => {
      const result = evaluateAnnualReportEligibility({
        entityType,
        framework: 'k2',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        profile: completeProfile(),
        metrics,
      })
      expect(result.digital_filing_eligible).toBe(false)
      expect(result.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'AR-SCOPE-ENTITY' })]),
      )
    },
  )

  // ÅRL 1 kap. 3 § 4: "företag vars överlåtbara värdepapper är upptagna till
  // handel på en reglerad marknad". A company that only holds listed shares is
  // not listed, so every wording of the question names what the company issued.
  it('asks about securities the company itself issued, not listed shares it holds', () => {
    expect(sv.annualReportStudio.listed_securities).toContain('bolaget självt har gett ut')
    expect(en.annualReportStudio.listed_securities).toContain('the company itself has issued')
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: { ...completeProfile(), securities_traded_on_regulated_market: null },
      metrics,
    })
    const unanswered = result.issues.find((issue) => issue.code === 'AR-K2-LISTED-UNKNOWN')
    expect(unanswered?.message).toContain('bolaget självt har gett ut')
  })

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

  it('accepts an ekonomisk förening under K2 but keeps it off the digital AB taxonomy', () => {
    const profile = completeProfile()
    profile.auditor_report_required = true
    const result = evaluateAnnualReportEligibility({
      entityType: 'ekonomisk_forening',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile,
      metrics,
    })
    expect(result.issues.map((issue) => issue.code)).not.toContain('AR-SCOPE-ENTITY')
    expect(result.k2_eligible).toBe(true)
    expect(result.digital_filing_eligible).toBe(false)
    expect(result.digital_issues.map((issue) => issue.code)).toContain('AR-DIGITAL-ENTITY')
  })

  it('requires the revisionsberättelse for an ekonomisk förening (EFL 8 kap. 1 §)', () => {
    const profile = completeProfile()
    profile.auditor_report_required = false
    const result = evaluateAnnualReportEligibility({
      entityType: 'ekonomisk_forening',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile,
      metrics,
    })
    const issue = result.issues.find((item) => item.code === 'AR-AUDITOR-REQUIRED-FORENING')
    expect(issue?.message).toContain('EFL 8 kap. 1 §')
    expect(result.k2_eligible).toBe(false)
  })

  it('fails closed for an ekonomisk förening under K3 until its equity statement ships', () => {
    const profile = completeProfile()
    profile.auditor_report_required = true
    const result = evaluateAnnualReportEligibility({
      entityType: 'ekonomisk_forening',
      framework: 'k3',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile,
      metrics,
    })
    expect(result.issues.map((issue) => issue.code)).toContain('AR-SCOPE-ENTITY-FRAMEWORK')
  })

  it('keeps the generic scope message for forms that never prepare an årsredovisning here', () => {
    const result = evaluateAnnualReportEligibility({
      entityType: 'ideell_forening',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: completeProfile(),
      metrics,
    })
    const scope = result.issues.find((issue) => issue.code === 'AR-SCOPE-ENTITY')
    expect(scope?.message).toContain('företagsformen')
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

  it('keeps an audited K2 aktiebolag eligible for digital filing: the revisionsberättelse is kompletteras', () => {
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: { ...completeProfile(), auditor_report_required: true },
      metrics,
    })
    expect(result.digital_filing_eligible).toBe(true)
    const audit = result.digital_issues.find((item) => item.code === 'AR-DIGITAL-AUDIT')
    expect(audit).toMatchObject({ severity: 'info', section: 'filing' })
    expect(audit?.message).toMatch(/separat/)
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
    const framework = result.digital_issues.find((item) => item.code === 'AR-DIGITAL-FRAMEWORK')
    expect(framework).toBeDefined()
    // The copy points at no paper flow: K3 paper is off until the reviewed K3 document.
    expect(`${framework?.message} ${framework?.remediation}`).not.toMatch(/pappersflödet/i)
  })

  it('lets a K3 year file digitally once the K3 iXBRL document is switched on', () => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', 'true')
    // A K3 year inside the scope the K3 document covers (the K3 scope
    // checks): a mindre aktiebolag, not its first K3 year, no temporary
    // differences beyond obeskattade reserver.
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k3',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: { ...completeProfile(), has_other_temporary_differences: false },
      metrics,
      k3: { firstYear: 'not_first', deferredTaxBooked: [], temporaryDifferenceHints: [] },
    })
    expect(result.digital_issues.some((item) => item.code === 'AR-DIGITAL-FRAMEWORK')).toBe(false)
    expect(result.digital_filing_eligible).toBe(true)
  })

  it('keeps the K3 framework gate while only the iXBRL flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', '')
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', 'true')
    // A K3 year inside the scope the K3 document covers: only the flags
    // keep it from filing digitally.
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k3',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: { ...completeProfile(), has_other_temporary_differences: false },
      metrics,
      k3: { firstYear: 'not_first', deferredTaxBooked: [], temporaryDifferenceHints: [] },
    })
    expect(result.digital_filing_eligible).toBe(false)
    expect(result.digital_issues.some((item) => item.code === 'AR-DIGITAL-FRAMEWORK')).toBe(true)
  })
})

describe('the K3 scope checks (fail closed)', () => {
  const k3Profile = () => ({ ...completeProfile(), has_other_temporary_differences: false })
  const k3 = {
    firstYear: 'not_first' as const,
    deferredTaxBooked: [] as string[],
    temporaryDifferenceHints: [] as string[],
  }
  const evaluate = (overrides: Partial<Parameters<typeof evaluateAnnualReportEligibility>[0]> = {}) =>
    evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k3',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: k3Profile(),
      metrics,
      k3,
      ...overrides,
    })
  const codes = (result: ReturnType<typeof evaluateAnnualReportEligibility>) => result.issues.map((issue) => issue.code)

  it('accepts a mindre aktiebolag in a later K3 year without other temporary differences', () => {
    expect(evaluate().issues).toEqual([])
  })

  it('blocks a större företag, by size or by listed securities', () => {
    const large = { employees: 60, balance_sheet_total: 50_000_000, net_revenue: 90_000_000 }
    expect(codes(evaluate({ metrics: { current: large, previous: large } }))).toContain('AR-K3-STORRE-UNSUPPORTED')
    const listed = { ...k3Profile(), securities_traded_on_regulated_market: true }
    expect(codes(evaluate({ profile: listed }))).toContain('AR-K3-STORRE-UNSUPPORTED')
  })

  it('blocks an unknown size, an unanswered listing and an unanswered publikt question', () => {
    const unknown = { current: { ...metrics.current, employees: null }, previous: metrics.previous }
    expect(codes(evaluate({ metrics: unknown }))).toContain('AR-K3-SIZE-UNKNOWN')
    const unanswered = { ...k3Profile(), securities_traded_on_regulated_market: null, is_public_limited_company: null }
    expect(codes(evaluate({ profile: unanswered }))).toEqual(
      expect.arrayContaining(['AR-K3-LISTED-UNKNOWN', 'AR-K3-PUBLIC-UNKNOWN']),
    )
  })

  it('blocks the first K3 year after K2 and an unknown history', () => {
    expect(codes(evaluate({ k3: { ...k3, firstYear: 'after_k2' } }))).toContain('AR-K3-FIRST-YEAR-UNSUPPORTED')
    expect(codes(evaluate({ k3: { ...k3, firstYear: 'unknown' } }))).toContain('AR-K3-FIRST-YEAR-UNKNOWN')
    expect(codes(evaluate({ k3: undefined }))).toContain('AR-K3-FIRST-YEAR-UNKNOWN')
    expect(codes(evaluate({ k3: { ...k3, firstYear: 'new_company' } }))).not.toContain('AR-K3-FIRST-YEAR-UNKNOWN')
  })

  it('blocks booked deferred tax whatever the answer, and asks the question otherwise', () => {
    const booked = evaluate({ k3: { ...k3, deferredTaxBooked: ['uppskjuten skatteskuld är bokförd (konto 2240)'] } })
    expect(codes(booked)).toContain('AR-K3-TEMPORARY-DIFFERENCES-UNSUPPORTED')
    expect(booked.issues.find((i) => i.code === 'AR-K3-TEMPORARY-DIFFERENCES-UNSUPPORTED')?.message).toMatch(/2240/)
    const yes = evaluate({ profile: { ...k3Profile(), has_other_temporary_differences: true } })
    expect(codes(yes)).toContain('AR-K3-TEMPORARY-DIFFERENCES-UNSUPPORTED')
    const unanswered = evaluate({
      profile: { ...k3Profile(), has_other_temporary_differences: null },
      k3: { ...k3, temporaryDifferenceHints: ['företaget har byggnader eller markanläggningar'] },
    })
    const issue = unanswered.issues.find((i) => i.code === 'AR-K3-TEMPORARY-DIFFERENCES-UNKNOWN')
    expect(issue?.message).toMatch(/byggnader eller markanläggningar/)
  })

  it('runs no K3 check on a K2 report', () => {
    const result = evaluateAnnualReportEligibility({
      entityType: 'aktiebolag',
      framework: 'k2',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      profile: completeProfile(),
      metrics,
    })
    expect(codes(result).filter((code) => code.startsWith('AR-K3-'))).toEqual([])
  })
})
