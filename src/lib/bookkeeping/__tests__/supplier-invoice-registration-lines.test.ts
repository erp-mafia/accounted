import { describe, it, expect } from 'vitest'
import type { SupplierInvoiceItem } from '@/types'
import { makeSupplierInvoice } from '@/tests/helpers'
import { supplierInvoiceRegistrationLines, supplierInvoiceReverseChargeAccountConflict } from '../supplier-invoice-registration-lines'

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

// crm#1323: the kind followed the supplier type alone, so an EU supplier's
// goods booked the services basis (4535, ruta 21). The invoice now says goods.
describe('supplierInvoiceRegistrationLines: EU goods or services', () => {
  const rcInvoice = (kind: 'eu_goods' | 'eu_services' | null) => makeSupplierInvoice({
    id: 'si-eu', supplier_invoice_number: 'LF-EU', arrival_number: 13,
    invoice_date: '2026-11-22', subtotal: 1000, vat_amount: 0, total: 1000,
    reverse_charge: true, vat_treatment: 'reverse_charge', reverse_charge_kind: kind,
  })
  const rcItems = [item({ id: 'f', account_number: '4010', line_total: 1000, vat_rate: 0, vat_amount: 0, reverse_charge_rate: 0.25 })]
  const accounts = (lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>) =>
    lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

  it('books goods on 4515/4598 (ruta 20) with the same fiktiv moms', () => {
    const lines = supplierInvoiceRegistrationLines(rcInvoice('eu_goods'), rcItems, 'eu_business', DESC, NO_MOMSKODER)
    expect(accounts(lines)).toEqual([
      ['4010', 1000, 0],
      ['2645', 250, 0],
      ['2614', 0, 250],
      ['4515', 1000, 0],
      ['4598', 0, 1000],
      ['2440', 0, 1000],
    ])
  })

  it('books services on 4535/4598 (ruta 21) when the invoice says services or nothing, as before', () => {
    const none = supplierInvoiceRegistrationLines(rcInvoice(null), rcItems, 'eu_business', DESC, NO_MOMSKODER)
    const services = supplierInvoiceRegistrationLines(rcInvoice('eu_services'), rcItems, 'eu_business', DESC, NO_MOMSKODER)
    expect(services).toEqual(none)
    expect(none.find((l) => l.account_number === '4535')).toMatchObject({ debit_amount: 1000 })
    expect(none.some((l) => l.account_number === '4515')).toBe(false)
  })

  it('ignores the kind for a supplier outside the EU: its type decides', () => {
    const lines = supplierInvoiceRegistrationLines(rcInvoice('eu_goods'), rcItems, 'non_eu_business', DESC, NO_MOMSKODER)
    expect(lines.find((l) => l.account_number === '4531')).toMatchObject({ debit_amount: 1000 })
    expect(lines.some((l) => l.account_number === '4515')).toBe(false)
  })
})

// A reverse-charge line on an account that declares the purchase in a box of
// its own kept the basis pair beside it: 4545 (ruta 50) with 4531/4598 (ruta
// 22), so one purchase was declared twice. The doors refuse such a line
// (reverseChargeAccountRefusal) by this predicate.
describe('supplierInvoiceReverseChargeAccountConflict', () => {
  const rcInvoice = makeSupplierInvoice({
    id: 'si-rc-box', supplier_invoice_number: 'LF-BOX', arrival_number: 14,
    invoice_date: '2026-11-22', subtotal: 1000, vat_amount: 0, total: 1000,
    reverse_charge: true, vat_treatment: 'reverse_charge',
  })
  const rcItem = (account: string) =>
    item({ id: 'g', account_number: account, line_total: 1000, vat_rate: 0, vat_amount: 0, reverse_charge_rate: 0.25 })
  const chart = new Map([
    ['4010', { default_vat_treatment: 'import_goods', default_vat_rate: 0.25 }],
    ['4020', { default_vat_treatment: 'triangulation_eu_goods', default_vat_rate: null }],
    ['5420', { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0 }],
    ['6540', { default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0.25 }],
  ])

  it.each([
    ['4545', { reason: 'other_box', box: 'ruta50' }],
    ['4546', { reason: 'other_box', box: 'ruta50' }],
    ['4512', { reason: 'other_box', box: 'ruta37' }],
    ['4598', { reason: 'basis_offset' }],
    ['4010', { reason: 'other_box', box: 'ruta50' }],
    ['4020', { reason: 'other_box', box: 'ruta37' }],
    ['5420', { reason: 'no_rate' }],
  ])('names %s as a line that cannot take the reverse charge', (account, conflict) => {
    expect(supplierInvoiceReverseChargeAccountConflict([rcItem('6110'), rcItem(account)], chart)).toEqual({
      index: 1, account, conflict,
    })
  })

  it.each(['6110', '6540', '4531', '4535', '4011', '1930', '3740'])(
    'lets %s take it',
    (account) => {
      expect(supplierInvoiceReverseChargeAccountConflict([rcItem(account)], chart)).toBeNull()
    },
  )

  it('books 4531 in its own ruta 22 without the pair, and 6110 with it, as before', () => {
    const own = supplierInvoiceRegistrationLines(rcInvoice, [rcItem('4531')], 'non_eu_business', DESC, NO_MOMSKODER)
    expect(own.map((l) => l.account_number)).toEqual(['4531', '2645', '2614', '2440'])
    const paired = supplierInvoiceRegistrationLines(rcInvoice, [rcItem('6110')], 'non_eu_business', DESC, NO_MOMSKODER)
    expect(paired.map((l) => l.account_number)).toEqual(['6110', '2645', '2614', '4531', '4598', '2440'])
  })
})
