import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/salary/personnummer', () => ({
  decryptPersonnummer: vi.fn((v: string) => v),
  maskPersonnummer: vi.fn(() => '19900101-****'),
}))

import {
  buildPayslipData,
  issuedPayslipSections,
  parsePayslipAudienceParam,
  payslipFileName,
  payslipSectionsFor,
  type PayslipAudience,
} from '../build-payslip-data'

const run = { period_year: 2026, period_month: 6, payment_date: '2026-06-25' }

const EMPLOYER: PayslipAudience = { kind: 'employer' }

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
    const data = buildPayslipData({ run, sre: sre(), employee, company: { name: 'Bolaget AB', org_number: '5560000000' }, audience: EMPLOYER })

    expect(data.grossSalary).toBe(35000)
    expect(data.taxWithheld).toBe(8000)
    expect(data.netSalary).toBe(27000)
    expect(data.taxReference).toBe('Tabell 33, kol 1')
    expect(data.employmentType).toBe('Anställd')
    expect(data.bankAccount).toBe('8327-****6543')
    expect(data.employerCost?.totalEmployerCost).toBe(35000 + 10997 + 4200 + 1319.74)
    expect(data.breakdownSteps).toHaveLength(1)
    expect(data.personnummerMasked).toBe('19900101-****')
  })

  it('leaves the växa-stöd refund note off the employee payslip: it is an instruction to the employer', () => {
    const data = buildPayslipData({
      run,
      sre: sre({
        calculation_breakdown: {
          steps: [
            { label: 'Bruttolön', formula: '35000', output: 35000 },
            { label: 'Växa-stöd: ansök om återbetalning hos Skatteverket', formula: 'växa-stöd sänker inte avgiften', output: null },
          ],
        },
      }),
      employee,
      company: { name: 'Bolaget AB', org_number: null },
      audience: EMPLOYER,
    })

    expect((data.breakdownSteps ?? []).map(s => s.label)).toEqual(['Bruttolön'])
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
      audience: EMPLOYER,
    })

    // 1000 kr less tax withheld → 1000 kr more net
    expect(data.taxWithheld).toBe(7000)
    expect(data.netSalary).toBe(28000)
    expect(data.employerCost?.avgifterAmount).toBe(9000)
    expect(data.employerCost?.totalEmployerCost).toBe(35000 + 9000 + 4200 + 1319.74)
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
      audience: EMPLOYER,
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
      audience: EMPLOYER,
    })

    expect(data.lineItems.map(li => li.description)).toEqual(['Grundlön', 'Förmån'])
  })
})

describe('buildPayslipData: tax table the run used (#3400)', () => {
  const company = { name: 'Bolaget AB', org_number: null }

  it('prints the table the run was calculated on after the employee moved to another table', () => {
    const data = buildPayslipData({
      run,
      sre: sre({ tax_table_number: 33, tax_column: 1, tax_table_year: 2026 }),
      employee: { ...employee, tax_table_number: 34, tax_column: 2 },
      company,
      audience: EMPLOYER,
    })

    expect(data.taxReference).toBe('Tabell 33, kol 1')
  })

  it('prints the same table on the employee copy', () => {
    const data = buildPayslipData({
      run,
      sre: sre({ tax_table_number: 33, tax_column: 1, tax_table_year: 2026 }),
      employee: { ...employee, tax_table_number: 34, tax_column: 2 },
      company,
      audience: { kind: 'employee', settings: null },
    })

    expect(data.taxReference).toBe('Tabell 33, kol 1')
  })

  it('falls back to the employee row for a run row that never had the snapshot written', () => {
    const data = buildPayslipData({
      run,
      sre: sre({ tax_table_number: null, tax_column: null, tax_table_year: null }),
      employee: { ...employee, tax_table_number: 34, tax_column: 2 },
      company,
      audience: EMPLOYER,
    })

    expect(data.taxReference).toBe('Tabell 34, kol 2')
  })

  it('prints Schablon 30% for a run taxed without a table even if the employee has one now', () => {
    const data = buildPayslipData({
      run,
      sre: sre({ tax_table_number: null, tax_column: 1, tax_table_year: 2026 }),
      employee: { ...employee, tax_table_number: 34, tax_column: 1 },
      company,
      audience: EMPLOYER,
    })

    expect(data.taxReference).toBe('Schablon 30%')
  })

  it('prints column 1 when the snapshot has a table but no column, as the engine calculated', () => {
    const data = buildPayslipData({
      run,
      sre: sre({ tax_table_number: 33, tax_column: null, tax_table_year: 2026 }),
      employee: { ...employee, tax_table_number: 34, tax_column: 3 },
      company,
      audience: EMPLOYER,
    })

    expect(data.taxReference).toBe('Tabell 33, kol 1')
  })
})

