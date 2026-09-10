import { describe, expect, it } from 'vitest'
import { dayValueSek, type DayValueEmployee } from '../semesterberedning'

/**
 * dayValueSek is the one day valuation shared by the semesterårsavslut, the
 * MCP vacation-balance tool and the v1 vacation-balance route. A
 * kollektivavtal semesterlön rate must reach all three through it.
 */

const MONTHLY_PROCENT: DayValueEmployee = {
  vacation_rule: 'procentregeln',
  vacation_days_per_year: 25,
  vacation_pay_rate: null,
  salary_type: 'monthly',
  monthly_salary: 30000,
  hourly_rate: null,
  hours_per_week: 40,
  workdays_per_week: 5,
}

describe('dayValueSek', () => {
  it('monthly procentregeln at the statutory 12 %', () => {
    // 30000 x 12 x 0.12 / 25 = 1728
    expect(dayValueSek(MONTHLY_PROCENT)).toBe(1728)
  })

  it('monthly procentregeln at a kollektivavtal 13.5 %', () => {
    // 30000 x 12 x 0.135 / 25 = 1944
    expect(dayValueSek({ ...MONTHLY_PROCENT, vacation_pay_rate: 0.135 })).toBe(1944)
  })

  it('hourly procentregeln at a kollektivavtal 13.5 %', () => {
    // 200 x 40 x 52 x 0.135 / 25 = 2246.4
    expect(
      dayValueSek({
        ...MONTHLY_PROCENT,
        salary_type: 'hourly',
        monthly_salary: null,
        hourly_rate: 200,
        vacation_pay_rate: 0.135,
      }),
    ).toBe(2246.4)
  })

  it('sammalöneregeln ignores the kollektivavtal rate (it has its own tillägg)', () => {
    const withoutRate = dayValueSek({ ...MONTHLY_PROCENT, vacation_rule: 'sammaloneregeln' })
    const withRate = dayValueSek({
      ...MONTHLY_PROCENT,
      vacation_rule: 'sammaloneregeln',
      vacation_pay_rate: 0.135,
    })
    // 30000 / 21 + 30000 x 0.0043 = 1557.57
    expect(withoutRate).toBe(1557.57)
    expect(withRate).toBe(withoutRate)
  })

  it('sammalöneregeln values the day at the employee\'s own tillägg rate', () => {
    // 30000 / 21 + 30000 x 0.008 = 1668.57
    expect(
      dayValueSek({ ...MONTHLY_PROCENT, vacation_rule: 'sammaloneregeln', semestertillagg_rate: 0.008 }),
    ).toBe(1668.57)
    // null falls back to the statutory 0.43 %.
    expect(
      dayValueSek({ ...MONTHLY_PROCENT, vacation_rule: 'sammaloneregeln', semestertillagg_rate: null }),
    ).toBe(1557.57)
  })
})
