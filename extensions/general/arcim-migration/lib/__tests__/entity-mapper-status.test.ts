import { describe, it, expect } from 'vitest'
import { mapSupplierInvoice } from '../entity-mapper'
import type { SupplierInvoiceDto, InvoiceStatusCode, PartyDto } from '@/lib/providers/dto'

/**
 * Guards the status/paid consistency hardening in mapSupplierInvoice: the
 * provider's lifecycle status (dto.status) and its payment status are computed
 * independently upstream and can contradict each other. The mapper must emit a
 * `status` that always agrees with paid_amount / remaining_amount, and treat
 * Balance numerically (drift-safe), without ever flipping a credit note.
 */

const party: PartyDto = { name: 'Leverantör AB', identifications: [] }

function makeDto(over: {
  status?: InvoiceStatusCode
  paid?: boolean
  balance?: number
  total?: number
  invoiceTypeCode?: string
  lastPaymentDate?: string
}): SupplierInvoiceDto {
  const total = over.total ?? 1000
  return {
    id: 'inv-1',
    invoiceNumber: 'F-100',
    issueDate: '2026-01-10',
    dueDate: '2026-02-10',
    invoiceTypeCode: over.invoiceTypeCode,
    currencyCode: 'SEK',
    status: over.status ?? 'booked',
    supplier: party,
    buyer: party,
    lines: [
      {
        id: '1',
        description: 'Tjänst',
        lineExtensionAmount: { value: total, currencyCode: 'SEK' },
        taxPercent: 25,
      },
    ],
    legalMonetaryTotal: {
      lineExtensionAmount: { value: total, currencyCode: 'SEK' },
      payableAmount: { value: total, currencyCode: 'SEK' },
    },
    paymentStatus: {
      paid: over.paid ?? false,
      balance: { value: over.balance ?? total, currencyCode: 'SEK' },
      lastPaymentDate: over.lastPaymentDate,
    },
  }
}

function map(over: Parameters<typeof makeDto>[0]) {
  return mapSupplierInvoice(makeDto(over), 'user-1', 'company-1', 'supplier-1').invoice
}

describe('mapSupplierInvoice — status/paid consistency', () => {
  it('unpaid booked invoice → registered with full remaining', () => {
    const inv = map({ status: 'booked', paid: false, balance: 1000, total: 1000 })
    expect(inv.status).toBe('registered')
    expect(inv.paid_amount).toBe(0)
    expect(inv.remaining_amount).toBe(1000)
    expect(inv.paid_at).toBeNull()
  })

  it('booked-but-paid invoice → flips to paid (status follows payment)', () => {
    // The bug: dto.status='booked' (→registered) while paymentStatus.paid=true.
    const inv = map({ status: 'booked', paid: true, balance: 0, total: 1000, lastPaymentDate: '2026-02-05' })
    expect(inv.status).toBe('paid')
    expect(inv.paid_amount).toBe(1000)
    expect(inv.remaining_amount).toBe(0)
    expect(inv.paid_at).toBe('2026-02-05')
  })

  it('near-zero residual balance (0.004) resolves to paid, not unpaid', () => {
    const inv = map({ status: 'booked', paid: false, balance: 0.004, total: 1000 })
    expect(inv.status).toBe('paid')
    expect(inv.remaining_amount).toBe(0)
    expect(inv.paid_amount).toBe(1000)
  })

  it('partially-paid invoice (0 < paid < total) → partially_paid', () => {
    const inv = map({ status: 'booked', paid: false, balance: 300, total: 1000 })
    expect(inv.status).toBe('partially_paid')
    expect(inv.paid_amount).toBe(700)
    expect(inv.remaining_amount).toBe(300)
    expect(inv.paid_at).not.toBeNull()
  })

  it('credit note with zero balance stays credited — never flipped to paid', () => {
    const inv = map({ status: 'credited', paid: true, balance: 0, total: 1000, invoiceTypeCode: '381' })
    expect(inv.status).toBe('credited')
    expect(inv.is_credit_note).toBe(true)
  })

  it('credit note is forced to credited even if the provider sends a non-terminal status', () => {
    // invoiceTypeCode='381' but a contradictory lifecycle status (the arcim
    // gateway does not guarantee status='credited' alongside the type code).
    for (const status of ['booked', 'paid', 'sent', 'draft'] as InvoiceStatusCode[]) {
      const inv = map({ status, paid: true, balance: 0, total: 1000, invoiceTypeCode: '381' })
      expect(inv.status, `status=${status}`).toBe('credited')
      expect(inv.is_credit_note).toBe(true)
      expect(inv.paid_at).toBeNull()
    }
  })

  it('overdue lifecycle status is preserved when nothing is paid', () => {
    const inv = map({ status: 'overdue', paid: false, balance: 1000, total: 1000 })
    expect(inv.status).toBe('overdue')
    expect(inv.remaining_amount).toBe(1000)
  })

  it('never emits a status outside the supplier_invoices CHECK allow-list', () => {
    const allowed = new Set([
      'registered', 'approved', 'paid', 'partially_paid', 'overdue', 'disputed', 'credited', 'reversed',
    ])
    for (const status of ['draft', 'sent', 'booked', 'paid', 'overdue', 'cancelled', 'credited'] as InvoiceStatusCode[]) {
      for (const paid of [true, false]) {
        for (const balance of [0, 250, 1000]) {
          const inv = map({ status, paid, balance, total: 1000 })
          expect(allowed.has(inv.status as string)).toBe(true)
        }
      }
    }
  })
})
