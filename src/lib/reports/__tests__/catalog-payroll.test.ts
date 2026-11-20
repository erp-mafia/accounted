import { describe, expect, it } from 'vitest'
import { getLibrarySections, getReport } from '@/lib/reports/catalog'

const payrollSlugs = (hasEmployees?: boolean) =>
  getLibrarySections('aktiebolag', hasEmployees, false)
    .find((s) => s.category === 'payroll')
    ?.items.map((r) => r.slug) ?? []

describe('payroll reports in the library', () => {
  it('lists Semesterskuld under Lön for a company with employees', () => {
    expect(payrollSlugs(true)).toContain('semesterskuld')
  })

  it('hides it when the company has no employees (or the count is unknown)', () => {
    expect(payrollSlugs(false)).not.toContain('semesterskuld')
    expect(payrollSlugs(undefined)).not.toContain('semesterskuld')
  })

  it('opens in the focused report shell, not an external route', () => {
    const report = getReport('semesterskuld')
    expect(report?.params).toBe('fiscal')
    expect(report?.route).toBeUndefined()
  })
})
