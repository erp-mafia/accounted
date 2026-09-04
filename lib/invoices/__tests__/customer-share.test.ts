import { describe, it, expect } from 'vitest'
import { invoiceCustomerOutstanding, invoiceCustomerShare } from '../customer-share'
import { roundOre } from '@/lib/money'
import { makeInvoice } from '@/tests/helpers'

// Arbetskostnad 20 000 + moms 5 000 = 25 000, ROT 30 % of labor incl. moms
// = 7 500, customer share 17 500 (invoice-rules.md section 8, fakturamodellen).
const rot = makeInvoice({ subtotal: 20000, vat_amount: 5000, total: 25000, deduction_total: 7500 })

describe('invoiceCustomerShare', () => {
  it('is the total on a plain invoice, returned exactly as stored', () => {
    const plain = makeInvoice({ total: 12500 })
    expect(invoiceCustomerShare(plain)).toBe(12500)
    expect(invoiceCustomerShare({ total: 1234.56 })).toBe(1234.56)
  })

  it('treats a null, undefined or zero deduction as no deduction', () => {
    expect(invoiceCustomerShare({ total: 25000, deduction_total: null })).toBe(25000)
    expect(invoiceCustomerShare({ total: 25000, deduction_total: undefined })).toBe(25000)
    expect(invoiceCustomerShare({ total: 25000, deduction_total: 0 })).toBe(25000)
    expect(invoiceCustomerShare({ total: 25000, deduction_total: Number.NaN })).toBe(25000)
  })

  it('subtracts the ROT/RUT deduction: the 1513 share is Skatteverket\'s, not the customer\'s', () => {
    expect(invoiceCustomerShare(rot)).toBe(17500)
  })

  it('follows the sign of the total on a credit note, whose deduction is stored as a positive magnitude', () => {
    const credit = makeInvoice({
      ...rot, id: 'credit', total: -25000, vat_amount: -5000, subtotal: -20000, credited_invoice_id: rot.id,
    })
    expect(credit.deduction_total).toBe(7500)
    expect(invoiceCustomerShare(credit)).toBe(-17500)
    // An invoice and its full credit note net to zero for the customer.
    expect(invoiceCustomerShare(rot) + invoiceCustomerShare(credit)).toBe(0)
  })

  it('rounds to the öre without float drift', () => {
    expect(invoiceCustomerShare({ total: 1000.1, deduction_total: 300.2 })).toBe(699.9)
    expect(invoiceCustomerShare({ total: 1234.56, deduction_total: 370.37 })).toBe(864.19)
  })
})

describe('invoiceCustomerOutstanding', () => {
  it('is zero once the customer has paid their share, even though the gross total is not covered', () => {
    expect(invoiceCustomerOutstanding(rot, 17500)).toBe(0)
  })

  it('is the customer residual on a part-paid ROT/RUT invoice', () => {
    expect(invoiceCustomerOutstanding(rot, 10000)).toBe(7500)
  })

  it('is total minus paid on a plain invoice, signed: overpayment goes negative, not floored', () => {
    const plain = makeInvoice({ total: 12500 })
    expect(invoiceCustomerOutstanding(plain, 0)).toBe(12500)
    expect(invoiceCustomerOutstanding(plain, 5000)).toBe(7500)
    expect(invoiceCustomerOutstanding(plain, 12500.4)).toBe(-0.4)
  })

  it('keeps the sign on a credit note so a refund settles it', () => {
    const credit = makeInvoice({ ...rot, id: 'credit', total: -25000, credited_invoice_id: rot.id })
    expect(invoiceCustomerOutstanding(credit, 0)).toBe(-17500)
    expect(invoiceCustomerOutstanding(credit, -17500)).toBe(0)
  })

  it('stays in lockstep with the SQL guard once floored the way the guard does', () => {
    // invoices_remaining_amount_guard (20260817191708):
    // remaining_amount = GREATEST(0, ROUND(total - paid_amount - deduction_total, 2))
    // The guard rounds the whole expression once; the helper rounds the
    // share first. Both must land on the same öre.
    const guard = (total: number, paid: number, deduction: number) =>
      Math.max(0, roundOre(total - paid - deduction))
    const rows: Array<[number, number, number | null]> = [
      [25000, 0, 7500],
      [25000, 17500, 7500],
      [25000, 10000, 7500],
      [25000, 17500.4, 7500],
      [12500, 0, null],
      [12500, 12500, 0],
      [1234.56, 370.37, 100.1],
    ]
    for (const [total, paid, deduction] of rows) {
      expect(Math.max(0, invoiceCustomerOutstanding({ total, deduction_total: deduction }, paid)))
        .toBe(guard(total, paid, deduction ?? 0))
    }
  })
})
