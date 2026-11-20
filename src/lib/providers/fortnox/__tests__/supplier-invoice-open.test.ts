import { describe, expect, it } from 'vitest'
import { fortnoxSupplierInvoiceNotOpen } from '../mapper'

/**
 * PH 230: Fortnox's ?filter=unpaid answered an empty list for a company whose
 * ledger held five booked supplier invoices without a payment. Which listed
 * invoice is an open payable is now read from the list form's own fields.
 */
describe('fortnoxSupplierInvoiceNotOpen', () => {
  const item = (extra: Record<string, unknown>) => ({ GivenNumber: '1', Total: '1250', Balance: '1250', Booked: true, Cancel: false, ...extra })

  it('an open, booked invoice is open, also while Fortnox has it in payment', () => {
    expect(fortnoxSupplierInvoiceNotOpen(item({}))).toBeNull()
    expect(fortnoxSupplierInvoiceNotOpen(item({ PaymentPending: true }))).toBeNull()
    expect(fortnoxSupplierInvoiceNotOpen(item({ Balance: 47993.86 }))).toBeNull()
  })

  it('an open credit (negative balance) is open', () => {
    expect(fortnoxSupplierInvoiceNotOpen(item({ Total: '-200', Balance: '-200' }))).toBeNull()
  })

  it('a settled invoice is paid, whether Fortnox writes the zero as text or number', () => {
    expect(fortnoxSupplierInvoiceNotOpen(item({ Balance: '0' }))).toBe('paid')
    expect(fortnoxSupplierInvoiceNotOpen(item({ Balance: '0.00' }))).toBe('paid')
    expect(fortnoxSupplierInvoiceNotOpen(item({ Balance: 0.001 }))).toBe('paid')
  })

  it('an unbooked invoice stays out: it has no verifikat in the imported ledger', () => {
    expect(fortnoxSupplierInvoiceNotOpen(item({ Booked: false }))).toBe('unbooked')
  })

  it('a cancelled invoice stays out, in the list (Cancel) and the detail (Cancelled) spelling', () => {
    expect(fortnoxSupplierInvoiceNotOpen(item({ Cancel: true }))).toBe('cancelled')
    expect(fortnoxSupplierInvoiceNotOpen(item({ Cancelled: true, Balance: '0' }))).toBe('cancelled')
  })

  it('an absent or empty balance says nothing: the invoice is kept for the detail form to decide', () => {
    expect(fortnoxSupplierInvoiceNotOpen({ GivenNumber: '1', Booked: true })).toBeNull()
    expect(fortnoxSupplierInvoiceNotOpen(item({ Balance: '' }))).toBeNull()
  })
})
