import { describe, it, expect } from 'vitest'
import { mapFortnoxToSupplierInvoice, mapFortnoxToSalesInvoice } from '../mapper'

/**
 * Guards the paid-status hardening: deriveInvoiceStatus and paymentStatus.paid
 * share one isFullyPaid() source of truth, so status === 'paid' iff
 * paymentStatus.paid (for non-cancelled / non-credit rows). An ABSENT Balance
 * must never be read as paid — on either the supplier OR the sales path.
 */

function supplierRaw(over: Record<string, unknown>): Record<string, unknown> {
  return {
    GivenNumber: '100',
    Total: 1000,
    InvoiceDate: '2026-01-10',
    DueDate: '2026-02-10',
    SupplierName: 'Leverantör AB',
    Booked: true,
    ...over,
  }
}

function salesRaw(over: Record<string, unknown>): Record<string, unknown> {
  return {
    DocumentNumber: '200',
    Total: 1000,
    InvoiceDate: '2026-01-10',
    DueDate: '2026-02-10',
    CustomerName: 'Kund AB',
    Sent: true,
    ...over,
  }
}

describe('Fortnox mapper — paid-status consistency', () => {
  it('supplier: absent Balance is NOT paid (defaults to unpaid, not 0)', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({})) // no Balance key
    expect(dto.status).toBe('booked')
    expect(dto.paymentStatus.paid).toBe(false)
    expect(dto.paymentStatus.balance.value).toBe(1000)
  })

  it('supplier: Balance 0 → paid and status paid', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({ Balance: 0 }))
    expect(dto.status).toBe('paid')
    expect(dto.paymentStatus.paid).toBe(true)
  })

  it('supplier: positive Balance → unpaid', () => {
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({ Balance: 250 }))
    expect(dto.status).toBe('booked')
    expect(dto.paymentStatus.paid).toBe(false)
    expect(dto.paymentStatus.balance.value).toBe(250)
  })

  it('supplier: FullyPaid flag with absent Balance keeps status and paid CONSISTENT', () => {
    // Previously deriveInvoiceStatus said paid while paymentStatus.paid said unpaid.
    const dto = mapFortnoxToSupplierInvoice(supplierRaw({ FullyPaid: true }))
    expect(dto.status).toBe('paid')
    expect(dto.paymentStatus.paid).toBe(true)
    // paid ⇒ no outstanding balance, even though the raw payload omits Balance
    // (previously balance fell back to the full total, contradicting paid=true).
    expect(dto.paymentStatus.balance.value).toBe(0)
  })

  it('sales: absent Balance is NOT paid (no false-paid on the sales path)', () => {
    const dto = mapFortnoxToSalesInvoice(salesRaw({})) // no Balance key
    expect(dto.status).toBe('sent')
    expect(dto.paymentStatus.paid).toBe(false)
    expect(dto.paymentStatus.balance.value).toBe(1000)
  })

  it('sales: Balance 0 → paid and status paid', () => {
    const dto = mapFortnoxToSalesInvoice(salesRaw({ Balance: 0 }))
    expect(dto.status).toBe('paid')
    expect(dto.paymentStatus.paid).toBe(true)
  })

  it('sales: FullyPaid flag with absent Balance → paid with zero balance', () => {
    const dto = mapFortnoxToSalesInvoice(salesRaw({ FullyPaid: true }))
    expect(dto.status).toBe('paid')
    expect(dto.paymentStatus.paid).toBe(true)
    expect(dto.paymentStatus.balance.value).toBe(0)
  })

  it('status === paid iff paymentStatus.paid across a matrix (both paths)', () => {
    const balances = [undefined, 0, 0.004, 250, 1000]
    const flags = [undefined, true]
    for (const Balance of balances) {
      for (const FullyPaid of flags) {
        const over: Record<string, unknown> = { FullyPaid }
        if (Balance !== undefined) over.Balance = Balance
        for (const dto of [
          mapFortnoxToSupplierInvoice(supplierRaw(over)),
          mapFortnoxToSalesInvoice(salesRaw(over)),
        ]) {
          expect(
            dto.status === 'paid',
            `Balance=${Balance} FullyPaid=${FullyPaid}`,
          ).toBe(dto.paymentStatus.paid)
          // Invariant: paid ⇒ balance zeroed (never "fully paid yet full balance").
          if (dto.paymentStatus.paid) {
            expect(
              dto.paymentStatus.balance.value,
              `Balance=${Balance} FullyPaid=${FullyPaid}`,
            ).toBe(0)
          }
        }
      }
    }
  })
})