describe('payslipFileName', () => {
  it('builds the period-stamped filename', () => {
    expect(payslipFileName(run, employee)).toBe('lonespec_Exempelsson_Anna_2026-06.pdf')
  })
})

describe('buildPayslipData: engångsskatt', () => {
  it('marks a line taxed at a flat one-off percentage in its description', () => {
    const data = buildPayslipData({
      run,
      sre: sre({
        line_items: [
          { description: 'Grundlön', amount: 35000, sort_order: 0, one_off_tax_percent: null },
          { description: 'Bonus', amount: 5000, sort_order: 10, one_off_tax_percent: 30 },
        ],
      }),
      employee,
      company: { name: 'Bolaget AB', org_number: null },
      audience: EMPLOYER,
    })
    expect(data.lineItems.map(li => li.description)).toEqual(['Grundlön', 'Bonus (engångsskatt 30 %)'])
  })
})

describe('buildPayslipData: audience (crm#202)', () => {
  const company = { name: 'Bolaget AB', org_number: '5560000000' }
  const withOverride = sre({ tax_withheld_override: 7000, override_reason: 'jämkning' })
  const build = (audience: PayslipAudience) =>
    buildPayslipData({ run, sre: withOverride, employee, company, audience })

  it('keeps both sections on the employer view, whatever the company switches say', () => {
    const data = build(EMPLOYER)
    expect(data.employerCost).not.toBeNull()
    expect(data.breakdownSteps?.map(s => s.label)).toEqual(['Bruttolön', 'Manuell justering: Skatteavdrag'])
  })

  it('omits Arbetsgivarkostnad from the employee copy when its switch is off', () => {
    const data = build({
      kind: 'employee',
      settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: true },
    })
    expect(data.employerCost).toBeNull()
  })

  it('never leaks the employer cost through Beräkningsunderlag when only the employer cost switch is off', () => {
    // The engine's steps carry the employer cost figures themselves.
    const steps = [
      { label: 'Bruttolön', formula: '35000', output: 35000 },
      { label: 'Arbetsgivaravgifter', formula: '35000 x 31,42 %', output: 10997 },
      { label: 'Semesteravsättning (procentregeln 12 %)', formula: '35000 x 12 %', output: 4200 },
      { label: 'Arbetsgivaravgifter på semesteravsättning', formula: '4200 x 31,42 %', output: 1319.74 },
      { label: 'Total arbetsgivarkostnad', formula: 'summa', output: 51516.74 },
    ]
    const data = buildPayslipData({
      run,
      sre: sre({ calculation_breakdown: { steps }, avgifter_amount_override: 10000, override_reason: 'justering' }),
      employee,
      company,
      audience: {
        kind: 'employee',
        settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: true },
      },
    })
    const serialized = JSON.stringify(data)
    expect(serialized).not.toContain('Arbetsgivaravgifter')
    expect(serialized).not.toContain('Total arbetsgivarkostnad')
    expect(serialized).not.toContain('Semesteravsättning')
    expect(serialized).not.toContain('51516.74')
    expect(serialized).not.toContain('10997')
    expect(data.breakdownSteps).toBeUndefined()
    expect(data.employerCost).toBeNull()

    // The employer's own view of the same run keeps every step.
    const employerView = buildPayslipData({
      run,
      sre: sre({ calculation_breakdown: { steps }, avgifter_amount_override: 10000, override_reason: 'justering' }),
      employee,
      company,
      audience: EMPLOYER,
    })
    expect(employerView.breakdownSteps?.map(s => s.label)).toContain('Total arbetsgivarkostnad')
    expect(employerView.breakdownSteps?.map(s => s.label)).toContain('Manuell justering: Arbetsgivaravgifter')
  })

  it('requires the employer cost for the breakdown: sections follow both switches together', () => {
    const sectionsFor = (employerCost: boolean, breakdown: boolean) =>
      payslipSectionsFor({
        kind: 'employee',
        settings: { salary_payslip_show_employer_cost: employerCost, salary_payslip_show_breakdown: breakdown },
      })
    expect(sectionsFor(true, true)).toEqual({ employerCost: true, breakdown: true })
    expect(sectionsFor(true, false)).toEqual({ employerCost: true, breakdown: false })
    expect(sectionsFor(false, true)).toEqual({ employerCost: false, breakdown: false })
    expect(sectionsFor(false, false)).toEqual({ employerCost: false, breakdown: false })
  })

  it('omits Beräkningsunderlag (engine and override steps) from the employee copy when its switch is off', () => {
    const data = build({
      kind: 'employee',
      settings: { salary_payslip_show_employer_cost: true, salary_payslip_show_breakdown: false },
    })
    expect(data.breakdownSteps).toBeUndefined()
    expect(data.employerCost?.totalEmployerCost).toBe(35000 + 10997 + 4200 + 1319.74)
  })

  it('never changes the pay itself: gross, tax and net are the same on every copy', () => {
    const employer = build(EMPLOYER)
    const employee = build({
      kind: 'employee',
      settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false },
    })
    expect(employee.grossSalary).toBe(employer.grossSalary)
    expect(employee.taxWithheld).toBe(employer.taxWithheld)
    expect(employee.netSalary).toBe(employer.netSalary)
    expect(employee.lineItems).toEqual(employer.lineItems)
  })

  it('prints both sections on the employee copy of a company without a settings row or with null columns', () => {
    expect(payslipSectionsFor({ kind: 'employee', settings: null })).toEqual({ employerCost: true, breakdown: true })
    expect(
      payslipSectionsFor({
        kind: 'employee',
        settings: { salary_payslip_show_employer_cost: null, salary_payslip_show_breakdown: null },
      }),
    ).toEqual({ employerCost: true, breakdown: true })
  })
})

