import { describe, expect, it } from 'vitest'
import type { PosDay } from '@accounted/connect-contract'
import { formatReportAmount, posDayReportFilename, renderPosDayReport } from '../day-report-pdf'

const DAY: PosDay = {
  businessDate: '2026-09-30',
  currency: 'SEK',
  sales: { net: 261.29, vat: 45.71, gross: 307 },
  vatGroups: [
    { ratePercent: 25, net: 110.4, vat: 27.6, gross: 138 },
    { ratePercent: 12, net: 150.89, vat: 18.11, gross: 169 },
  ],
  tenders: [
    { kind: 'card', method: 'card', amount: 189, tips: 20, receiptCount: 1 },
    { kind: 'swish', method: 'swish', amount: 138, tips: 0, receiptCount: 1 },
  ],
  tips: 20,
  discounts: 0,
  refunds: { count: 1, gross: -50 },
  receiptCount: 3,
  firstReceiptNumber: '108764998',
  lastReceiptNumber: '108765000',
  firstPaidAt: '2026-09-30T11:57:00.789329',
  lastPaidAt: '2026-09-30T22:41:07.411247',
  categories: [{ name: 'drink', quantity: 2, gross: 138, vat: 27.6 }],
  receipts: [
    { number: '108764998', kind: 'sale', paidAt: '2026-09-30T11:57:00.789329', method: 'swish', gross: 138, tips: 0 },
    { number: '108764999', kind: 'sale', paidAt: '2026-09-30T12:02:00', method: 'card', gross: 169, tips: 20 },
    { number: '108765000', kind: 'refund', paidAt: '2026-09-30T22:41:07.411247', method: 'card', gross: -50, tips: 0 },
  ],
  issues: [{ code: 'tips_counted_once', message: 'Kvitto 108764999: samma dricks stod på varje rad och räknades en gång' }],
}

describe('the day report PDF', () => {
  it('renders a PDF from a day, with or without the voucher lines', async () => {
    const withLines = await renderPosDayReport({
      day: DAY,
      venueName: 'Restaurang Exempel',
      providerName: 'Kassa AB',
      companyName: 'Exempel AB',
      orgNumber: '556677-8899',
      fetchedAt: '2026-10-01T04:15:00.000Z',
      rawSha256: 'a'.repeat(64),
      lines: [
        { account_number: '1686', debit_amount: 327, credit_amount: 0, line_description: 'Kortbetalningar' },
        { account_number: '3002', debit_amount: 0, credit_amount: 307, line_description: 'Försäljning' },
        { account_number: '2820', debit_amount: 0, credit_amount: 20, line_description: 'Dricks' },
      ],
      voucherLabel: 'F12',
      generatedAt: '2026-10-01',
    })
    expect(withLines.subarray(0, 5).toString()).toBe('%PDF-')
    const bare = await renderPosDayReport({
      day: { ...DAY, receipts: [], categories: [], issues: [] },
      venueName: 'Restaurang Exempel',
      providerName: 'Kassa AB',
      companyName: null,
      orgNumber: null,
      fetchedAt: '2026-10-01T04:15:00.000Z',
      rawSha256: 'b'.repeat(64),
      lines: null,
      voucherLabel: null,
      generatedAt: '2026-10-01',
    })
    expect(bare.subarray(0, 5).toString()).toBe('%PDF-')
  }, 30_000)

  it('prints a refund with an ASCII minus the standard font can draw', () => {
    expect(formatReportAmount(-50)).toBe('-50,00')
    expect(formatReportAmount(1234.5)).toMatch(/^1\s234,50$/)
  })

  it('names the file after the venue and the day', () => {
    expect(posDayReportFilename({ businessDate: '2026-09-30' }, 'Café Exempel')).toBe('Dagsrapport_kassa_Café_Exempel_2026-09-30.pdf')
    expect(posDayReportFilename({ businessDate: '2026-09-30' }, '***')).toBe('Dagsrapport_kassa_kassa_2026-09-30.pdf')
  })
})
