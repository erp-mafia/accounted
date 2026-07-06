import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/salary/personnummer', () => ({
  decryptPersonnummer: vi.fn((v: string) => v),
  maskPersonnummer: vi.fn(() => '19900101-****'),
}))

import { buildPayslipData, payslipFileName } from '../build-payslip-data'

const run = { period_year: 2026, period_month: 6, payment_date: '2026-06-25' }

const employee = {
  first_name: 'Anna',
  last_name: 'Exempelsson',
  personnummer: 'enc',
  employment_type: 'employee',
  tax_table_number: 33,
  tax_column: 1,
  clearing_number: '8327',
  bank_account_number: '9876543',
}

function sre(overrides: Record<string, unknown> = {}) {
  return {
    gross_salary: 35000,
    tax_withheld: 8000,
    tax_withheld_override: null,
    avgifter_rate: 0.3142,
    avgifter_amount: 10997,
    avgifter_amount_override: null,
    avgifter_basis_override: null,
    override_reason: null,
    net_salary: 27000,
    vacation_accrual: 4200,
    vacation_accrual_avgifter: 1319.74,
    ytd_gross: 210000,
    ytd_tax: 48000,
    ytd_net: 162000,
    calculation_breakdown: { steps: [{ label: 'Bruttolön', formula: '35000', output: 35000 }] },
    line_items: [
      { description: 'Grundlön', amount: 35000, sort_order: 0 },
    ],
    ...overrides,
  }
}

describe('buildPayslipData', () => {
  it('assembles the payslip without overrides', () => {
    const data = buildPayslipData({ run, sre: sre(), employee, company: { name: 'Bolaget AB', org_number: '5560000000' } })

    expect(data.grossSalary).toBe(35000)
    expect(data.taxWithheld).toBe(8000)
    expect(data.netSalary).toBe(27000)
    expect(data.taxReference).toBe('Tabell 33, kol 1')
    expect(data.employmentType).toBe('Anställd')
    expect(data.bankAccount).toBe('8327-****6543')
    expect(data.totalEmployerCost).toBe(35000 + 10997 + 4200 + 1319.74)
    expect(data.breakdownSteps).toHaveLength(1)
    expect(data.personnummerMasked).toBe('19900101-****')
  })

  it('coalesces tax/avgifter overrides and adjusts net accordingly', () => {
    const data = buildPayslipData({
      run,
      sre: sre({
        tax_withheld_override: 7000,
        avgifter_amount_override: 9000,
        override_reason: 'jämkning',
      }),
      employee,
      company: { name: 'Bolaget AB', org_number: null },
    })

    // 1000 kr less tax withheld → 1000 kr more net
    expect(data.taxWithheld).toBe(7000)
    expect(data.netSalary).toBe(28000)
    expect(data.avgifterAmount).toBe(9000)
    expect(data.totalEmployerCost).toBe(35000 + 9000 + 4200 + 1319.74)
    // Engine steps stay, override rows appended with the reason
    const labels = (data.breakdownSteps ?? []).map(s => s.label)
    expect(labels).toContain('Manuell justering: Skatteavdrag')
    expect(labels).toContain('Manuell justering: Arbetsgivaravgifter')
    const overrideRow = (data.breakdownSteps ?? []).find(
      s => s.label === 'Manuell justering: Skatteavdrag',
    )
    expect(overrideRow?.formula).toBe('jämkning')
  })

  it('falls back to schablon tax reference and omits bank account when data missing', () => {
    const data = buildPayslipData({
      run,
      sre: sre(),
      employee: {
        ...employee,
        tax_table_number: null,
        clearing_number: null,
        bank_account_number: null,
      },
      company: { name: 'Bolaget AB', org_number: null },
    })

    expect(data.taxReference).toBe('Schablon 30%')
    expect(data.bankAccount).toBeUndefined()
    expect(data.companyOrgNumber).toBe('')
  })

  it('sorts line items by sort_order', () => {
    const data = buildPayslipData({
      run,
      sre: sre({
        line_items: [
          { description: 'Förmån', amount: 500, sort_order: 2 },
          { description: 'Grundlön', amount: 35000, sort_order: 0 },
        ],
      }),
      employee,
      company: { name: 'Bolaget AB', org_number: null },
    })

    expect(data.lineItems.map(li => li.description)).toEqual(['Grundlön', 'Förmån'])
  })
})

describe('payslipFileName', () => {
  it('builds the period-stamped filename', () => {
    expect(payslipFileName(run, employee)).toBe('lonespec_Exempelsson_Anna_2026-06.pdf')
  })
})
