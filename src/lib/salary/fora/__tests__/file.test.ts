/**
 * Fora's monthly file (lib/salary/fora/file.ts), checked against the shapes
 * in Fora's file specification v1.37 (section 4) and the scenarios of its
 * appendix v2.0. Personnummer and org numbers are Fora's own examples.
 */
import { describe, it, expect } from 'vitest'
import { buildForaFile, isSamordningsnummer, type ForaEmployeeInput } from '../file'

function employee(overrides: Partial<ForaEmployeeInput> = {}): ForaEmployeeInput {
  return {
    id: 'emp-1',
    personnummer: '195408012230',
    firstName: 'Kalle',
    lastName: 'Hall',
    addressLine1: null,
    postalCode: null,
    city: null,
    fokId: 'FOK306834',
    fokStartDate: '2024-01-01',
    employmentStart: '2020-03-01',
    employmentEnd: null,
    pay: 30000,
    ...overrides,
  }
}

const ORG = '556560-1712'

function build(employees: ForaEmployeeInput[], month = 5) {
  return buildForaFile({ orgNumber: ORG, year: 2024, month, employees })
}

describe('buildForaFile', () => {
  it('reports pay and the current code for every coded worker (appendix 3.1)', () => {
    const result = build([
      employee(),
      employee({ id: 'emp-2', personnummer: '199812172386', firstName: 'Fia', lastName: 'Andersson', pay: 55000 }),
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file).toEqual({
      source: 'Accounted',
      reports: [
        {
          refId: '202405',
          organizationNumber: '5565601712',
          employments: [
            {
              employeeId: '199812172386',
              firstName: 'Fia',
              lastName: 'Andersson',
              employmentEndDate: null,
              markups: [{ fokId: 'FOK306834', startDate: '20240101' }],
            },
            {
              employeeId: '195408012230',
              firstName: 'Kalle',
              lastName: 'Hall',
              employmentEndDate: null,
              markups: [{ fokId: 'FOK306834', startDate: '20240101' }],
            },
          ],
          payrolls: [
            { employeeId: '199812172386', firstName: 'Fia', lastName: 'Andersson', payMonth: '202405', payAmount: 55000 },
            { employeeId: '195408012230', firstName: 'Kalle', lastName: 'Hall', payMonth: '202405', payAmount: 30000 },
          ],
        },
      ],
    })
    expect(result.warnings).toEqual([])
    expect(result.payrolls.map((p) => [p.employee_name, p.pay_amount])).toEqual([
      ['Fia Andersson', 55000],
      ['Kalle Hall', 30000],
    ])
  })

  it('sends whole kronor, rounding to the nearest krona', () => {
    const result = build([employee({ pay: 31249.5 }), employee({ id: 'emp-2', personnummer: '199812172386', pay: 31249.49 })])
    if (!result.ok) throw new Error('expected a file')
    expect(result.file.reports[0].payrolls.map((p) => p.payAmount).sort()).toEqual([31249, 31250])
  })

  it('carries the end date with the final pay, also when it is paid after the last day (appendix 1.1, 3.7)', () => {
    const result = build([employee({ employmentEnd: '2024-04-30', pay: 25000 })])
    if (!result.ok) throw new Error('expected a file')
    const [report] = result.file.reports
    expect(report.employments[0].employmentEndDate).toBe('20240430')
    expect(report.employments[0].markups).toEqual([{ fokId: 'FOK306834', startDate: '20240101' }])
    expect(report.payrolls[0]).toMatchObject({ payMonth: '202405', payAmount: 25000 })
  })

  it('reports 0 for a coded worker employed in the month with no payout', () => {
    const result = build([employee({ pay: null })])
    if (!result.ok) throw new Error('expected a file')
    expect(result.file.reports[0].payrolls[0].payAmount).toBe(0)
  })

  it('leaves out a worker who was neither employed nor paid in the month', () => {
    const result = build([employee(), employee({ id: 'gone', personnummer: '199812172386', employmentEnd: '2024-03-31', pay: null })])
    if (!result.ok) throw new Error('expected a file')
    expect(result.file.reports[0].payrolls.map((p) => p.employeeId)).toEqual(['195408012230'])
    expect(result.file.reports[0].employments).toHaveLength(1)
  })

  it('leaves out pay before the code applies, and says so', () => {
    const result = build([employee(), employee({ id: 'new', personnummer: '199812172386', firstName: 'Ny', fokStartDate: '2024-06-01' })])
    if (!result.ok) throw new Error('expected a file')
    expect(result.file.reports[0].payrolls).toHaveLength(1)
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'FORA_PAID_BEFORE_CODE_START', employee_id: 'new', fok_start_date: '2024-06-01' }),
    ])
  })

  it('counts a code starting mid-month as active for that month', () => {
    const result = build([employee({ fokStartDate: '2024-05-15' })])
    if (!result.ok) throw new Error('expected a file')
    expect(result.file.reports[0].employments[0].markups[0].startDate).toBe('20240515')
  })

  it('sends 0 for a negative month and warns', () => {
    const result = build([employee({ pay: -1200 })])
    if (!result.ok) throw new Error('expected a file')
    expect(result.file.reports[0].payrolls[0].payAmount).toBe(0)
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'FORA_NEGATIVE_PAY', pay_amount: -1200 })])
  })

  it('adds the address for a samordningsnummer, and only then (spec 4.1, footnote 3)', () => {
    const result = build([
      employee({ addressLine1: 'Storgatan 1', postalCode: '111 34', city: 'Stockholm' }),
      employee({
        id: 'samord',
        personnummer: '197801862397',
        firstName: 'Nyanställd',
        lastName: 'Samordningsnummer',
        addressLine1: 'Sveavägen 44',
        postalCode: '111 34',
        city: 'Stockholm',
      }),
    ])
    if (!result.ok) throw new Error('expected a file')
    const byId = new Map(result.file.reports[0].employments.map((e) => [e.employeeId, e]))
    expect(byId.get('195408012230')?.address).toBeUndefined()
    expect(byId.get('197801862397')?.address).toEqual({
      streetAddress: 'Sveavägen 44',
      postalCode: '11134',
      city: 'Stockholm',
      countryCode: 'SE',
    })
  })

  it('refuses a samordningsnummer without a complete address', () => {
    const result = build([employee({ id: 'samord', personnummer: '197801862397', addressLine1: 'Sveavägen 44', postalCode: null, city: 'Stockholm' })])
    expect(result).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: 'FORA_ADDRESS_REQUIRED', employee_id: 'samord' })],
    })
  })

  it('refuses without an organisation number', () => {
    const result = buildForaFile({ orgNumber: '', year: 2024, month: 5, employees: [employee()] })
    expect(result).toEqual({ ok: false, issues: [expect.objectContaining({ code: 'FORA_ORG_NUMBER_MISSING' })] })
  })

  it('says when nobody has a code, and when nobody with one is in the month', () => {
    expect(build([])).toEqual({ ok: false, issues: [expect.objectContaining({ code: 'FORA_NO_CODED_EMPLOYEES' })] })
    expect(build([employee({ employmentEnd: '2023-12-31', pay: null })])).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: 'FORA_NOTHING_IN_MONTH' })],
    })
  })

  it('clips names to Fora\'s 40 characters', () => {
    const result = build([employee({ firstName: 'A'.repeat(45) })])
    if (!result.ok) throw new Error('expected a file')
    expect(result.file.reports[0].payrolls[0].firstName).toHaveLength(40)
    expect(result.file.reports[0].employments[0].firstName).toHaveLength(40)
  })
})

describe('isSamordningsnummer', () => {
  it('reads the day plus 60', () => {
    expect(isSamordningsnummer('197801862397')).toBe(true)
    expect(isSamordningsnummer('195408012230')).toBe(false)
  })
})
