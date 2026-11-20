import { describe, expect, it } from 'vitest'
import { sameInvoiceItems } from '../same-invoice'
import type { InkorgItem } from '../items'
import { makeItem, reading } from './fixtures'

/**
 * A two-page paper invoice photographed a page at a time (agent feedback
 * 2026-11-06): uploaded as receipts, read as one supplier invoice, the total
 * printed on the second page only.
 */
function page(id: string, overrides: Partial<InkorgItem> = {}, total: number | null = null): InkorgItem {
  return makeItem({
    id,
    kind_hint: 'receipt',
    created_at: id === 'page-1' ? '2026-11-01T09:00:00.000Z' : '2026-11-01T09:00:02.000Z',
    extracted_data: reading({
      documentKind: 'supplier_invoice',
      supplier: { name: 'Bygg & Co AB' },
      invoice: { invoiceNumber: 'F 1001', invoiceDate: '2026-09-15' },
      totals: { total },
    }),
    ...overrides,
  })
}

describe('sameInvoiceItems', () => {
  it('names each page of one invoice to the other, whichever carries the total', () => {
    const result = sameInvoiceItems([page('page-2', {}, 1250), page('page-1')])
    expect(result.get('page-1')).toEqual({ item_ids: ['page-2'], handled_item_id: null })
    expect(result.get('page-2')).toEqual({ item_ids: ['page-1'], handled_item_id: null })
  })

  it('reads the number and the supplier as printed: case, spaces and punctuation do not split them', () => {
    const other = page('page-2', {
      extracted_data: reading({
        documentKind: 'supplier_invoice',
        supplier: { name: 'BYGG & CO AB.' },
        invoice: { invoiceNumber: '#F1001', invoiceDate: null },
      }),
    })
    expect(sameInvoiceItems([page('page-1'), other]).get('page-1')?.item_ids).toEqual(['page-2'])
  })

  it('names the page already registered, and says nothing on the registered one', () => {
    const registered = page('page-2', { created_supplier_invoice_id: 'si-1' }, 1250)
    const result = sameInvoiceItems([page('page-1'), registered])
    expect(result.get('page-1')).toEqual({ item_ids: ['page-2'], handled_item_id: 'page-2' })
    expect(result.has('page-2')).toBe(false)
  })

  it('leaves alone different numbers, different suppliers and disagreeing dates', () => {
    const number = page('page-2', { extracted_data: reading({ documentKind: 'supplier_invoice', supplier: { name: 'Bygg & Co AB' }, invoice: { invoiceNumber: 'F1002' } }) })
    expect(sameInvoiceItems([page('page-1'), number]).size).toBe(0)
    const supplier = page('page-2', { extracted_data: reading({ documentKind: 'supplier_invoice', supplier: { name: 'Annan AB' }, invoice: { invoiceNumber: 'F 1001' } }) })
    expect(sameInvoiceItems([page('page-1'), supplier]).size).toBe(0)
    const date = page('page-2', { extracted_data: reading({ documentKind: 'supplier_invoice', supplier: { name: 'Bygg & Co AB' }, invoice: { invoiceNumber: 'F 1001', invoiceDate: '2026-10-15' } }) })
    expect(sameInvoiceItems([page('page-1'), date]).size).toBe(0)
  })

  it('never groups a receipt, a credit note, an unread item or one routed to Arkiv', () => {
    const receipt = page('page-2', { extracted_data: reading({ documentKind: 'receipt', supplier: { name: 'Bygg & Co AB' }, invoice: { invoiceNumber: 'F 1001' } }) })
    expect(sameInvoiceItems([page('page-1'), receipt]).size).toBe(0)
    const credit = page('page-2', { extracted_data: reading({ documentKind: 'credit_note', supplier: { name: 'Bygg & Co AB' }, invoice: { invoiceNumber: 'F 1001' } }) })
    expect(sameInvoiceItems([page('page-1'), credit]).size).toBe(0)
    expect(sameInvoiceItems([page('page-1'), page('page-2', { extracted_data: null })]).size).toBe(0)
    expect(sameInvoiceItems([page('page-1'), page('page-2', { routed_to_arkiv_at: '2026-11-01T10:00:00Z' })]).size).toBe(0)
  })

  it('needs a number: two invoices of one supplier without one are not the same invoice', () => {
    const noNumber = (id: string) => page(id, { extracted_data: reading({ documentKind: 'supplier_invoice', supplier: { name: 'Bygg & Co AB' }, invoice: { invoiceDate: '2026-09-15' } }) })
    expect(sameInvoiceItems([noNumber('page-1'), noNumber('page-2')]).size).toBe(0)
  })

  it('names no handled one when two of the group are handled already', () => {
    const result = sameInvoiceItems([
      page('page-1'),
      page('page-2', { created_journal_entry_id: 'je-1' }),
      page('page-3', { created_supplier_invoice_id: 'si-1' }),
    ])
    expect(result.get('page-1')).toEqual({ item_ids: ['page-2', 'page-3'], handled_item_id: null })
  })
})
