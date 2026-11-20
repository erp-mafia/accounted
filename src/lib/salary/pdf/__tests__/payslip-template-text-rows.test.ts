import { describe, it, expect, vi } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF, type PayslipData } from '../payslip-template'
import { pdfTextStrings } from '@/tests/pdf-text'

vi.mock('@/lib/salary/personnummer', () => ({
  decryptPersonnummer: vi.fn((v: string) => v),
  maskPersonnummer: vi.fn(() => '19900101-****'),
}))

import { buildPayslipData } from '@/lib/salary/payslips/build-payslip-data'

// A text row (item_type 'text', lib/salary/text-rows.ts) prints its words
// across the row and no amount: a 0 kr row used to print "0,00" (crm#1076).
//
// Every money figure below has non-zero öre, so the string "0,00" can only
// come from a row printed with a zero amount: asserting its absence on the
// whole page is exact, not a heuristic.

function payslip(over: Partial<PayslipData> = {}): PayslipData {
  return {
    companyName: 'Testbolaget AB',
    companyOrgNumber: '556677-8899',
    employeeName: 'Anna Andersson',
    personnummerMasked: '19850101-XXXX',
    employmentType: 'Anställd',
    periodYear: 2026,
    periodMonth: 9,
    paymentDate: '2026-09-25',
    lineItems: [
      { description: 'Grundlön', quantity: 1, unitPrice: 35000.5, amount: 35000.5 },
      { description: 'Lön enligt kollektivavtal', amount: 0, text: true },
      { description: 'Bonus Q3', amount: 5000.25 },
    ],
    grossSalary: 40000.75,
    taxWithheld: 9123.45,
    netSalary: 30877.3,
    taxReference: 'Tabell 33, kol 1',
    employerCost: {
      avgifterRate: 0.3142,
      avgifterAmount: 12568.24,
      vacationAccrual: 4800.09,
      vacationAccrualAvgifter: 1508.19,
      totalEmployerCost: 58877.27,
    },
    ytdGross: 360007.75,
    ytdTax: 82111.05,
    ytdNet: 277896.7,
    breakdownSteps: [{ label: 'Bruttolön', formula: 'grundlön + bonus', output: 40000.75 }],
    ...over,
  }
}

const RENDER_TIMEOUT = 30_000

async function text(data: PayslipData): Promise<string> {
  return pdfTextStrings(await renderToBuffer(PayslipPDF({ data }))).join('\n')
}

describe('PayslipPDF text rows', () => {
  it("prints a text row's words and no amount for it", async () => {
    const out = await text(payslip())

    expect(out).toContain('Lön enligt kollektivavtal')
    expect(out).not.toContain('0,00')
    // The money rows around it still print their amounts.
    expect(out).toContain('35 000,50')
    expect(out).toContain('5 000,25')
  }, RENDER_TIMEOUT)

  it('the same row without the text flag would print 0,00 (the assertion above is not vacuous)', async () => {
    const out = await text(
      payslip({
        lineItems: [
          { description: 'Grundlön', quantity: 1, unitPrice: 35000.5, amount: 35000.5 },
          { description: 'Lön enligt kollektivavtal', amount: 0 },
        ],
      }),
    )
    expect(out).toContain('0,00')
  }, RENDER_TIMEOUT)

  it('prints a text row with a Unicode minus in its words with an ASCII minus the font can draw', async () => {
    const UNICODE_MINUS = String.fromCharCode(0x2212)
    const out = await text(
      payslip({ lineItems: [{ description: `Grundlön ${UNICODE_MINUS} avdrag enligt avtal`, amount: 0, text: true }] }),
    )
    expect(out).toContain('Grundlön - avdrag enligt avtal')
    expect(out).not.toContain(UNICODE_MINUS)
    expect(out).not.toContain(String.fromCharCode(0x12))
  }, RENDER_TIMEOUT)

  it('renders stored rows end to end: words in payslip order, no amount on the text rows', async () => {
    const data = buildPayslipData({
      run: { period_year: 2026, period_month: 9, payment_date: '2026-09-25' },
      sre: {
        gross_salary: 40000.75,
        tax_withheld: 9123.45,
        tax_withheld_override: null,
        avgifter_rate: 0.3142,
        avgifter_amount: 12568.24,
        avgifter_amount_override: null,
        avgifter_basis_override: null,
        override_reason: null,
        net_salary: 30877.3,
        vacation_accrual: 4800.09,
        vacation_accrual_avgifter: 1508.19,
        ytd_gross: 360007.75,
        ytd_tax: 82111.05,
        ytd_net: 277896.7,
        calculation_breakdown: { steps: [{ label: 'Bruttolön', formula: 'grundlön + bonus', output: 40000.75 }] },
        line_items: [
          { item_type: 'bonus', description: 'Bonus Q3', amount: 5000.25, sort_order: 20 },
          { item_type: 'text', description: 'Manuell textrad', amount: 0, sort_order: 5 },
          { item_type: 'monthly_salary', description: 'Grundlön', amount: 35000.5, quantity: 1, unit_price: 35000.5, sort_order: 0 },
          { item_type: 'text', description: 'Återkommande textrad', amount: 0, sort_order: 10, source_recurring_line_id: 'rec-1' },
        ],
      },
      employee: {
        first_name: 'Anna',
        last_name: 'Exempelsson',
        personnummer: 'enc',
        employment_type: 'employee',
        tax_table_number: 33,
        tax_column: 1,
        clearing_number: null,
        bank_account_number: null,
      },
      company: { name: 'Bolaget AB', org_number: '5560000000' },
      audience: { kind: 'employer' },
    })

    const out = await text(data)

    expect(out).not.toContain('0,00')
    const order = ['Grundlön', 'Återkommande textrad', 'Manuell textrad', 'Bonus Q3'].map((words) => out.indexOf(words))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  }, RENDER_TIMEOUT)
})
