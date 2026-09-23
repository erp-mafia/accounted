import { describe, it, expect } from 'vitest'
import { effectiveNetPayout } from '../effective-net'

describe('effectiveNetPayout', () => {
  it('returns net_salary when there is no tax override', () => {
    expect(
      effectiveNetPayout({ net_salary: 24000, tax_withheld: 8000, tax_withheld_override: null }),
    ).toBe(24000)
  })

  it('is zero for a nollkörning (nothing paid out)', () => {
    expect(
      effectiveNetPayout({ net_salary: 0, tax_withheld: 0, tax_withheld_override: null }),
    ).toBe(0)
  })

  it('raises the payout when tax is overridden lower than computed', () => {
    // Computed tax 8000 → overridden to 5000 means 3000 more reaches the employee.
    expect(
      effectiveNetPayout({ net_salary: 24000, tax_withheld: 8000, tax_withheld_override: 5000 }),
    ).toBe(27000)
  })

  it('lowers the payout when tax is overridden higher than computed', () => {
    expect(
      effectiveNetPayout({ net_salary: 24000, tax_withheld: 8000, tax_withheld_override: 10000 }),
    ).toBe(22000)
  })
})
