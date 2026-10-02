import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { SalaryBankListPDF } from '../bank-list-template'
import type { SalaryBankList } from '@/lib/salary/payment/bank-list'
import { pdfTextStrings } from '@/tests/pdf-text'

// Real @react-pdf/renderer layout is CPU-heavy; under a fully parallel test
// run it can exceed the 5s default on a saturated machine.
const RENDER_TIMEOUT = 30_000

const list: SalaryBankList = {
  format: 'bg_lb',
  filename: 'bg_lb_lon_2026-04.txt',
  paymentDate: '2026-04-24',
  periodLabel: '2026-04',
  employeeCount: 2,
  totalAmount: 38750.75,
  payer: { name: 'Testbolaget AB', orgNumber: '556000-0000', account: '5050-1055' },
  payees: [
    { employeeId: 'emp-1', name: 'Anna Test', maskedAccount: '6000-****6789', amount: 20000.5, reference: '000018' },
    { employeeId: 'emp-2', name: 'Bo Test', maskedAccount: '83279-****7890', amount: 18750.25, reference: '000026' },
  ],
  warnings: ['BIC härleddes. Spara BIC under Inställningar → Fakturering.'],
}

describe('SalaryBankListPDF', () => {
  it(
    'prints every payee line, the total and the file it describes',
    async () => {
      const buffer = await renderToBuffer(SalaryBankListPDF({ list, generatedAt: '2026-04-20T08:00:00.000Z' }))
      const text = pdfTextStrings(buffer).join('\n')
      expect(text).toContain('Banklista')
      expect(text).toContain('bg_lb_lon_2026-04.txt')
      expect(text).toContain('Utbetalningsnummer')
      for (const payee of list.payees) {
        expect(text).toContain(payee.name)
        expect(text).toContain(payee.maskedAccount)
        expect(text).toContain(payee.reference)
      }
      expect(text).toContain('20 000,50')
      expect(text).toContain('18 750,25')
      expect(text).toContain('38 750,75')
      // The settings arrow has no Helvetica glyph; it prints as ">".
      expect(text).toContain('Inställningar > Fakturering')
    },
    RENDER_TIMEOUT,
  )
})
