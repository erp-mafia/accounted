import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeInvoice, makeSupplierInvoice } from '@/tests/helpers'

const { mockEmit } = vi.hoisted(() => ({ mockEmit: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({
  eventBus: { emit: mockEmit },
}))

import {
  emitInvoicePaidIfSettled,
  emitSupplierInvoicePaidIfSettled,
} from '@/lib/invoices/paid-events'

describe('emitInvoicePaidIfSettled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEmit.mockResolvedValue(undefined)
  })

  const invoice = makeInvoice({ id: 'inv-1', status: 'paid', remaining_amount: 0, paid_amount: 1250 })

  it('emits invoice.paid once, with the existing payload shape, when the write set paid', async () => {
    const outcome = await emitInvoicePaidIfSettled({
      newStatus: 'paid',
      invoice,
      paymentAmount: 1250,
      paymentDate: '2026-09-30',
      userId: 'user-1',
      companyId: 'company-1',
    })

    expect(outcome).toBe('emitted')
    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'invoice.paid',
      payload: {
        invoice,
        paymentAmount: 1250,
        paymentDate: '2026-09-30',
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it('emits nothing for a partial payment: money is still owed', async () => {
    const outcome = await emitInvoicePaidIfSettled({
      newStatus: 'partially_paid',
      invoice: { ...invoice, status: 'partially_paid' },
      paymentAmount: 500,
      paymentDate: '2026-09-30',
      userId: 'user-1',
      companyId: 'company-1',
    })

    expect(outcome).toBe('not_fully_paid')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('reports emit_failed instead of throwing: the payment has already committed', async () => {
    mockEmit.mockRejectedValue(new Error('bus down'))

    const outcome = await emitInvoicePaidIfSettled({
      newStatus: 'paid',
      invoice,
      paymentAmount: 1250,
      paymentDate: '2026-09-30',
      userId: 'user-1',
      companyId: 'company-1',
    })

    expect(outcome).toBe('emit_failed')
  })
})

describe('emitSupplierInvoicePaidIfSettled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEmit.mockResolvedValue(undefined)
  })

  const supplierInvoice = makeSupplierInvoice({ id: 'si-1', status: 'paid', remaining_amount: 0 })

  it('emits supplier_invoice.paid once, with the existing payload shape, when the write set paid', async () => {
    const outcome = await emitSupplierInvoicePaidIfSettled({
      newStatus: 'paid',
      supplierInvoice,
      paymentAmount: 1000,
      userId: 'user-1',
      companyId: 'company-1',
    })

    expect(outcome).toBe('emitted')
    expect(mockEmit).toHaveBeenCalledTimes(1)
    expect(mockEmit).toHaveBeenCalledWith({
      type: 'supplier_invoice.paid',
      payload: { supplierInvoice, paymentAmount: 1000, userId: 'user-1', companyId: 'company-1' },
    })
  })

  it('emits nothing for a partial payment', async () => {
    const outcome = await emitSupplierInvoicePaidIfSettled({
      newStatus: 'partially_paid',
      supplierInvoice: { ...supplierInvoice, status: 'partially_paid' },
      paymentAmount: 400,
      userId: 'user-1',
      companyId: 'company-1',
    })

    expect(outcome).toBe('not_fully_paid')
    expect(mockEmit).not.toHaveBeenCalled()
  })

  it('reports emit_failed instead of throwing', async () => {
    mockEmit.mockRejectedValue(new Error('bus down'))

    const outcome = await emitSupplierInvoicePaidIfSettled({
      newStatus: 'paid',
      supplierInvoice,
      paymentAmount: 1000,
      userId: 'user-1',
      companyId: 'company-1',
    })

    expect(outcome).toBe('emit_failed')
  })
})
