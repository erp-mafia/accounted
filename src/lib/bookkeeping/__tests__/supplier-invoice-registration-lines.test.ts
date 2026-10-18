import { describe, it, expect } from 'vitest'
import type { SupplierInvoiceItem } from '@/types'
import { makeSupplierInvoice } from '@/tests/helpers'
import { supplierInvoiceRegistrationLines } from '../supplier-invoice-registration-lines'

// The kontantmetoden year-end carry (#3440) books an open supplier invoice as
// its registration verifikat with deferAccruals off: no accrual schedule
// exists under kontantmetoden, so a 17xx / 29xx balance would never dissolve.
// Every other caller keeps the default, which defers.

const DESC = 'Leverantörsfaktura LF-1 (ankomstnr 11)'
const NO_MOMSKODER = new Map()

function item(over: Partial<SupplierInvoiceItem> = {}): SupplierInvoiceItem {
  return {
    id: 'item-1',
    supplier_invoice_id: 'si-1',
    sort_order: 0,
    description: 'Rad',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    account_number: '5410',
    vat_code: null,
    vat_rate: 0.25,
    vat_amount: 250,
    reverse_charge_rate: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

const domestic = {
  invoice: makeSupplierInvoice({
    id: 'si-dom', supplier_invoice_number: 'LF-1', arrival_number: 11,
    invoice_date: '2026-11-20', subtotal: 2400, vat_amount: 562, total: 2962,
    default_dimensions: { '6': 'P1' },
  }),
  items: [
    item({ id: 'a', account_number: '5410', line_total: 1000, vat_rate: 0.25, vat_amount: 250 }),
    item({
      id: 'b', account_number: '5420', line_total: 1200, vat_rate: 0.25, vat_amount: 300,
      accrual_period_start: '2026-12-01', accrual_period_end: '2027-11-30',
      accrual_balance_account: '1790', dimensions: { '1': 'K10' },
    }),
    item({ id: 'c', account_number: '6110', line_total: 300, vat_rate: 0.12, vat_amount: 36 }),
    item({ id: 'd', account_number: '5410', line_total: -100, vat_rate: 0.25, vat_amount: -25 }),
  ],
}

const sum = (lines: Array<{ debit_amount: number; credit_amount: number }>, side: 'debit_amount' | 'credit_amount') =>
  Math.round(lines.reduce((s, l) => s + l[side], 0) * 100) / 100

describe('supplierInvoiceRegistrationLines: deferAccruals', () => {
  it('defers by default, exactly as with deferAccruals true', () => {
    const byDefault = supplierInvoiceRegistrationLines(domestic.invoice, domestic.items, 'swedish_business', DESC, undefined)
    const explicit = supplierInvoiceRegistrationLines(
      domestic.invoice, domestic.items, 'swedish_business', DESC, undefined, { deferAccruals: true },
    )
    expect(explicit).toEqual(byDefault)
    expect(byDefault.some((l) => l.account_number === '1790')).toBe(true)
  })

  it('books a periodiserad row on its own cost account when deferAccruals is false', () => {
    const deferred = supplierInvoiceRegistrationLines(domestic.invoice, domestic.items, 'swedish_business', DESC, undefined)
    const carried = supplierInvoiceRegistrationLines(
      domestic.invoice, domestic.items, 'swedish_business', DESC, undefined, { deferAccruals: false },
    )
    expect(carried.some((l) => l.account_number.startsWith('17'))).toBe(false)
    expect(carried.find((l) => l.account_number === '5420')).toMatchObject({
      debit_amount: 1200,
      credit_amount: 0,
      dimensions: { '6': 'P1', '1': 'K10' },
    })
    // Only the account moves: moms, 2440, the other rows and the totals stay.
    const rest = (lines: typeof carried) => lines.filter((l) => !['1790', '5420'].includes(l.account_number))
    expect(rest(carried)).toEqual(rest(deferred))
    expect(sum(carried, 'debit_amount')).toBe(sum(carried, 'credit_amount'))
    expect(sum(carried, 'debit_amount')).toBe(sum(deferred, 'debit_amount'))
  })

  it('groups a reverse-charge row on its own account when deferAccruals is false', () => {
    const invoice = makeSupplierInvoice({
      id: 'si-rc', supplier_invoice_number: 'LF-RC', arrival_number: 12,
      invoice_date: '2026-11-21', subtotal: 1000, vat_amount: 0, total: 1000,
      reverse_charge: true, vat_treatment: 'reverse_charge',
    })
    const items = [
      item({
        id: 'e', account_number: '6540', line_total: 1000, vat_rate: 0, vat_amount: 0, reverse_charge_rate: 0.25,
        accrual_period_start: '2026-12-01', accrual_period_end: '2027-05-31', accrual_balance_account: '1790',
      }),
    ]
    const carried = supplierInvoiceRegistrationLines(invoice, items, 'eu_business', DESC, NO_MOMSKODER, {
      deferAccruals: false,
    })
    expect(carried.some((l) => l.account_number.startsWith('17'))).toBe(false)
    expect(carried.find((l) => l.account_number === '6540')).toMatchObject({ debit_amount: 1000 })
    // The fiktiv moms pair is unchanged by where the cost lands.
    const deferred = supplierInvoiceRegistrationLines(invoice, items, 'eu_business', DESC, NO_MOMSKODER)
    const vat = (lines: typeof carried) => lines.filter((l) => l.account_number.startsWith('26'))
    expect(vat(carried)).toEqual(vat(deferred))
    expect(vat(carried).length).toBeGreaterThan(0)
    expect(sum(carried, 'debit_amount')).toBe(sum(carried, 'credit_amount'))
  })
})
