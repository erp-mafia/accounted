import { describe, it, expect } from 'vitest'
import { mapFortnoxToSalesInvoice, mapFortnoxToSupplierInvoice } from '../fortnox/mapper'
import { mapVismaToSalesInvoice, mapVismaToSupplierInvoice } from '../visma/mapper'
import { mapBrioxToSalesInvoice, mapBrioxToSupplierInvoice } from '../briox/mapper'
import { mapBLToSalesInvoice, mapBLToSupplierInvoice } from '../bjornlunden/mapper'
import { mapBokioToCreditNote, mapBokioToSalesInvoice, mapBokioToSupplierInvoice } from '../bokio/mapper'
import { mapWintToSalesInvoice } from '../wint/mapper'
import type { SalesInvoiceDto, SupplierInvoiceDto } from '../dto'

/**
 * The same document through every mapper: each door reads what a document IS
 * through documentState, so the provider's fields decide the facts and one
 * rule decides the answer. Wire-shaped payloads, one per provider.
 */
type Door = [name: string, dto: SalesInvoiceDto | SupplierInvoiceDto]

const DATE = '2026-01-01'

describe('every provider door: an unissued document', () => {
  const unissued: Door[] = [
    ['fortnox sales', mapFortnoxToSalesInvoice({ DocumentNumber: 1, InvoiceDate: DATE, Total: 1000, Balance: 0, Sent: false, Booked: false })],
    ['wint sales', mapWintToSalesInvoice({ Id: 1, PostingDate: DATE, TotalAmount: 1000, LeftToPay: 0, Status: 'NotSent' })],
    ['briox sales', mapBrioxToSalesInvoice({ id: 1, invoice_date: DATE, total_amount: 1000, balance: 0, status: 'draft' })],
    ['briox supplier', mapBrioxToSupplierInvoice({ id: 1, invoice_date: DATE, total_amount: 1000, balance: 0, status: 'draft' })],
    ['bl sales', mapBLToSalesInvoice({ entityId: 1, invoiceNumber: 1, invoiceDate: DATE, amountInLocalCurrency: 1000, amountPaidInLocalCurrency: 1000, preliminary: true })],
    ['bl supplier', mapBLToSupplierInvoice({ entityId: 1, invoiceNumber: 1, invoiceDate: DATE, amountInLocalCurrency: 1000, amountPaidInLocalCurrency: 1000, preliminary: true })],
    ['bokio sales', mapBokioToSalesInvoice({ id: 'a', invoiceDate: DATE, totalAmount: 1000, paidAmount: 1000, status: 'draft' })],
    ['visma supplier', mapVismaToSupplierInvoice({ Id: 1, InvoiceDate: DATE, TotalAmount: 1000, RemainingAmount: 0, Status: 0 })],
  ]

  it.each(unissued)('%s is a draft that owes its whole total, whatever its balance says', (_name, dto) => {
    expect(dto.status).toBe('draft')
    expect(dto.paymentStatus.paid).toBe(false)
    expect(dto.paymentStatus.balance.value).toBe(1000)
  })

  const unissuedCredit: Door[] = [
    ['fortnox sales', mapFortnoxToSalesInvoice({ DocumentNumber: 1, InvoiceDate: DATE, Total: -100, Sent: false, Booked: false })],
    ['wint sales', mapWintToSalesInvoice({ Id: 1, SerialNumber: 5, PostingDate: DATE, TotalAmount: -100, Status: 'NotSent' })],
    ['bl sales', mapBLToSalesInvoice({ entityId: 1, invoiceNumber: 1, invoiceDate: DATE, amountInLocalCurrency: -100, preliminary: true })],
    ['bl supplier', mapBLToSupplierInvoice({ entityId: 1, invoiceNumber: 1, invoiceDate: DATE, amountInLocalCurrency: -100, preliminary: true })],
    ['bokio credit note', mapBokioToCreditNote({ id: 'a', creditDate: DATE, totalAmount: 100, status: 'draft' })],
    ['briox sales', mapBrioxToSalesInvoice({ id: 1, invoice_date: DATE, total_amount: -100, status: 'draft' })],
    ['briox supplier', mapBrioxToSupplierInvoice({ id: 1, invoice_date: DATE, total_amount: -100, status: 'draft' })],
    ['visma supplier', mapVismaToSupplierInvoice({ Id: 1, InvoiceNumber: 1, InvoiceDate: DATE, TotalAmount: -100, Status: 0 })],
  ]

  it.each(unissuedCredit)('%s: an unissued credit note is a credit note and stays a draft', (_name, dto) => {
    expect(dto.invoiceTypeCode).toBe('381')
    expect(dto.status).toBe('draft')
  })

  const paidAnyway: Door[] = [
    ['fortnox sales', mapFortnoxToSalesInvoice({ DocumentNumber: 1, InvoiceDate: DATE, Total: 1000, Sent: false, Booked: false, FullyPaid: true })],
    ['wint sales', mapWintToSalesInvoice({ Id: 1, PostingDate: DATE, TotalAmount: 1000, Status: 'NotSent', PaymentState: 'Paid' })],
    ['briox sales', mapBrioxToSalesInvoice({ id: 1, invoice_date: DATE, total_amount: 1000, status: 'draft', fully_paid: true })],
    ['bl sales', mapBLToSalesInvoice({ entityId: 1, invoiceNumber: 1, invoiceDate: DATE, amountInLocalCurrency: 1000, preliminary: true, paid: true })],
    ['bl supplier, by its status code', mapBLToSupplierInvoice({ entityId: 1, invoiceNumber: 1, invoiceDate: DATE, amountInLocalCurrency: 1000, preliminary: true, status: [2] })],
    ['visma supplier', mapVismaToSupplierInvoice({ Id: 1, InvoiceDate: DATE, TotalAmount: 1000, Status: 0, PaymentStatus: 6 })],
  ]

  it.each(paidAnyway)('%s: a stated payment is no balance, it says the document went out', (_name, dto) => {
    expect(dto.status).toBe('paid')
    expect(dto.paymentStatus.paid).toBe(true)
  })

  const partPaidAnyway: Door[] = [
    ['wint sales', mapWintToSalesInvoice({ Id: 1, PostingDate: DATE, TotalAmount: 1000, LeftToPay: 250, Status: 'NotSent', PaymentState: 'PartiallyPaid' })],
    ['bl supplier', mapBLToSupplierInvoice({ entityId: 1, invoiceNumber: 1, invoiceDate: DATE, amountInLocalCurrency: 1000, amountPaidInLocalCurrency: 750, preliminary: true, status: [3] })],
    ['visma supplier', mapVismaToSupplierInvoice({ Id: 1, InvoiceDate: DATE, TotalAmount: 1000, RemainingAmount: 250, Status: 0, PaymentStatus: 5 })],
  ]

  it.each(partPaidAnyway)('%s: a stated part payment says so too, and its money stays', (_name, dto) => {
    expect(dto.status).not.toBe('draft')
    expect(dto.paymentStatus.balance.value).toBe(250)
  })

  it('a stated payment on no amount says nothing: Fortnox flags a 0 kr draft (crm#1245)', () => {
    expect(mapFortnoxToSalesInvoice({ DocumentNumber: 1, Total: 0, Balance: 0, Sent: false, Booked: false, FullyPaid: true }).status).toBe('draft')
  })

  it('WINT: an invoice credited since was issued, whatever its send status says', () => {
    expect(mapWintToSalesInvoice({ Id: 1, TotalAmount: 1000, Status: 'NotSent', CreditStatus: 'Credited' }).status).toBe('credited')
  })

  it('Briox: only a stated draft with nothing saying it went out reads as unissued (its draft payloads are unverified)', () => {
    expect(mapBrioxToSalesInvoice({ id: 1, invoice_date: DATE, total_amount: 1000, balance: 1000, status: 'draft', booked: true }).status).toBe('booked')
    expect(mapBrioxToSalesInvoice({ id: 1, invoice_date: DATE, total_amount: 1000, balance: 1000, status: 'draft', sent: true }).status).toBe('sent')
  })
})

