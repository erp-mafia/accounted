import { describe, expect, it } from 'vitest'
import { mapBokioToSupplierInvoice } from '../mapper'
import { enrichBokioSupplierInvoice } from '../supplier-evidence'

const invoice = (lines: Record<string, unknown>[] = [{ description: 'Purchase', quantity: 1, unitPrice: 1000, taxRate: null }]) =>
  mapBokioToSupplierInvoice({ id: 'invoice', invoiceNumber: '1001', invoiceDate: '2025-12-20', currency: 'SEK',
    totalAmount: 1250, remainingAmount: 0, supplierRef: { id: 'supplier', name: 'Supplier' }, lineItems: lines })
const voucher = (items = [
  { account: '4000', debit: 1000, credit: 0 }, { account: '2641', debit: 250, credit: 0 },
  { account: '2440', debit: 0, credit: 1250 },
]) => ({ id: 'entry', series: 'V', number: 1, date: '2026-01-02', items,
  reversingJournalEntryId: null, reversedByJournalEntryId: null })

describe('Bokio supplier evidence', () => {
  it('corroborates invoice net and VAT and preserves the voucher date', () => {
    const result = enrichBokioSupplierInvoice(invoice(), voucher())
    expect(result.taxTotal?.taxAmount.value).toBe(250)
    expect(result.legalMonetaryTotal.lineExtensionAmount?.value).toBe(1000)
    expect(result.lines[0].taxPercent).toBe(25)
    expect(result.sourceVoucher).toEqual({ series: 'V', number: 1, date: '2026-01-02' })
    expect(result.supplierEvidence).toMatchObject({ vatSource: 'voucher', itemsComplete: true, voucherKind: 'registration' })
  })

  it('does not treat calculated reverse-charge input VAT as invoiced VAT', () => {
    const dto = invoice(); dto.legalMonetaryTotal.payableAmount.value = 1000
    const result = enrichBokioSupplierInvoice(dto, voucher([
      { account: '4000', debit: 1000, credit: 0 }, { account: '2645', debit: 250, credit: 0 },
      { account: '2614', debit: 0, credit: 250 }, { account: '2440', debit: 0, credit: 1000 },
    ]))
    expect(result.taxTotal).toBeUndefined()
    expect(result.supplierEvidence?.vatReason).toBe('unsupported_vat_accounts')
  })

  it('refuses a split that disagrees with the source net, including restricted deduction', () => {
    const result = enrichBokioSupplierInvoice(invoice(), voucher([
      { account: '4000', debit: 1125, credit: 0 }, { account: '2641', debit: 125, credit: 0 },
      { account: '2440', debit: 0, credit: 1250 },
    ]))
    expect(result.taxTotal).toBeUndefined()
    expect(result.supplierEvidence?.vatReason).toBe('invoice_net_mismatch')
  })

  it('preserves explicit mixed rates when they reconcile', () => {
    const dto = invoice([{ quantity: 1, unitPrice: 100, taxRate: 25 }, { quantity: 1, unitPrice: 100, taxRate: 6 }])
    dto.legalMonetaryTotal.payableAmount.value = 231
    const result = enrichBokioSupplierInvoice(dto)
    expect(result.taxTotal?.taxAmount.value).toBe(31)
    expect(result.lines.map(line => line.taxPercent)).toEqual([25, 6])
    expect(result.supplierEvidence?.itemsComplete).toBe(true)
  })

  it('does not allocate aggregate VAT across multiple unknown rates', () => {
    const result = enrichBokioSupplierInvoice(invoice([
      { quantity: 1, unitPrice: 500, taxRate: null }, { quantity: 1, unitPrice: 500, taxRate: null },
    ]), voucher())
    expect(result.taxTotal?.taxAmount.value).toBe(250)
    expect(result.lines.every(line => line.taxPercent === undefined)).toBe(true)
    expect(result.supplierEvidence?.itemsComplete).toBe(false)
  })

  it('distinguishes cash purchases from payable settlements', () => {
    expect(enrichBokioSupplierInvoice(invoice(), voucher([
      { account: '4000', debit: 1000, credit: 0 }, { account: '2641', debit: 250, credit: 0 },
      { account: '1930', debit: 0, credit: 1250 },
    ])).supplierEvidence?.voucherKind).toBe('cash_purchase')
    const result = enrichBokioSupplierInvoice(invoice(), voucher([
      { account: '2440', debit: 1250, credit: 0 }, { account: '1930', debit: 0, credit: 1250 },
    ]))
    expect(result.supplierEvidence?.voucherKind).toBe('settlement')
    expect(result.taxTotal).toBeUndefined()
  })

  it('refuses batch amounts, reversed entries and foreign currency', () => {
    const batch = voucher(); batch.items[2].credit = 2500; batch.items[0].debit = 2250
    expect(enrichBokioSupplierInvoice(invoice(), batch).taxTotal).toBeUndefined()
    expect(enrichBokioSupplierInvoice(invoice(), { ...voucher(), reversedByJournalEntryId: 'reversal' }).taxTotal).toBeUndefined()
    expect(enrichBokioSupplierInvoice({ ...invoice(), currencyCode: 'EUR' }, voucher()).taxTotal).toBeUndefined()
  })

  it('keeps absent source lines and absent VAT unknown', () => {
    const result = enrichBokioSupplierInvoice(invoice([]), voucher())
    expect(result.taxTotal).toBeUndefined()
    expect(result.supplierEvidence?.itemsComplete).toBe(false)
  })
})
