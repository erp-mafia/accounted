import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { SalaryRunUnderlagPDF } from '../run-underlag-template'
import type { SalaryRunUnderlagData } from '@/lib/salary/run-underlag'
import { pdfTextStrings } from '@/tests/pdf-text'

const UNICODE_MINUS = String.fromCharCode(0x2212)

// Real @react-pdf/renderer layout is CPU-heavy; under a fully parallel test
// run it can exceed the 5s default on a saturated machine.
const RENDER_TIMEOUT = 30_000

function underlag(over: Partial<SalaryRunUnderlagData> = {}): SalaryRunUnderlagData {
  return {
    companyName: 'Testbolaget AB',
    companyOrgNumber: '556677-8899',
    periodYear: 2026,
    periodMonth: 8,
    paymentDate: '2026-08-25',
    isCorrection: false,
    corrected: false,
    generatedAt: '2026-09-01T10:00:00.000Z',
    rows: [
      {
        employeeId: 'emp-1',
        employeeName: 'Anna Ek',
        personnummerLast4: '1234',
        employmentType: 'employee',
        periodYear: 2026,
        periodMonth: 8,
        paymentDate: '2026-08-25',
        grossSalary: 33765.44,
        taxWithheld: 7654.32,
        netSalary: 26111.12,
        avgifterAmount: 10609.1,
        avgifterRate: 0.3142,
        vacationAccrual: -1234.56,
        vacationAccrualAvgifter: 0,
        totalEmployerCost: 43139.98,
        sickDays: 0,
        vabDays: 0,
        parentalDays: 0,
        vacationDaysTaken: 0,
        salaryRunStatus: 'booked',
      },
    ],
    totals: {
      grossSalary: 33765.44,
      taxWithheld: 7654.32,
      netSalary: 26111.12,
      avgifterAmount: 10609.1,
      vacationAccrual: -1234.56,
      vacationAccrualAvgifter: 0,
      totalEmployerCost: 43139.98,
    },
    entries: [
      {
        description: 'Lön augusti 2026',
        voucher: 'L-8',
        lines: [
          { account_number: '7210', account_name: 'Löner till tjänstemän', line_description: 'Bruttolön', debit_amount: 33765.44, credit_amount: 0 },
          { account_number: '2710', account_name: 'Personalskatt', line_description: 'Skatt', debit_amount: 0, credit_amount: 7654.32 },
          { account_number: '1930', account_name: null, line_description: 'Nettolön', debit_amount: 0, credit_amount: 26111.12 },
        ],
        totalDebit: 33765.44,
        totalCredit: 33765.44,
      },
    ],
    ...over,
  }
}

describe('SalaryRunUnderlagPDF', () => {
  it('prints the employees, totals, voucher and kontering, negatives with an ASCII minus', async () => {
    const text = pdfTextStrings(await renderToBuffer(SalaryRunUnderlagPDF({ data: underlag() }))).join('\n')

    expect(text).toContain('Lönesammanställning')
    expect(text).toContain('Anna Ek')
    expect(text).toContain('Verifikationer: L-8')
    expect(text).toContain('Personalskatt')
    expect(text).toContain('33 765,44')
    expect(text).toContain('-1 234,56')
    expect(text).not.toContain(UNICODE_MINUS)
  }, RENDER_TIMEOUT)

  it('says so when the run is a rättelsekörning or was later corrected', async () => {
    const correction = pdfTextStrings(
      await renderToBuffer(SalaryRunUnderlagPDF({ data: underlag({ isCorrection: true }) })),
    ).join('\n')
    expect(correction).toContain('rättelsekörning')

    const corrected = pdfTextStrings(
      await renderToBuffer(SalaryRunUnderlagPDF({ data: underlag({ corrected: true, entries: [] }) })),
    ).join('\n')
    expect(corrected).toContain('korrigerats')
    expect(corrected).toContain('Nollkörning')
  }, RENDER_TIMEOUT)
})
