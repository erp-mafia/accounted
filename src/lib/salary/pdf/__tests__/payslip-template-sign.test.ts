import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF, type PayslipData } from '../payslip-template'
import { pdfTextStrings } from '@/tests/pdf-text'

const UNICODE_MINUS = String.fromCharCode(0x2212)

function payslip(over: Partial<PayslipData> = {}): PayslipData {
  return {
    companyName: 'Testbolaget AB',
    companyOrgNumber: '556677-8899',
    employeeName: 'Anna Andersson',
    personnummerMasked: '19850101-XXXX',
    employmentType: 'tillsvidare',
    periodYear: 2026,
    periodMonth: 8,
    paymentDate: '2026-08-25',
    lineItems: [
      { description: 'Månadslön', quantity: 1, unitPrice: 35000, amount: 35000 },
      { description: 'Sjukfrånvaro', quantity: 1, unitPrice: -1234.56, amount: -1234.56 },
    ],
    grossSalary: 33765.44,
    taxWithheld: 7654.32,
    netSalary: 26111.12,
    taxReference: 'Tabell 33, kolumn 1',
    avgifterRate: 0.3142,
    avgifterAmount: 10609.1,
    vacationAccrual: 4051.85,
    vacationAccrualAvgifter: 1273.09,
    totalEmployerCost: 49699.48,
    ytdGross: 270123.52,
    ytdTax: 61234.56,
    ytdNet: 208888.96,
    ...over,
  }
}

// Real @react-pdf/renderer layout is CPU-heavy; under a fully parallel test
// run these can exceed the 5s default on a saturated machine.
const RENDER_TIMEOUT = 30_000

describe('PayslipPDF sign rendering (issue #1982)', () => {
  it('prints the tax deduction and a negative line with an ASCII minus the bundled font can draw', async () => {
    const text = pdfTextStrings(await renderToBuffer(PayslipPDF({ data: payslip() }))).join('\n')

    // The Preliminär skatt row used to prefix a literal U+2212 outside fmt(),
    // which Helvetica has no glyph for: the content stream carried an unmapped
    // 0x12 byte and the viewer drew "7 654,32" with no sign.
    expect(text).toContain('-7 654,32')
    // A negative line item (absence, deduction) goes through fmt().
    expect(text).toContain('-1 234,56')
    expect(text).not.toContain(String.fromCharCode(0x12))
    expect(text).not.toContain(UNICODE_MINUS)
  }, RENDER_TIMEOUT)

  it('prints the calculation-engine formula strings with an ASCII minus', async () => {
    // The engine builds these with U+2212 (they are shown on screen too, where
    // the glyph exists); the PDF must map them at the render site.
    const text = pdfTextStrings(
      await renderToBuffer(
        PayslipPDF({
          data: payslip({
            breakdownSteps: [
              {
                label: 'Bruttolön',
                formula: `grundlön + tillägg + frånvaro ${UNICODE_MINUS} bruttoavdrag`,
                output: 33765.44,
              },
              {
                label: 'Nettolön',
                formula: `bruttolön ${UNICODE_MINUS} skatt ${UNICODE_MINUS} nettoavdrag`,
                output: 26111.12,
              },
              {
                label: 'Sjukavdrag',
                formula: `${UNICODE_MINUS}(full lön ${UNICODE_MINUS} sjuklön + karensavdrag)`,
                output: -1234.56,
              },
            ],
          }),
        })
      )
    ).join('\n')

    expect(text).toContain('grundlön + tillägg + frånvaro - bruttoavdrag')
    expect(text).toContain('bruttolön - skatt - nettoavdrag')
    expect(text).toContain('-(full lön - sjuklön + karensavdrag)')
    expect(text).not.toContain(String.fromCharCode(0x12))
    expect(text).not.toContain(UNICODE_MINUS)
  }, RENDER_TIMEOUT)
})
