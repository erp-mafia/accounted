import { describe, it, expect } from 'vitest'
import { mapSalesInvoice, mapSupplierInvoice } from '../entity-mapper'
import { mapBLToSalesInvoice, mapBLToSupplierInvoice } from '@/lib/providers/bjornlunden/mapper'
import { mapBokioToSalesInvoice } from '@/lib/providers/bokio/mapper'
import { mapBrioxToSalesInvoice, mapBrioxToSupplierInvoice } from '@/lib/providers/briox/mapper'
import { mapFortnoxToSupplierInvoice } from '@/lib/providers/fortnox/mapper'
import type { InvoiceStatusCode, PartyDto, SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'

/**
 * One reading of paid, part paid and open on both registers: the same
 * provider answer through the sales and the supplier door gives the same
 * amounts, and a row's status never contradicts them.
 */
const party: PartyDto = { name: 'Part AB', identifications: [] }
const SEK = 'SEK'

interface Answer {
  status: InvoiceStatusCode
  paid: boolean
  balance: number
  total?: number
  source?: 'enum' | 'balance'
  lastPaymentDate?: string
}

function header(answer: Answer) {
  const total = answer.total ?? 1000
  return {
    id: '1',
    invoiceNumber: '100',
    issueDate: '2026-01-10',
    dueDate: '2026-02-10',
    currencyCode: SEK,
    status: answer.status,
    supplier: party,
    lines: [],
    taxTotal: { taxAmount: { value: total * 0.2, currencyCode: SEK } },
    legalMonetaryTotal: {
      lineExtensionAmount: { value: total * 0.8, currencyCode: SEK },
      payableAmount: { value: total, currencyCode: SEK },
    },
    paymentStatus: {
      paid: answer.paid,
      balance: { value: answer.balance, currencyCode: SEK },
      source: answer.source,
      lastPaymentDate: answer.lastPaymentDate,
    },
  }
}

const sales = (answer: Answer) =>
  mapSalesInvoice({ ...header(answer), customer: party } as SalesInvoiceDto, 'u', 'c', 'cust').invoice
const supplier = (answer: Answer) =>
  mapSupplierInvoice({ ...header(answer), buyer: party } as SupplierInvoiceDto, 'u', 'c', 'sup').invoice

const money = (row: Record<string, unknown>) => ({
  paid_amount: row.paid_amount, remaining_amount: row.remaining_amount, paid_at: row.paid_at,
})

const SAME_READING: [string, Answer][] = [
  ['nothing left, no enum', { status: 'booked', paid: false, balance: 0 }],
  ['a residual öre', { status: 'sent', paid: false, balance: 0.004 }],
  ['paid flag beside an open lifecycle', { status: 'booked', paid: true, balance: 0, lastPaymentDate: '2026-02-05' }],
  ['paid flag whatever the balance', { status: 'sent', paid: true, balance: 1000 }],
  ['part paid', { status: 'booked', paid: false, balance: 300, lastPaymentDate: '2026-02-05' }],
  ['lifecycle paid with the money fields silent', { status: 'paid', paid: false, balance: 1000 }],
  ['unpaid enum beside a zero balance', { status: 'booked', paid: false, balance: 0, source: 'enum' }],
  ['overpaid', { status: 'booked', paid: false, balance: -200 }],
  ['balance above the total', { status: 'booked', paid: false, balance: 1200 }],
  ['an unissued document, as documentPayment hands it on', { status: 'draft', paid: false, balance: 1000 }],
  ['a fallback draft with a part payment', { status: 'draft', paid: false, balance: 250, lastPaymentDate: '2026-02-05' }],
  ['a voided document', { status: 'cancelled', paid: true, balance: 0, lastPaymentDate: '2026-02-05' }],
]

describe('the sales and the supplier door read one answer alike', () => {
  it.each(SAME_READING)('%s', (_name, answer) => {
    expect(money(sales(answer))).toEqual(money(supplier(answer)))
  })
})

describe('a row never contradicts itself', () => {
  it('nothing left on a real total, no enum: paid on both registers', () => {
    for (const row of [sales({ status: 'booked', paid: false, balance: 0 }), supplier({ status: 'booked', paid: false, balance: 0 })]) {
      expect(row).toMatchObject({ status: 'paid', paid_amount: 1000, remaining_amount: 0 })
    }
  })

  it('the provider says paid in its lifecycle and nothing in its money fields: paid in full', () => {
    for (const row of [sales({ status: 'paid', paid: false, balance: 1000 }), supplier({ status: 'paid', paid: false, balance: 1000 })]) {
      expect(row).toMatchObject({ status: 'paid', paid_amount: 1000, remaining_amount: 0 })
    }
  })

  it('a paid flag beside an open lifecycle moves a sales row to paid, as on the supplier side', () => {
    expect(sales({ status: 'sent', paid: true, balance: 0 })).toMatchObject({ status: 'paid', paid_amount: 1000, remaining_amount: 0 })
  })

  it('an unissued document settled nothing', () => {
    const unissued = mapBokioToSalesInvoice({ id: 'a', invoiceDate: '2026-01-01', totalAmount: 1000, totalTax: 200, paidAmount: 1000, status: 'draft' })
    expect(mapSalesInvoice(unissued, 'u', 'c', 'cust').invoice)
      .toMatchObject({ status: 'draft', paid_amount: 0, remaining_amount: 1000, paid_at: null })
    expect(supplier({ status: 'draft', paid: false, balance: 1000 }))
      .toMatchObject({ status: 'registered', paid_amount: 0, remaining_amount: 1000, paid_at: null })
  })

  it('a draft that is only a mapper\'s fallback keeps its part payment on both registers', () => {
    const fortnox = mapFortnoxToSupplierInvoice({ GivenNumber: 7, InvoiceDate: '2026-01-01', Total: 1250, TotalVAT: 250, Balance: 250, Booked: false })
    expect(fortnox.status).toBe('draft')
    expect(mapSupplierInvoice(fortnox, 'u', 'c', 'sup').invoice)
      .toMatchObject({ status: 'partially_paid', paid_amount: 1000, remaining_amount: 250 })

    const briox = { id: 1, invoice_date: '2026-01-01', total_amount: 1250, vat_amount: 250, balance: 250 }
    expect(mapSupplierInvoice(mapBrioxToSupplierInvoice(briox), 'u', 'c', 'sup').invoice)
      .toMatchObject({ status: 'partially_paid', paid_amount: 1000, remaining_amount: 250 })
    expect(mapSalesInvoice(mapBrioxToSalesInvoice(briox), 'u', 'c', 'cust').invoice)
      .toMatchObject({ status: 'partially_paid', paid_amount: 1000, remaining_amount: 250 })
  })

  it('Bokio with a status it does not know: the money decides, and the row agrees with it', () => {
    const dto = mapBokioToSalesInvoice({ id: 'a', invoiceNumber: 5, invoiceDate: '2026-01-01', totalAmount: 1250, totalTax: 250, paidAmount: 1250, status: 'somethingNew' })
    expect(mapSalesInvoice(dto, 'u', 'c', 'cust').invoice).toMatchObject({ status: 'paid', paid_amount: 1250, remaining_amount: 0 })
  })

  it('a voided document neither collected nor owes anything', () => {
    expect(sales({ status: 'cancelled', paid: false, balance: 1000 })).toMatchObject({ status: 'cancelled', paid_amount: 0, remaining_amount: 0, paid_at: null })
    expect(supplier({ status: 'cancelled', paid: false, balance: 1000 })).toMatchObject({ status: 'credited', paid_amount: 0, remaining_amount: 0, paid_at: null })
  })

  it('an original the provider credited stays credited, whatever its money fields say', () => {
    expect(sales({ status: 'credited', paid: true, balance: 0 }).status).toBe('credited')
    expect(supplier({ status: 'credited', paid: true, balance: 0 }).status).toBe('credited')
    expect(sales({ status: 'credited', paid: false, balance: 300 }).status).toBe('credited')
    expect(supplier({ status: 'credited', paid: false, balance: 300 }).status).toBe('credited')
  })

  it('a part payment carries no paid date on either register: paid_at is the day it was paid in full', () => {
    expect(sales({ status: 'sent', paid: false, balance: 300, lastPaymentDate: '2026-02-05' }))
      .toMatchObject({ status: 'partially_paid', paid_amount: 700, remaining_amount: 300, paid_at: null })
    expect(supplier({ status: 'booked', paid: false, balance: 300, lastPaymentDate: '2026-02-05' }))
      .toMatchObject({ status: 'partially_paid', paid_amount: 700, remaining_amount: 300, paid_at: null })
  })
})

describe('provider payloads whose lifecycle says paid and whose money fields do not', () => {
  it('Bokio: status paid with no paidAmount', () => {
    const dto = mapBokioToSalesInvoice({ id: 'a', invoiceNumber: 5, invoiceDate: '2026-01-01', totalAmount: 1000, totalTax: 200, status: 'paid' })
    expect(dto.paymentStatus).toMatchObject({ paid: true, balance: { value: 0 } })
    expect(mapSalesInvoice(dto, 'u', 'c', 'cust').invoice).toMatchObject({ status: 'paid', paid_amount: 1000, remaining_amount: 0 })
  })

  it('Björn Lundén: status code 2 with no amounts, on both registers', () => {
    const raw = { entityId: 1, invoiceNumber: 1, invoiceDate: '2026-01-01', amountInLocalCurrency: 1000, vatAmount: 200, status: [2] }
    const salesDto = mapBLToSalesInvoice(raw)
    const supplierDto = mapBLToSupplierInvoice(raw)
    expect(salesDto.paymentStatus).toMatchObject({ paid: true, balance: { value: 0 } })
    expect(supplierDto.paymentStatus).toMatchObject({ paid: true, balance: { value: 0 } })
    expect(mapSalesInvoice(salesDto, 'u', 'c', 'cust').invoice).toMatchObject({ status: 'paid', paid_amount: 1000, remaining_amount: 0 })
    expect(mapSupplierInvoice(supplierDto, 'u', 'c', 'sup').invoice).toMatchObject({ status: 'paid', paid_amount: 1000, remaining_amount: 0 })
  })

  it('Björn Lundén: the paid flag alone settles the supplier row too', () => {
    const raw = { entityId: 1, invoiceNumber: 1, invoiceDate: '2026-01-01', amountInLocalCurrency: 1000, vatAmount: 200, paid: true }
    expect(mapBLToSupplierInvoice(raw).paymentStatus.balance.value).toBe(0)
    expect(mapBLToSalesInvoice(raw).paymentStatus.balance.value).toBe(0)
  })
})
