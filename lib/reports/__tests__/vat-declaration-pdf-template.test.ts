import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { VatDeclarationPDF } from '../vat-declaration-pdf-template'
import type { CompanySettings } from '@/types'
import { pdfTextStrings } from '@/tests/pdf-text'

function fakeCompany(): CompanySettings {
  return {
    company_name: 'Testbolaget AB',
    org_number: '5566778899',
    vat_number: 'SE556677889901',
  } as unknown as CompanySettings
}

describe('VatDeclarationPDF sign rendering (issue #1982)', () => {
  it('prints a negative ruta with an ASCII minus the bundled font can draw', async () => {
    const text = pdfTextStrings(
      await renderToBuffer(
        VatDeclarationPDF({
          rows: [
            { ruta: '05', label: 'Momspliktig försäljning', amount: 100000 },
            { ruta: '10', label: 'Utgående moms 25 %', amount: 25000 },
            // A credit-note-heavy period can push a ruta below zero.
            { ruta: '48', label: 'Ingående moms att dra av', amount: -1234 },
            { ruta: '49', label: 'Moms att betala', amount: 26234, isNet: true },
          ],
          period: { start: '2026-04-01', end: '2026-06-30' },
          periodLabel: 'April till juni 2026',
          company: fakeCompany(),
          generatedAt: '2026-08-29T10:00:00Z',
        })
      )
    ).join('\n')

    expect(text).toContain('-1 234')
    expect(text).toContain('26 234')
    expect(text).not.toContain(String.fromCharCode(0x12))
    expect(text).not.toContain('−')
  }, 30_000)
})
