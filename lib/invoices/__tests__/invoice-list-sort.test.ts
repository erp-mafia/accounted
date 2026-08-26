import { describe, expect, it } from 'vitest'
import { sortInvoiceList, type InvoiceListSort } from '@/lib/invoices/invoice-list-sort'
import { makeInvoice } from '@/tests/helpers'
import type { Invoice } from '@/types'

function sort(invoices: Invoice[], sortBy: InvoiceListSort, oreRounding = true) {
  return sortInvoiceList(invoices, sortBy, oreRounding)
}

describe('sortInvoiceList', () => {
  it('sorts displayed invoice numbers naturally and keeps missing numbers last', () => {
    const invoices = [
      makeInvoice({ id: '10', invoice_number: 'F-10' }),
      makeInvoice({ id: '2', invoice_number: 'F-2' }),
      makeInvoice({ id: 'external', invoice_number: null, external_invoice_number: 'SB-3' }),
      makeInvoice({ id: 'missing', invoice_number: null, external_invoice_number: null }),
    ]

    expect(sort(invoices, { column: 'number', direction: 'asc' }).map((i) => i.id)).toEqual([
      '2',
      '10',
      'external',
      'missing',
    ])
    expect(sort(invoices, { column: 'number', direction: 'desc' }).map((i) => i.id)).toEqual([
      'external',
      '10',
      '2',
      'missing',
    ])
  })

  it('uses Swedish customer collation and keeps missing customers last', () => {
    const invoices = [
      makeInvoice({ id: 'aker', customer: { name: 'Åker AB' } as Invoice['customer'] }),
      makeInvoice({ id: 'alpha', customer: { name: 'Alpha AB' } as Invoice['customer'] }),
      makeInvoice({ id: 'zulu', customer: { name: 'Zulu AB' } as Invoice['customer'] }),
      makeInvoice({ id: 'missing', customer: undefined }),
    ]

    expect(sort(invoices, { column: 'customer', direction: 'asc' }).map((i) => i.id)).toEqual([
      'alpha',
      'zulu',
      'aker',
      'missing',
    ])
    expect(sort(invoices, { column: 'customer', direction: 'desc' }).map((i) => i.id)).toEqual([
      'aker',
      'zulu',
      'alpha',
      'missing',
    ])
  })

  it('sorts displayed due dates and keeps draft and credit-note blanks last', () => {
    const invoices = [
      makeInvoice({ id: 'august', status: 'sent', due_date: '2024-08-01' }),
      makeInvoice({ id: 'june', status: 'sent', due_date: '2024-06-01' }),
      makeInvoice({ id: 'draft', status: 'draft', due_date: '2024-01-01' }),
      makeInvoice({ id: 'credit', status: 'sent', due_date: '2024-02-01', credited_invoice_id: 'original' }),
    ]

    const ascending = sort(invoices, { column: 'due', direction: 'asc' }).map((i) => i.id)
    const descending = sort(invoices, { column: 'due', direction: 'desc' }).map((i) => i.id)

    expect(ascending.slice(0, 2)).toEqual(['june', 'august'])
    expect(new Set(ascending.slice(2))).toEqual(new Set(['draft', 'credit']))
    expect(descending.slice(0, 2)).toEqual(['august', 'june'])
    expect(new Set(descending.slice(2))).toEqual(new Set(['draft', 'credit']))
  })

  it('sorts the rounded amount displayed in the list', () => {
    const invoices = [
      makeInvoice({ id: 'larger', invoice_date: '2024-07-02', total: 11.6 }),
      makeInvoice({ id: 'smaller', invoice_date: '2024-07-01', total: 10.4 }),
    ]

    expect(sort(invoices, { column: 'amount', direction: 'asc' }, true).map((i) => i.id)).toEqual([
      'smaller',
      'larger',
    ])
    expect(sort(invoices, { column: 'amount', direction: 'desc' }, true).map((i) => i.id)).toEqual([
      'larger',
      'smaller',
    ])
  })

  it('breaks rounded-amount ties by newest invoice date while unrounded totals still order', () => {
    const invoices = [
      makeInvoice({ id: 'newer', invoice_date: '2024-07-02', total: 10.49 }),
      makeInvoice({ id: 'older', invoice_date: '2024-07-01', total: 10.01 }),
    ]

    expect(sort(invoices, { column: 'amount', direction: 'asc' }, true).map((i) => i.id)).toEqual([
      'newer',
      'older',
    ])
    expect(sort(invoices, { column: 'amount', direction: 'asc' }, false).map((i) => i.id)).toEqual([
      'older',
      'newer',
    ])
  })

  it('sorts lifecycle statuses and ranks a cancelled credit note as cancelled', () => {
    const invoices = [
      makeInvoice({ id: 'cancelled-credit', status: 'cancelled', credited_invoice_id: 'original' }),
      makeInvoice({ id: 'credited', status: 'credited' }),
      makeInvoice({ id: 'credit', status: 'sent', credited_invoice_id: 'original' }),
      makeInvoice({ id: 'paid', status: 'paid' }),
      makeInvoice({ id: 'overdue', status: 'overdue' }),
      makeInvoice({ id: 'partial', status: 'partially_paid' }),
      makeInvoice({ id: 'sent', status: 'sent' }),
      makeInvoice({ id: 'draft', status: 'draft' }),
    ]

    expect(sort(invoices, { column: 'status', direction: 'asc' }).map((i) => i.id)).toEqual([
      'draft',
      'sent',
      'partial',
      'overdue',
      'paid',
      'credit',
      'credited',
      'cancelled-credit',
    ])
  })

  it('does not mutate input and uses newest date then id as stable tie-breakers', () => {
    const invoices = [
      makeInvoice({ id: 'b', invoice_date: '2024-07-01', customer: { name: 'Same' } as Invoice['customer'] }),
      makeInvoice({ id: 'a', invoice_date: '2024-07-01', customer: { name: 'Same' } as Invoice['customer'] }),
      makeInvoice({ id: 'newer', invoice_date: '2024-07-02', customer: { name: 'Same' } as Invoice['customer'] }),
    ]
    const originalOrder = invoices.map((invoice) => invoice.id)

    expect(sort(invoices, { column: 'customer', direction: 'asc' }).map((i) => i.id)).toEqual([
      'newer',
      'a',
      'b',
    ])
    expect(invoices.map((invoice) => invoice.id)).toEqual(originalOrder)
  })
})
