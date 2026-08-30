import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { KassaflodesanalysPDF } from '../kassaflodesanalys-pdf-template'
import type { KassaflodesanalysReport } from '../kassaflodesanalys'
import type { CompanySettings } from '@/types'
import { pdfTextStrings } from '@/tests/pdf-text'

function fakeCompany(): CompanySettings {
  return {
    company_name: 'Testbolaget AB',
    org_number: '5566778899',
  } as unknown as CompanySettings
}

function report(): KassaflodesanalysReport {
  return {
    fiscal_period_id: 'fp-1',
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    lopande: {
      resultat_efter_finansiella_poster: -4684.24,
      avskrivningar: 1000,
      ovriga_ej_kassaflodesposter: 0,
      delta_kortfristiga_fordringar: -250.5,
      delta_varulager: 0,
      delta_kortfristiga_skulder: 300,
      skatt_betald: 0,
      total: -3634.74,
    },
    investerings: {
      forvarv_anlaggningar: -12000,
      avyttring_anlaggningar: 0,
      total: -12000,
    },
    finansierings: {
      delta_lan: 0,
      utdelningar: 0,
      nyemission: 0,
      erhallna_aktieagartillskott: 0,
      total: 0,
    },
    total_cash_flow: -15634.74,
    reconciliation: {
      opening_cash_1xxx: 50000,
      closing_cash_1xxx: 34365.26,
      delta_actual: -15634.74,
      delta_calculated: -15634.74,
      mismatch_amount: 0,
      is_reconciled: true,
    },
  }
}

describe('KassaflodesanalysPDF sign rendering (issue #1982)', () => {
  it('prints negative cash flows with an ASCII minus the bundled font can draw', async () => {
    const text = pdfTextStrings(
      await renderToBuffer(
        KassaflodesanalysPDF({
          report: report(),
          company: fakeCompany(),
          generatedAt: '2026-08-29T10:00:00Z',
        })
      )
    ).join('\n')

    expect(text).toContain('-4 684,24')
    expect(text).toContain('-12 000,00')
    expect(text).toContain('-15 634,74')
    expect(text).not.toContain(String.fromCharCode(0x12))
    expect(text).not.toContain('−')
  }, 30_000)
})
