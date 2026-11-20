import { describe, expect, it } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { SemesterskuldPDF } from '@/lib/reports/semesterskuld-pdf-template'
import type { VacationLiabilityReport } from '@/lib/reports/vacation-liability'

const report: VacationLiabilityReport = {
  rows: [
    {
      employeeId: 'emp-1',
      employeeName: 'Åsa Öberg',
      personnummerLast4: '0000',
      vacationRule: 'procentregeln',
      vacationDaysEntitled: 25,
      vacationDaysTaken: 5.5,
      vacationDaysRemaining: 19.5,
      vacationDaysOffRemaining: null,
      vacationDaysSaved: 3,
      accruedAmount: 14200,
      accruedAvgifter: 4461.64,
      avgifterRate: 0.3142,
      advanceVacationDebt: 1500,
      totalLiability: 18661.64,
      netLiability: 17161.64,
      liabilityChangeAccount: '7290' as const,
      computedLiability: 16350,
      computedAvgifter: 5137.17,
      liabilityDays: 22.5,
      dayValue: 726.67,
      dayValueEstimated: false,
      variablePay: 0,
      earningPay: 0,
    },
  ],
  totals: {
    accruedAmount: 14200,
    accruedAvgifter: 4461.64,
    advanceVacationDebt: 1500,
    totalLiability: 18661.64,
    netLiability: 17161.64,
    computedLiability: 16350,
    computedAvgifter: 5137.17,
    computedTotal: 21487.17,
  },
  asOfDate: '2026-12-31',
  vacationYearStart: '2026-01-01',
  closedYear: { start: '2025-01-01', end: '2025-12-31' },
  remeasuredAt: null,
}

describe('SemesterskuldPDF', () => {
  it('renders with rows, the booked check and the förskottsskuld note', async () => {
    const pdf = await renderToBuffer(
      SemesterskuldPDF({
        report,
        check: {
          booked2920: 14200,
          booked2940: 4000,
          difference2920: 0,
          difference2940: -461.64,
          computedDifference2920: 2150,
          computedDifference2940: 1137.17,
          computedDifferenceTotal: 3287.17,
        },
        company: { name: 'Testbolaget AB', org_number: '5560000001' },
      }),
    )
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('renders an empty report without a check', async () => {
    const pdf = await renderToBuffer(
      SemesterskuldPDF({
        report: { ...report, rows: [], closedYear: null },
        check: null,
        company: { name: '', org_number: null },
      }),
    )
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })
})