describe('every provider door: a negative total is a credit note', () => {
  const negative: Door[] = [
    ['fortnox sales', mapFortnoxToSalesInvoice({ DocumentNumber: 1, Total: -100 })],
    ['fortnox supplier', mapFortnoxToSupplierInvoice({ GivenNumber: 1, Total: -100 })],
    ['briox sales', mapBrioxToSalesInvoice({ id: 1, total_amount: -100 })],
    ['briox supplier', mapBrioxToSupplierInvoice({ id: 1, total_amount: -100 })],
    ['bl sales', mapBLToSalesInvoice({ entityId: 1, amountInLocalCurrency: -100 })],
    ['bl supplier', mapBLToSupplierInvoice({ entityId: 1, amountInLocalCurrency: -100 })],
    ['wint sales', mapWintToSalesInvoice({ Id: 1, TotalAmount: -100 })],
    ['visma sales', mapVismaToSalesInvoice({ Id: 1, TotalAmount: -100, PaymentStatus: 1 })],
    ['visma supplier', mapVismaToSupplierInvoice({ Id: 1, TotalAmount: -100 })],
    ['bokio sales', mapBokioToSalesInvoice({ id: 'a', totalAmount: -100, status: 'published' })],
    ['bokio supplier', mapBokioToSupplierInvoice({ id: 'a', totalAmount: -100 })],
  ]

  it.each(negative)('%s is typed 381 and reads credited, with no provider flag', (_name, dto) => {
    expect(dto.invoiceTypeCode).toBe('381')
    expect(dto.status).toBe('credited')
  })
})

