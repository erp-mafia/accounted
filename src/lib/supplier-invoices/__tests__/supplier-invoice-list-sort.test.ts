import { describe, expect, it } from 'vitest'
import {
  sortSupplierInvoiceList,
  type SupplierInvoiceListSort,
} from '@/lib/supplier-invoices/supplier-invoice-list-sort'
import { makeSupplierInvoice } from '@/tests/helpers'
import type { SupplierInvoice } from '@/types'

function make(
  overrides: Partial<SupplierInvoice> = {},
  supplierName?: string,
): SupplierInvoice {
  const invoice = makeSupplierInvoice(overrides)
  if (supplierName !== undefined) {
    invoice.supplier = { id: 'supplier-1', name: supplierName } as SupplierInvoice['supplier']
  }
  return invoice
}

function sort(invoices: SupplierInvoice[], sortBy: SupplierInvoiceListSort) {
  return sortSupplierInvoiceList(invoices, sortBy)
}

describe('sortSupplierInvoiceList', () => {
  it('uses Swedish supplier collation and keeps missing suppliers last', () => {
    const invoices = [
      make({ id: 'aker' }, 'Åkeriet AB'),
      make({ id: 'alpha' }, 'Alpha AB'),
      make({ id: 'zulu' }, 'Zulu AB'),
      make({ id: 'missing' }),
    ]

    expect(sort(invoices, { column: 'supplier', direction: 'asc' }).map((i) => i.id)).toEqual([
      'alpha',
      'zulu',
      'aker',
      'missing',
    ])
    expect(sort(invoices, { column: 'supplier', direction: 'desc' }).map((i) => i.id)).toEqual([
      'aker',
      'zulu',
      'alpha',
      'missing',
    ])
  })

  it('sorts invoice numbers naturally', () => {
    const invoices = [
      make({ id: '10', supplier_invoice_number: 'F-10' }),
      make({ id: '2', supplier_invoice_number: 'F-2' }),
      make({ id: '1', supplier_invoice_number: 'F-1' }),
    ]

    expect(sort(invoices, { column: 'number', direction: 'asc' }).map((i) => i.id)).toEqual([
      '1',
      '2',
      '10',
    ])
  })

  it('sorts invoice and due dates in both directions', () => {
    const invoices = [
      make({ id: 'late', invoice_date: '2024-08-01', due_date: '2024-09-01' }),
      make({ id: 'early', invoice_date: '2024-06-01', due_date: '2024-07-01' }),
    ]

    expect(sort(invoices, { column: 'invoice_date', direction: 'asc' }).map((i) => i.id)).toEqual([
      'early',
      'late',
    ])
    expect(sort(invoices, { column: 'due', direction: 'desc' }).map((i) => i.id)).toEqual([
      'late',
      'early',
    ])
  })

  it('sorts the displayed rounded amount, honoring the per-invoice öresavrundning flag', () => {
    const invoices = [
      // 100.6 rounds to 101 when the per-invoice flag is on.
      make({ id: 'rounded', total: 100.6, ore_rounding: true, invoice_date: '2024-06-02' }),
      // 100.9 stays 100.9 with the flag off (null resolves to off for supplier invoices).
      make({ id: 'raw', total: 100.9, ore_rounding: null, invoice_date: '2024-06-01' }),
    ]

    expect(sort(invoices, { column: 'amount', direction: 'asc' }).map((i) => i.id)).toEqual([
      'raw',
      'rounded',
    ])
    expect(sort(invoices, { column: 'amount', direction: 'desc' }).map((i) => i.id)).toEqual([
      'rounded',
      'raw',
    ])
  })

  it('sorts by remaining amount', () => {
    const invoices = [
      make({ id: 'open', remaining_amount: 5000 }),
      make({ id: 'settled', remaining_amount: 0 }),
      make({ id: 'partial', remaining_amount: 2500 }),
    ]

    expect(sort(invoices, { column: 'remaining', direction: 'asc' }).map((i) => i.id)).toEqual([
      'settled',
      'partial',
      'open',
    ])
  })

  it('ranks statuses in lifecycle order', () => {
    const invoices = [
      make({ id: 'reversed', status: 'reversed' }),
      make({ id: 'credited', status: 'credited' }),
      make({ id: 'paid', status: 'paid' }),
      make({ id: 'disputed', status: 'disputed' }),
      make({ id: 'overdue', status: 'overdue' }),
      make({ id: 'partial', status: 'partially_paid' }),
      make({ id: 'approved', status: 'approved' }),
      make({ id: 'registered', status: 'registered' }),
    ]

    expect(sort(invoices, { column: 'status', direction: 'asc' }).map((i) => i.id)).toEqual([
      'registered',
      'approved',
      'partial',
      'overdue',
      'disputed',
      'paid',
      'credited',
      'reversed',
    ])
  })

  it('does not mutate input and uses newest date then id as stable tie-breakers', () => {
    const invoices = [
      make({ id: 'b', invoice_date: '2024-07-01' }, 'Same AB'),
      make({ id: 'a', invoice_date: '2024-07-01' }, 'Same AB'),
      make({ id: 'newer', invoice_date: '2024-07-02' }, 'Same AB'),
    ]
    const originalOrder = invoices.map((invoice) => invoice.id)

    expect(sort(invoices, { column: 'supplier', direction: 'asc' }).map((i) => i.id)).toEqual([
      'newer',
      'a',
      'b',
    ])
    expect(invoices.map((invoice) => invoice.id)).toEqual(originalOrder)
  })
})
