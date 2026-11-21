import { describe, expect, it } from 'vitest'
import { buildCreditNoteItem } from '@/lib/invoices/build-credit-note-item'
import { buildDetailVatRows } from '@/lib/invoices/detail-vat-rows'
import type { InvoiceItem } from '@/types'

function item(overrides: Partial<InvoiceItem>): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    description: 'Arbete',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    created_at: '2026-11-01T00:00:00Z',
    ...overrides,
  }
}

// 1 000 kr at 25 % and 2 000 kr at 12 %: moms 250 kr and 240 kr.
const original = [
  item({ id: 'a', sort_order: 0 }),
  item({ id: 'b', sort_order: 1, unit_price: 2000, line_total: 2000, vat_rate: 12, vat_amount: 240 }),
]

const base = { registeredFromBooks: false, headerVatRate: null, vatRegistered: true }

describe('buildDetailVatRows', () => {
  it('shows a kreditfaktura its negative moms per rate, not "Moms 0"', () => {
    const creditItems = original.map((line) => buildCreditNoteItem('credit-1', line))

    const rows = buildDetailVatRows({ ...base, items: creditItems, headerVatAmount: -490 })

    expect(rows).toEqual([
      { key: '25', rate: 25, amount: -250 },
      { key: '12', rate: 12, amount: -240 },
    ])
  })

  it('shows the original invoice its moms per rate, highest rate first', () => {
    const rows = buildDetailVatRows({ ...base, items: original, headerVatAmount: 490 })

    expect(rows).toEqual([
      { key: '25', rate: 25, amount: 250 },
      { key: '12', rate: 12, amount: 240 },
    ])
  })

  it('drops a rate whose moms nets to zero', () => {
    const rows = buildDetailVatRows({
      ...base,
      items: [
        item({ id: 'a' }),
        item({ id: 'b', line_total: -1000, vat_amount: -250 }),
        item({ id: 'c', line_total: 2000, vat_rate: 12, vat_amount: 240 }),
      ],
      headerVatAmount: 240,
    })

    expect(rows).toEqual([{ key: '12', rate: 12, amount: 240 }])
  })

  it('recomputes a legacy row that stores no line VAT', () => {
    const rows = buildDetailVatRows({
      ...base,
      items: [item({ vat_amount: 0 })],
      headerVatAmount: 250,
    })

    expect(rows).toEqual([{ key: '25', rate: 25, amount: 250 }])
  })

  it('shows a kreditfaktura registered from the books the negative moms its header holds', () => {
    const rows = buildDetailVatRows({
      ...base,
      items: [],
      registeredFromBooks: true,
      headerVatAmount: -250,
      headerVatRate: 25,
    })

    expect(rows).toEqual([{ key: 'header', rate: 25, amount: -250 }])
  })

  it('gives a seller who is not VAT registered no VAT row on a zero-VAT invoice', () => {
    const rows = buildDetailVatRows({
      ...base,
      items: [item({ vat_rate: 0, vat_amount: 0 })],
      headerVatAmount: 0,
      vatRegistered: false,
    })

    expect(rows).toEqual([])
  })

  it('prints one plain "Moms 0" row when a registered seller charges none', () => {
    const rows = buildDetailVatRows({
      ...base,
      items: [item({ vat_rate: 0, vat_amount: 0 })],
      headerVatAmount: 0,
    })

    expect(rows).toEqual([{ key: 'zero', rate: null, amount: 0 }])
  })
})
