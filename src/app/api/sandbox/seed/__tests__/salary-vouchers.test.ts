import { describe, it, expect } from 'vitest'
import { buildSandboxSalaryVouchers } from '../salary-vouchers'

const BASE = {
  userId: 'user-1',
  companyId: 'company-1',
  fiscalPeriodId: 'fp-1',
  salaryRunId: 'run-1',
  paymentDate: '2026-07-25',
  periodYear: 2026,
  periodMonth: 7,
}

/** Numbers shaped like the seeded run: gross = tax + net, avgifter 31.42%,
 *  vacation accrual 12% of gross with avgifter on top. */
const TOTALS = {
  totalGross: 57600,
  totalTax: 16416,
  totalNet: 41184,
  totalAvgifter: 18097.92,
  totalVacationAccrual: 6912,
  totalVacationAvgifter: 2171.75,
}

const sum = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100

describe('buildSandboxSalaryVouchers', () => {
  it('produces the three engine-equivalent vouchers', () => {
    const vouchers = buildSandboxSalaryVouchers({ ...BASE, ...TOTALS })
    expect(vouchers.map((v) => v.runColumn)).toEqual([
      'salary_entry_id',
      'avgifter_entry_id',
      'vacation_entry_id',
    ])
  })

  it('balances every voucher with a non-zero total', () => {
    for (const { entry, lines } of buildSandboxSalaryVouchers({ ...BASE, ...TOTALS })) {
      const debit = sum(lines.map((l) => l.debit_amount))
      const credit = sum(lines.map((l) => l.credit_amount))
      expect(debit, `${entry.description} debit vs credit`).toBe(credit)
      expect(debit).toBeGreaterThan(0)
    }
  })

  it('books salary on 7210 against 2710 personalskatt and 1930 bank', () => {
    const [salary] = buildSandboxSalaryVouchers({ ...BASE, ...TOTALS })
    expect(salary.lines).toEqual([
      expect.objectContaining({ account_number: '7210', debit_amount: 57600, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2710', debit_amount: 0, credit_amount: 16416 }),
      expect.objectContaining({ account_number: '1930', debit_amount: 0, credit_amount: 41184 }),
    ])
  })

  it('books arbetsgivaravgifter on 7510 against 2731', () => {
    const [, avgifter] = buildSandboxSalaryVouchers({ ...BASE, ...TOTALS })
    expect(avgifter.lines.map((l) => l.account_number)).toEqual(['7510', '2731'])
  })

  it('books the vacation accrual on 7290/2920 and its avgifter on 7519/2940', () => {
    const [, , vacation] = buildSandboxSalaryVouchers({ ...BASE, ...TOTALS })
    expect(vacation.lines.map((l) => l.account_number)).toEqual(['7290', '2920', '7519', '2940'])
    expect(vacation.lines.map((l) => l.sort_order)).toEqual([0, 1, 2, 3])
  })

  it('omits the vacation voucher when nothing accrued (the engine posts no zero voucher)', () => {
    const vouchers = buildSandboxSalaryVouchers({
      ...BASE,
      ...TOTALS,
      totalVacationAccrual: 0,
      totalVacationAvgifter: 0,
    })
    expect(vouchers).toHaveLength(2)
    expect(vouchers.some((v) => v.runColumn === 'vacation_entry_id')).toBe(false)
  })

  it('sets every line dimensions bag explicitly (PostgREST bulk-insert normalization)', () => {
    for (const { lines } of buildSandboxSalaryVouchers({ ...BASE, ...TOTALS })) {
      for (const line of lines) {
        expect(line.dimensions).toEqual({})
      }
    }
  })

  it('links salary_payment to the run and leaves posting metadata to the engine', () => {
    for (const { entry } of buildSandboxSalaryVouchers({ ...BASE, ...TOTALS })) {
      expect(entry.source_type).toBe('salary_payment')
      expect(entry.source_id).toBe('run-1')
      expect(entry).not.toHaveProperty('status')
      expect(entry.entry_date).toBe('2026-07-25')
      expect(entry).not.toHaveProperty('committed_at')
      expect(entry).not.toHaveProperty('commit_method')
      expect(entry.voucher_series).toMatch(/^[A-Z]$/)
      expect(entry.description).toContain('2026-07')
    }
  })

  it('account numbers are strings, never numbers', () => {
    for (const { lines } of buildSandboxSalaryVouchers({ ...BASE, ...TOTALS })) {
      for (const line of lines) {
        expect(typeof line.account_number).toBe('string')
      }
    }
  })

  it('throws rather than writing an unbalanced verifikat', () => {
    expect(() =>
      buildSandboxSalaryVouchers({ ...BASE, ...TOTALS, totalNet: 41000 }),
    ).toThrow(/would not balance/)
  })

  it('rounds to ore instead of accumulating float drift', () => {
    const [salary] = buildSandboxSalaryVouchers({
      ...BASE,
      ...TOTALS,
      totalGross: 0.1 + 0.2,
      totalTax: 0.1,
      totalNet: 0.2,
    })
    expect(salary.lines[0].debit_amount).toBe(0.3)
  })
})