describe('every provider door: a voided document', () => {
  const voided: Door[] = [
    ['fortnox sales, unsent too', mapFortnoxToSalesInvoice({ DocumentNumber: 1, Total: -100, Balance: 0, Sent: false, Booked: false, Cancelled: true })],
    ['fortnox supplier, the list form spells it Cancel', mapFortnoxToSupplierInvoice({ GivenNumber: 1, Total: 1000, Balance: 0, Cancel: true })],
    ['fortnox supplier, the detail form spells it Cancelled', mapFortnoxToSupplierInvoice({ GivenNumber: 1, Total: 1000, Balance: 0, Cancelled: true })],
    ['wint sales', mapWintToSalesInvoice({ Id: 1, TotalAmount: -100, Status: 'Cancelled' })],
    ['briox sales', mapBrioxToSalesInvoice({ id: 1, total_amount: -100, status: 'cancelled' })],
    ['bl sales, preliminary too', mapBLToSalesInvoice({ entityId: 1, amountInLocalCurrency: -100, status: [5], preliminary: true })],
    ['bl supplier', mapBLToSupplierInvoice({ entityId: 1, amountInLocalCurrency: -100, status: [6] })],
    ['bl sales, a plain status string', mapBLToSalesInvoice({ entityId: 1, amountInLocalCurrency: 1000, paid: true, status: 'cancelled' })],
    ['visma sales', mapVismaToSalesInvoice({ Id: 1, TotalAmount: -100, IsCancelled: true })],
    ['visma supplier', mapVismaToSupplierInvoice({ Id: 1, TotalAmount: -100, Status: 2 })],
    ['bokio sales', mapBokioToSalesInvoice({ id: 'a', totalAmount: -100, status: 'cancelled' })],
  ]

  it.each(voided)('%s stays cancelled ahead of draft and credit', (_name, dto) => {
    expect(dto.status).toBe('cancelled')
  })
})

describe('a status that describes the ORIGINAL keeps it an invoice', () => {
  const originals: Door[] = [
    ['bokio credited', mapBokioToSalesInvoice({ id: 'a', totalAmount: 1000, paidAmount: 0, status: 'credited' })],
    ['wint CreditStatus', mapWintToSalesInvoice({ Id: 1, TotalAmount: 1000, CreditStatus: 'Credited' })],
    ['briox credited', mapBrioxToSalesInvoice({ id: 1, total_amount: 1000, status: 'credited' })],
  ]

  it.each(originals)('%s reads credited and is never typed 381', (_name, dto) => {
    expect(dto.status).toBe('credited')
    expect(dto.invoiceTypeCode).toBeUndefined()
  })
})