describe('buildPayslipData: sections fixed when the run was issued (BFL 7 kap. 1 §)', () => {
  const company = { name: 'Bolaget AB', org_number: '5560000000' }
  const HIDDEN_NOW: PayslipAudience = {
    kind: 'employee',
    settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false },
  }
  const SHOWN_NOW: PayslipAudience = {
    kind: 'employee',
    settings: { salary_payslip_show_employer_cost: true, salary_payslip_show_breakdown: true },
  }
  const issuedShown = {
    ...run,
    payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
    payslip_show_employer_cost: true,
    payslip_show_breakdown: true,
  }
  const issuedHidden = {
    ...run,
    payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
    payslip_show_employer_cost: false,
    payslip_show_breakdown: false,
  }

  it('keeps both sections on a run sent with them shown after the company hides them', () => {
    const data = buildPayslipData({ run: issuedShown, sre: sre(), employee, company, audience: HIDDEN_NOW })
    expect(data.employerCost).not.toBeNull()
    expect(data.breakdownSteps?.map(s => s.label)).toEqual(['Bruttolön'])
  })

  it('keeps both sections hidden on a run sent with them hidden after the company shows them again', () => {
    const data = buildPayslipData({ run: issuedHidden, sre: sre(), employee, company, audience: SHOWN_NOW })
    expect(data.employerCost).toBeNull()
    expect(data.breakdownSteps).toBeUndefined()
  })

  it('follows the live switches on a run not yet sent', () => {
    const notSent = {
      ...run,
      payslip_sections_issued_at: null,
      payslip_show_employer_cost: null,
      payslip_show_breakdown: null,
    }
    const hidden = buildPayslipData({ run: notSent, sre: sre(), employee, company, audience: HIDDEN_NOW })
    expect(hidden.employerCost).toBeNull()
    expect(hidden.breakdownSteps).toBeUndefined()
    const shown = buildPayslipData({ run: notSent, sre: sre(), employee, company, audience: SHOWN_NOW })
    expect(shown.employerCost).not.toBeNull()
    expect(shown.breakdownSteps).toHaveLength(1)
  })

  it('prints everything on the employer view of an issued run, whatever it was issued with', () => {
    const data = buildPayslipData({ run: issuedHidden, sre: sre(), employee, company, audience: EMPLOYER })
    expect(data.employerCost).not.toBeNull()
    expect(data.breakdownSteps).toHaveLength(1)
  })

  it('reads a snapshot only once it carries an issue time, and never shows the breakdown without the employer cost', () => {
    expect(issuedPayslipSections(null)).toBeNull()
    expect(issuedPayslipSections({ payslip_sections_issued_at: null, payslip_show_employer_cost: false })).toBeNull()
    expect(
      issuedPayslipSections({
        payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
        payslip_show_employer_cost: false,
        payslip_show_breakdown: true,
      }),
    ).toEqual({ employerCost: false, breakdown: false })
    expect(payslipSectionsFor(HIDDEN_NOW, issuedShown)).toEqual({ employerCost: true, breakdown: true })
  })
})

describe('parsePayslipAudienceParam', () => {
  it('reads an absent or employer value as the employer view', () => {
    expect(parsePayslipAudienceParam(null)).toBe('employer')
    expect(parsePayslipAudienceParam('')).toBe('employer')
    expect(parsePayslipAudienceParam('employer')).toBe('employer')
  })

  it('reads employee as the employee copy and refuses anything else', () => {
    expect(parsePayslipAudienceParam('employee')).toBe('employee')
    expect(parsePayslipAudienceParam('Employee')).toBeNull()
    expect(parsePayslipAudienceParam('auditor')).toBeNull()
  })
})
