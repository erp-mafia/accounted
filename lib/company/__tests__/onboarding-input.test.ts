import { describe, expect, it } from 'vitest'
import { CompanySetupSchema, planCompanySetup } from '../onboarding-input'

const base = {
  name: 'Testbolaget AB',
  entity_type: 'aktiebolag' as const,
  org_number: '5560000001',
  vat_registered: true,
  moms_period: 'quarterly' as const,
  accounting_method: 'accrual' as const,
  f_skatt: true,
}

describe('CompanySetupSchema', () => {
  it('accepts a complete aktiebolag setup', () => {
    expect(CompanySetupSchema.safeParse(base).success).toBe(true)
  })

  it('refuses a VAT-registered company without a moms_period (silent zero-deadline trap)', () => {
    const result = CompanySetupSchema.safeParse({ ...base, moms_period: undefined })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'moms_period')).toBe(true)
    }
  })

  it('refuses a moms_period on a company that is not VAT-registered', () => {
    const result = CompanySetupSchema.safeParse({ ...base, vat_registered: false })
    expect(result.success).toBe(false)
  })

  it('accepts a non-VAT company with no moms_period', () => {
    const result = CompanySetupSchema.safeParse({ ...base, vat_registered: false, moms_period: undefined })
    expect(result.success).toBe(true)
  })

  it('refuses a VAT-registered company without an org number (invoice momsregistreringsnummer)', () => {
    const result = CompanySetupSchema.safeParse({ ...base, org_number: undefined })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'org_number')).toBe(true)
    }
  })

  it('accepts a non-VAT company without an org number', () => {
    const result = CompanySetupSchema.safeParse({
      ...base,
      org_number: undefined,
      vat_registered: false,
      moms_period: undefined,
    })
    expect(result.success).toBe(true)
  })

  it('refuses an omitted f_skatt: F-skatt approval is never assumed', () => {
    const result = CompanySetupSchema.safeParse({ ...base, f_skatt: undefined })
    expect(result.success).toBe(false)
  })

  it('refuses an enskild firma first fiscal year that does not end on 31 December', () => {
    const result = CompanySetupSchema.safeParse({
      ...base,
      entity_type: 'enskild_firma',
      first_fiscal_year: { start: '2026-03-15', end: '2027-06-30' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'first_fiscal_year.end')).toBe(true)
    }
  })

  it('refuses a malformed organisationsnummer', () => {
    const result = CompanySetupSchema.safeParse({ ...base, org_number: '1234' })
    expect(result.success).toBe(false)
  })
})

describe('planCompanySetup', () => {
  it('produces the wizard-shaped settings and a calendar-year period by default', () => {
    const plan = planCompanySetup(CompanySetupSchema.parse(base))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const year = new Date().getFullYear()
    expect(plan.fiscalPeriod.startDate).toBe(`${year}-01-01`)
    expect(plan.fiscalPeriod.endDate).toBe(`${year}-12-31`)
    expect(plan.input.settings).toMatchObject({
      entity_type: 'aktiebolag',
      company_name: 'Testbolaget AB',
      org_number: '5560000001',
      vat_registered: true,
      vat_number: 'SE556000000101',
      moms_period: 'quarterly',
      accounting_method: 'accrual',
      f_skatt: true,
      fiscal_year_start_month: 1,
      is_first_fiscal_year: false,
    })
  })

  it('forces enskild firma onto the calendar year regardless of the requested start month', () => {
    const plan = planCompanySetup(
      CompanySetupSchema.parse({ ...base, entity_type: 'enskild_firma', fiscal_year_start_month: 7 })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.input.settings.fiscal_year_start_month).toBe(1)
    expect(plan.fiscalPeriod.startDate.endsWith('-01-01')).toBe(true)
  })

  it('uses the first fiscal year dates and derives the start month from its end', () => {
    const plan = planCompanySetup(
      CompanySetupSchema.parse({
        ...base,
        first_fiscal_year: { start: '2026-03-15', end: '2027-06-30' },
      })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.fiscalPeriod).toMatchObject({ startDate: '2026-03-15', endDate: '2027-06-30' })
    expect(plan.fiscalPeriod.name).toContain('Första räkenskapsåret')
    expect(plan.input.settings.fiscal_year_start_month).toBe(7)
    expect(plan.input.settings.is_first_fiscal_year).toBe(true)
  })

  it('keeps an enskild firma on the calendar year through a first fiscal year ending 31 December', () => {
    const plan = planCompanySetup(
      CompanySetupSchema.parse({
        ...base,
        entity_type: 'enskild_firma',
        first_fiscal_year: { start: '2026-03-15', end: '2026-12-31' },
      })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.fiscalPeriod).toMatchObject({ startDate: '2026-03-15', endDate: '2026-12-31' })
    expect(plan.input.settings.fiscal_year_start_month).toBe(1)
  })

  it('carries f_skatt=false through instead of defaulting to approved', () => {
    const plan = planCompanySetup(CompanySetupSchema.parse({ ...base, f_skatt: false }))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.input.settings.f_skatt).toBe(false)
  })

  it('rejects a first fiscal year longer than 18 months', () => {
    const plan = planCompanySetup(
      CompanySetupSchema.parse({
        ...base,
        first_fiscal_year: { start: '2026-01-01', end: '2027-12-31' },
      })
    )
    expect(plan.ok).toBe(false)
  })

  it('leaves vat_number null and moms_period null for a non-VAT company', () => {
    const plan = planCompanySetup(
      CompanySetupSchema.parse({ ...base, vat_registered: false, moms_period: undefined })
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.input.settings.vat_number).toBeNull()
    expect(plan.input.settings.moms_period).toBeNull()
  })
})
