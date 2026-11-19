import { describe, expect, it } from 'vitest'
import { roundOre } from '@/lib/money'
import {
  buildSandboxRepresentationVoucher,
  deductibleRepresentationVat,
  SANDBOX_REPRESENTATION_ACCOUNT,
  SANDBOX_REPRESENTATION_LINE,
  SANDBOX_REPRESENTATION_NOTES,
  SANDBOX_STAGED_REPRESENTATION_NOTES,
} from '../representation'

const voucher = () =>
  buildSandboxRepresentationVoucher({
    fiscalPeriodId: 'fp-1',
    entryDate: '2026-05-10',
    supplierInvoiceId: 'si-1',
    supplierInvoiceNumber: '88245',
    arrivalNumber: 2,
    supplierName: 'Demokafé AB',
  })

describe('sandbox representation demo (accounted#80, crm#1342)', () => {
  it('describes a consistent food-only invoice line', () => {
    const line = SANDBOX_REPRESENTATION_LINE
    expect(line.vat).toBe(roundOre((line.net * line.vatRatePercent) / 100))
    expect(line.total).toBe(roundOre(line.net + line.vat))
    // Restaurant and catering stayed at 12 % through the 2026 food change.
    expect(line.vatRatePercent).toBe(12)
  })

  it('books the lunch on a representation account, never on travel (5810)', () => {
    expect(SANDBOX_REPRESENTATION_ACCOUNT).toMatch(/^607\d$/)
    // A måltid is not income-tax deductible: 6072, not 6071.
    expect(SANDBOX_REPRESENTATION_ACCOUNT).toBe('6072')
    const cost = voucher().lines.filter((l) => l.account_number.startsWith('6') || l.account_number.startsWith('5'))
    expect(cost.map((l) => l.account_number)).toEqual(['6072'])
  })

  it('deducts only the VAT the 300 kr per person base allows, and all of it here', () => {
    const line = SANDBOX_REPRESENTATION_LINE
    const cap = roundOre(line.participants * 300 * 0.12)
    expect(line.vat).toBeLessThanOrEqual(cap)
    const vatLine = voucher().lines.find((l) => l.account_number === '2641')
    expect(vatLine?.debit_amount).toBe(28.8)
    expect(voucher().lines.find((l) => l.account_number === '6072')?.debit_amount).toBe(240)
  })

  it('caps the deductible VAT at 36 kr per person for a 12 % meal', () => {
    // Two people, 1 000 kr excl. moms: the base is capped at 600 kr.
    expect(deductibleRepresentationVat({ net: 1000, vat: 120, vatRatePercent: 12, participants: 2 })).toBe(72)
    // Under the cap the whole charged VAT is deductible.
    expect(deductibleRepresentationVat({ net: 240, vat: 28.8, vatRatePercent: 12, participants: 2 })).toBe(28.8)
    // Never more than what the invoice charged.
    expect(deductibleRepresentationVat({ net: 100, vat: 10, vatRatePercent: 12, participants: 4 })).toBe(10)
  })

  it('balances against 2440 with the registration path description', () => {
    const v = voucher()
    const debit = roundOre(v.lines.reduce((n, l) => n + l.debit_amount, 0))
    const credit = roundOre(v.lines.reduce((n, l) => n + l.credit_amount, 0))
    expect(debit).toBe(credit)
    expect(debit).toBe(SANDBOX_REPRESENTATION_LINE.total)
    expect(v.lines.find((l) => l.account_number === '2440')?.credit_amount).toBe(268.8)
    expect(v.description).toBe('Leverantörsfaktura 88245, Demokafé AB (ankomstnr 2)')
    expect(v.source_type).toBe('supplier_invoice_registered')
    expect(v.source_id).toBe('si-1')
    for (const l of v.lines) {
      expect(l.debit_amount === 0 || l.credit_amount === 0).toBe(true)
    }
  })

  it('writes syfte and deltagare on the verifikat itself (no upload needed)', () => {
    expect(voucher().notes).toBe(SANDBOX_REPRESENTATION_NOTES)
    for (const notes of [SANDBOX_REPRESENTATION_NOTES, SANDBOX_STAGED_REPRESENTATION_NOTES]) {
      expect(notes).toMatch(/Syfte: \S/)
      // Every participant by name and company.
      expect(notes).toContain('Demo Användare (Sandlådan Konsult)')
      expect(notes).toContain('Karin Björk (Björk & Partner AB)')
    }
  })
})
