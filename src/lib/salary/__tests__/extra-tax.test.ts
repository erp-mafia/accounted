import { describe, it, expect } from 'vitest'
import {
  computeExtraTax,
  EXTRA_TAX_CHECK_CONSTRAINT,
  EXTRA_TAX_ONE_FORM,
  EXTRA_TAX_STEP_LABEL,
  extraTaxIssueFromDbError,
  extraTaxPatch,
  isStorableExtraTaxPercentage,
  touchesExtraTax,
  validateExtraTax,
  type ExtraTaxInput,
} from '../extra-tax'

function input(overrides: Partial<ExtraTaxInput> = {}): ExtraTaxInput {
  return {
    amount: null,
    percentage: null,
    branch: 'table',
    taxableIncome: 26161.27,
    grossSalary: 26161.27,
    netDeductions: 0,
    statutoryTax: 5217,
    ...overrides,
  }
}

describe('validateExtraTax', () => {
  it('accepts no form, the kronor form or the percentage form', () => {
    expect(validateExtraTax({})).toEqual([])
    expect(validateExtraTax({ extra_tax_amount: 500, extra_tax_percentage: null })).toEqual([])
    expect(validateExtraTax({ extra_tax_amount: null, extra_tax_percentage: 45 })).toEqual([])
  })

  it('refuses both forms at once', () => {
    expect(validateExtraTax({ extra_tax_amount: 500, extra_tax_percentage: 45 })).toEqual([
      { field: 'extra_tax_percentage', message: EXTRA_TAX_ONE_FORM },
    ])
  })
})

describe('touchesExtraTax', () => {
  it('is true when the patch names either key, an explicit null included', () => {
    expect(touchesExtraTax({ extra_tax_amount: null })).toBe(true)
    expect(touchesExtraTax({ extra_tax_percentage: 30 })).toBe(true)
    expect(touchesExtraTax({ email: 'a@b.se' })).toBe(false)
  })
})

describe('isStorableExtraTaxPercentage', () => {
  it('takes above 0 up to 100 with at most two decimals', () => {
    expect(isStorableExtraTaxPercentage(45)).toBe(true)
    expect(isStorableExtraTaxPercentage(12.25)).toBe(true)
    expect(isStorableExtraTaxPercentage(100)).toBe(true)
    expect(isStorableExtraTaxPercentage(0)).toBe(false)
    expect(isStorableExtraTaxPercentage(101)).toBe(false)
    expect(isStorableExtraTaxPercentage(33.333)).toBe(false)
  })
})

describe('extraTaxIssueFromDbError', () => {
  it('maps the one-form CHECK by constraint name or message', () => {
    const expected = { field: 'extra_tax_percentage', message: EXTRA_TAX_ONE_FORM }
    expect(extraTaxIssueFromDbError({ code: '23514', constraint: EXTRA_TAX_CHECK_CONSTRAINT })).toEqual(expected)
    expect(
      extraTaxIssueFromDbError({
        code: '23514',
        message: `new row for relation "employees" violates check constraint "${EXTRA_TAX_CHECK_CONSTRAINT}"`,
      }),
    ).toEqual(expected)
  })

  it('leaves every other error alone', () => {
    expect(extraTaxIssueFromDbError({ code: '23514', constraint: 'employees_jamkning_dates_check' })).toBeNull()
    expect(extraTaxIssueFromDbError({ code: '23505', constraint: EXTRA_TAX_CHECK_CONSTRAINT })).toBeNull()
    expect(extraTaxIssueFromDbError(null)).toBeNull()
  })
})

describe('computeExtraTax', () => {
  it('adds nothing and no breakdown row when nothing is requested', () => {
    expect(computeExtraTax(input())).toEqual({ extra: 0, step: null })
  })

  it("withholds 45 % in total on Do the North's figures: 11 772 kr, of which 6 555 kr extra", () => {
    const result = computeExtraTax(input({ percentage: 45 }))
    expect(result.extra).toBe(6555)
    expect(result.step).toMatchObject({
      label: EXTRA_TAX_STEP_LABEL,
      input: { requested_percentage: 45, target_tax: 11772, statutory_tax: 5217 },
      output: 6555,
    })
  })

  it('adds the kronor form on top of the statutory tax', () => {
    const result = computeExtraTax(input({ amount: 500 }))
    expect(result.extra).toBe(500)
    expect(result.step?.formula).toContain('500 kr per lön')
  })

  it('adds nothing when the percentage gives less than the statutory tax, and says so', () => {
    const result = computeExtraTax(input({ percentage: 15 }))
    expect(result.extra).toBe(0)
    expect(result.step?.output).toBe(0)
    expect(result.step?.formula).toContain('är inte mer än skatteavdraget')
  })

  it('applies in the jämkning branch', () => {
    expect(computeExtraTax(input({ branch: 'jamkning', amount: 300 })).extra).toBe(300)
  })

  it.each([
    ['f_skatt', 'F-skatt'],
    ['sidoinkomst', 'sidoinkomst'],
    ['not_verified', 'inte verifierad'],
    ['fallback', 'ingen skattetabell'],
  ] as const)('does not apply in the %s branch, and the row says why', (branch, reason) => {
    const result = computeExtraTax(input({ branch, amount: 500 }))
    expect(result.extra).toBe(0)
    expect(result.step).toMatchObject({ label: EXTRA_TAX_STEP_LABEL, output: 0 })
    expect(result.step?.formula).toContain('tillämpas inte')
    expect(result.step?.formula).toContain(reason)
  })

  it('caps the extra at the cash pay left after tax and net deductions, in whole kronor', () => {
    // 10 000,90 kr gross, 2 000 kr net deductions, 1 500 kr table tax:
    // 8 000 - 1 500 = 6 500 kr of cash left (the öre drop).
    const result = computeExtraTax(
      input({ grossSalary: 10000.9, taxableIncome: 10000.9, netDeductions: 2000, statutoryTax: 1500, amount: 9000 }),
    )
    expect(result.extra).toBe(6500)
    expect(result.step?.formula).toContain('begränsat till kontant lön kvar')
  })

  it('withholds nothing extra when there is no cash pay left', () => {
    const result = computeExtraTax(
      input({ grossSalary: 0, taxableIncome: 3000, statutoryTax: 0, percentage: 45 }),
    )
    expect(result.extra).toBe(0)
    expect(result.step?.formula).toContain('ingen kontant lön kvar')
  })
})

describe('extraTaxPatch', () => {
  const base = {
    f_skatt_status: 'a_skatt',
    is_sidoinkomst: false,
    extra_tax_amount: null,
    extra_tax_percentage: 45,
    extra_tax_touched: true,
  }

  it('sends both keys when the inputs were visible and edited', () => {
    expect(extraTaxPatch(base)).toEqual({ extra_tax_amount: null, extra_tax_percentage: 45 })
  })

  it('sends nothing when untouched, so a stored request survives an unrelated edit', () => {
    expect(extraTaxPatch({ ...base, extra_tax_touched: false })).toEqual({})
  })

  it('sends nothing when the inputs were hidden (F-skatt, sidoinkomst), so the stored value is kept', () => {
    expect(extraTaxPatch({ ...base, f_skatt_status: 'f_skatt', extra_tax_percentage: null })).toEqual({})
    expect(extraTaxPatch({ ...base, is_sidoinkomst: true, extra_tax_percentage: null })).toEqual({})
  })
})
