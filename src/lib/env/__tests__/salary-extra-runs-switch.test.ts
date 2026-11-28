import { describe, expect, it } from 'vitest'
import { isSalaryExtraRunsEnabled, salaryExtraRunsRollout } from '../salary-extra-runs-switch'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('salaryExtraRunsRollout', () => {
  it('is nobody when the variable is unset or blank', () => {
    expect(salaryExtraRunsRollout({})).toEqual([])
    expect(salaryExtraRunsRollout({ SALARY_EXTRA_RUNS_COMPANY_IDS: '   ' })).toEqual([])
  })

  it('is everyone for a star', () => {
    expect(salaryExtraRunsRollout({ SALARY_EXTRA_RUNS_COMPANY_IDS: ' * ' })).toBe('all')
  })

  it('lists each id once, trimmed and lowercased', () => {
    expect(salaryExtraRunsRollout({ SALARY_EXTRA_RUNS_COMPANY_IDS: ` ${A.toUpperCase()}, ${B},,${A} ` })).toEqual([A, B])
  })
})

describe('isSalaryExtraRunsEnabled', () => {
  it('is off without a company', () => {
    expect(isSalaryExtraRunsEnabled(null, { SALARY_EXTRA_RUNS_COMPANY_IDS: '*' })).toBe(false)
    expect(isSalaryExtraRunsEnabled(undefined, { SALARY_EXTRA_RUNS_COMPANY_IDS: '*' })).toBe(false)
  })

  it('is off for everyone while the variable is unset', () => {
    expect(isSalaryExtraRunsEnabled(A, {})).toBe(false)
  })

  it('is on for a listed company, whatever the case of its id', () => {
    const env = { SALARY_EXTRA_RUNS_COMPANY_IDS: A }
    expect(isSalaryExtraRunsEnabled(A, env)).toBe(true)
    expect(isSalaryExtraRunsEnabled(A.toUpperCase(), env)).toBe(true)
    expect(isSalaryExtraRunsEnabled(B, env)).toBe(false)
  })

  it('is on for every company with a star', () => {
    expect(isSalaryExtraRunsEnabled(B, { SALARY_EXTRA_RUNS_COMPANY_IDS: '*' })).toBe(true)
  })
})
