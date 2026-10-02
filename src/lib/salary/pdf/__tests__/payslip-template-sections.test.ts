import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { PayslipPDF, type PayslipData } from '../payslip-template'
import { pdfTextStrings } from '@/tests/pdf-text'

// The template prints what the data holds: which optional sections a copy
// carries is decided by its audience in build-payslip-data (crm#202).

function payslip(over: Partial<PayslipData> = {}): PayslipData {
  return {
    companyName: 'Testbolaget AB',
    companyOrgNumber: '556677-8899',
    employeeName: 'Anna Andersson',
    personnummerMasked: '19850101-XXXX',
    employmentType: 'Anställd',
    periodYear: 2026,
    periodMonth: 8,
    paymentDate: '2026-08-25',
    lineItems: [{ description: 'Grundlon', quantity: 1, unitPrice: 35000, amount: 35000 }],
    grossSalary: 35000,
    taxWithheld: 8000,
    netSalary: 27000,
    taxReference: 'Tabell 33, kol 1',
    employerCost: {
      avgifterRate: 0.3142,
      avgifterAmount: 10997,
      vacationAccrual: 4200,
      vacationAccrualAvgifter: 1319.74,
      totalEmployerCost: 51516.74,
    },
    ytdGross: 210000,
    ytdTax: 48000,
    ytdNet: 162000,
    breakdownSteps: [{ label: 'Steg ett', formula: 'grundlon', output: 35000 }],
    ...over,
  }
}

const RENDER_TIMEOUT = 30_000

async function text(data: PayslipData): Promise<string> {
  return pdfTextStrings(await renderToBuffer(PayslipPDF({ data }))).join('\n')
}

describe('PayslipPDF optional sections', () => {
  it('prints the employer cost and the calculation steps when the data carries them', async () => {
    const out = await text(payslip())
    expect(out).toContain('Arbetsgivarkostnad')
    expect(out).toContain('51 516,74')
    expect(out).toContain('Steg ett')
  }, RENDER_TIMEOUT)

  it('leaves both sections out when the data omits them, and still prints the pay', async () => {
    const out = await text(payslip({ employerCost: null, breakdownSteps: undefined }))
    expect(out).not.toContain('Arbetsgivarkostnad')
    expect(out).not.toContain('51 516,74')
    expect(out).not.toContain('Steg ett')
    expect(out).toContain('27 000,00')
  }, RENDER_TIMEOUT)
})
