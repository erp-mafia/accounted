import { describe, it, expect } from 'vitest'
import { mapVismaToSalesInvoice, mapVismaToSupplierInvoice } from '../mapper'

/**
 * Guards the paid/credit-note derivation against the fields eAccounting
 * actually populates (ElvaSmultron support case, 2026-08-08):
 *
 *  - The /supplierinvoices LIST payload omits RemainingAmount. Reading the
 *    absence as 0 imported all 290 supplier invoices as fully paid, including
 *    the two that were open in the source system. SupplierInvoiceApi's
 *    PaymentStatus enum (Unpaid=3 ... Paid=6 ... PaidInBank=9) is the reliable
 *    signal and must win over a missing amount.
 *  - Credit invoices carry a negative TotalAmount, so the old
 *    `remaining === 0 && total > 0` check could never mark them settled: they
 *    fell through to 'draft' and surfaced on the dashboard as overdue unsent
 *    invoices. IsCreditInvoice must map to invoiceTypeCode '381'.
 */

function supplierRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'b1',
    InvoiceNumber: '903127919426',
    InvoiceDate: '2026-07-31',
    DueDate: '2026-08-30',
    CurrencyCode: 'SEK',
    TotalAmount: 1250,
    SupplierName: 'PostNord Sverige AB',
    Rows: [],
    ...over,
  }
}

function salesRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 's1',
    InvoiceNumber: '10060',
    InvoiceDate: '2026-07-24',
    DueDate: '2026-08-10',
    CurrencyCode: 'SEK',
    TotalAmount: 75000,
    InvoiceCustomerName: 'Kund AB',
    Rows: [],
    ...over,
  }
}

describe('mapVismaToSupplierInvoice payment status', () => {
  it('PaymentStatus Unpaid (3) with RemainingAmount ABSENT stays an open payable', () => {
    const dto = mapVismaToSupplierInvoice(supplierRaw({ PaymentStatus: 3 }))
    expect(dto.paymentStatus.paid).toBe(false)
    // Open balance falls back to the total, never to a settled-looking 0.
    expect(dto.paymentStatus.balance.value).toBe(1250)
    expect(dto.status).toBe('booked')
  })

  it('PaymentStatus Paid (6) is settled even without RemainingAmount', () => {
    const dto = mapVismaToSupplierInvoice(supplierRaw({ PaymentStatus: 6, PaymentDate: '2026-08-02' }))
    expect(dto.paymentStatus.paid).toBe(true)
    expect(dto.paymentStatus.balance.value).toBe(0)
    expect(dto.paymentStatus.lastPaymentDate).toBe('2026-08-02')
    expect(dto.status).toBe('paid')
  })

  it('PaymentStatus PaidInBank (9) is settled', () => {
    const dto = mapVismaToSupplierInvoice(supplierRaw({ PaymentStatus: 9 }))
    expect(dto.paymentStatus.paid).toBe(true)
  })

  it('bank in-flight states (SentToBank=15, ReceivedByBank=16) are NOT settled', () => {
    for (const ps of [8, 10, 11, 15, 16, 17]) {
      const dto = mapVismaToSupplierInvoice(supplierRaw({ PaymentStatus: ps }))
      expect(dto.paymentStatus.paid).toBe(false)
    }
  })

  it('PaymentStatus OverDue (7) maps to overdue', () => {
    const dto = mapVismaToSupplierInvoice(supplierRaw({ PaymentStatus: 7 }))
    expect(dto.status).toBe('overdue')
    expect(dto.paymentStatus.paid).toBe(false)
  })

  it('partial payment with RemainingAmount present keeps the real balance', () => {
    const dto = mapVismaToSupplierInvoice(supplierRaw({ PaymentStatus: 5, RemainingAmount: 250 }))
    expect(dto.paymentStatus.paid).toBe(false)
    expect(dto.paymentStatus.balance.value).toBe(250)
  })

  it('falls back to RemainingAmount === 0 when the PaymentStatus enum is absent', () => {
    const dto = mapVismaToSupplierInvoice(supplierRaw({ RemainingAmount: 0 }))
    expect(dto.paymentStatus.paid).toBe(true)
    const open = mapVismaToSupplierInvoice(supplierRaw({ RemainingAmount: 1250 }))
    expect(open.paymentStatus.paid).toBe(false)
  })

  it('both enum and amount absent: open, not silently paid', () => {
    const dto = mapVismaToSupplierInvoice(supplierRaw())
    expect(dto.paymentStatus.paid).toBe(false)
    expect(dto.paymentStatus.balance.value).toBe(1250)
  })

  it('IsCreditInvoice sets invoiceTypeCode 381 and status credited', () => {
    const dto = mapVismaToSupplierInvoice(supplierRaw({ IsCreditInvoice: true, TotalAmount: -500 }))
    expect(dto.invoiceTypeCode).toBe('381')
    expect(dto.status).toBe('credited')
  })

  it('Status Draft (0) maps to draft, Deleted (2) to cancelled', () => {
    expect(mapVismaToSupplierInvoice(supplierRaw({ Status: 0, PaymentStatus: 3 })).status).toBe('draft')
    expect(mapVismaToSupplierInvoice(supplierRaw({ Status: 2, PaymentStatus: 3 })).status).toBe('cancelled')
  })
})

describe('mapVismaToSalesInvoice payment status', () => {
  it('PaymentStatus Paid (0) is settled even without RemainingAmount', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({ PaymentStatus: 0, PaymentDate: '2026-08-01' }))
    expect(dto.paymentStatus.paid).toBe(true)
    expect(dto.paymentStatus.balance.value).toBe(0)
    expect(dto.paymentStatus.lastPaymentDate).toBe('2026-08-01')
    expect(dto.status).toBe('paid')
  })

  it('PaymentStatus Unpaid (1) with RemainingAmount absent stays open at full total', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({ PaymentStatus: 1, IsBooked: true }))
    expect(dto.paymentStatus.paid).toBe(false)
    expect(dto.paymentStatus.balance.value).toBe(75000)
    expect(dto.status).toBe('booked')
  })

  it('PaymentStatus Overdue (2) maps to overdue', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({ PaymentStatus: 2, RemainingAmount: 75000 }))
    expect(dto.status).toBe('overdue')
    expect(dto.paymentStatus.paid).toBe(false)
  })

  it('legacy fallback: RemainingAmount 0 with positive total is paid when enum absent', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({ RemainingAmount: 0 }))
    expect(dto.paymentStatus.paid).toBe(true)
    expect(dto.status).toBe('paid')
  })

  it('credit invoice (negative total) becomes a settled credit note, never a draft', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({
      IsCreditInvoice: true,
      TotalAmount: -2495,
      RemainingAmount: 0,
    }))
    expect(dto.invoiceTypeCode).toBe('381')
    expect(dto.status).toBe('credited')
    expect(dto.paymentStatus.paid).toBe(true)
  })

  it('unbooked unpaid invoice still derives sent from SendType', () => {
    const dto = mapVismaToSalesInvoice(salesRaw({ PaymentStatus: 1, SendType: 1 }))
    expect(dto.status).toBe('sent')
  })
})
