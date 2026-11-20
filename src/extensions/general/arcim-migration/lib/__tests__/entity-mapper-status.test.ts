import { describe, it, expect } from 'vitest'
import { mapSalesInvoice, mapSupplierInvoice } from '../entity-mapper'
import { mapFortnoxToSalesInvoice } from '@/lib/providers/fortnox/mapper'
import type { SalesInvoiceDto, SupplierInvoiceDto, InvoiceStatusCode, PartyDto } from '@/lib/providers/dto'

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
  source?: 'enum' | 'balance'
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
      source: over.source,
    },
  }
}

function map(over: Parameters<typeof makeDto>[0]) {
  return mapSupplierInvoice(makeDto(over), 'user-1', 'company-1', 'supplier-1').invoice
}

function makeSalesDto(over: {
  status?: InvoiceStatusCode
  paid?: boolean
  balance?: number
  total?: number
  lastPaymentDate?: string
  source?: 'enum' | 'balance'
}): SalesInvoiceDto {
  const total = over.total ?? 1000
  return {
    id: 'inv-1',
    invoiceNumber: '100',
    issueDate: '2026-01-10',
    dueDate: '2026-02-10',
    currencyCode: 'SEK',
    status: over.status ?? 'booked',
    supplier: party,
    customer: party,
    lines: [],
    legalMonetaryTotal: {
      lineExtensionAmount: { value: total, currencyCode: 'SEK' },
      payableAmount: { value: total, currencyCode: 'SEK' },
    },
    paymentStatus: {
      paid: over.paid ?? false,
      balance: { value: over.balance ?? total, currencyCode: 'SEK' },
      lastPaymentDate: over.lastPaymentDate,
      source: over.source,
    },
  }
}

function mapSales(over: Parameters<typeof makeSalesDto>[0]) {
  return mapSalesInvoice(makeSalesDto(over), 'user-1', 'company-1', 'customer-1').invoice
}

describe('mapSupplierInvoice: status/paid consistency', () => {
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
    // No provider date in the fixture: the date is unknown, not the issue date.
    expect(inv.paid_at).toBeNull()
  })

  it('a partial payment carries no paid date, as natively: paid_at is the day it was paid in full', () => {
    const inv = map({ status: 'booked', paid: false, balance: 300, total: 1000, lastPaymentDate: '2026-02-05' })
    expect(inv.status).toBe('partially_paid')
    expect(inv.paid_at).toBeNull()
  })

  it('credit note with zero balance stays credited: never flipped to paid', () => {
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

/**
 * A company migrated from Visma (2026-09-10): 582 supplier invoices imported, 0
 * open, although Visma reported 53 as unpaid. The mapper combined two
 * independent signals with OR (`paid || balance <= 0`), so a zero balance
 * beside an explicit unpaid enum forced 'paid'. When the flag came from the
 * enum (paymentStatus.source === 'enum') the balance may not override it.
 */
describe('mapSupplierInvoice: an explicit unpaid enum is never overridden by a zero balance', () => {
  it('paid=false from the enum with balance 0 lands as registered, remaining = total, paid_at null', () => {
    const inv = map({ status: 'booked', paid: false, balance: 0, total: 1000, source: 'enum' })
    expect(inv.status).toBe('registered')
    expect(inv.remaining_amount).toBe(1000)
    expect(inv.paid_amount).toBe(0)
    expect(inv.paid_at).toBeNull()
  })

  it('keeps overdue when the provider lifecycle says so', () => {
    const inv = map({ status: 'overdue', paid: false, balance: 0, total: 1000, source: 'enum' })
    expect(inv.status).toBe('overdue')
    expect(inv.remaining_amount).toBe(1000)
    expect(inv.paid_amount).toBe(0)
    expect(inv.paid_at).toBeNull()
  })

  it('a positive balance beside the unpaid enum is kept as the open amount', () => {
    const inv = map({ status: 'booked', paid: false, balance: 300, total: 1000, source: 'enum' })
    expect(inv.status).toBe('partially_paid')
    expect(inv.remaining_amount).toBe(300)
    expect(inv.paid_amount).toBe(700)
  })

  it('paid=true from the enum is settled whatever the balance says', () => {
    const inv = map({ status: 'booked', paid: true, balance: 1000, total: 1000, source: 'enum' })
    expect(inv.status).toBe('paid')
    expect(inv.remaining_amount).toBe(0)
    expect(inv.paid_amount).toBe(1000)
  })

  it('a balance-derived flag keeps the drift rule: balance 0 beside paid=false still resolves to paid', () => {
    for (const source of ['balance', undefined] as const) {
      const inv = map({ status: 'booked', paid: false, balance: 0, total: 1000, source })
      expect(inv.status, `source=${source}`).toBe('paid')
      expect(inv.remaining_amount).toBe(0)
    }
  })

  it('the customer side applies the same rule', () => {
    const inv = mapSales({ status: 'booked', paid: false, balance: 0, total: 1000, source: 'enum' })
    expect(inv.status).toBe('sent')
    expect(inv.remaining_amount).toBe(1000)
    expect(inv.paid_amount).toBe(0)
    expect(inv.paid_at).toBeNull()
  })
})

/**
 * A customer invoice the customer had paid part of landed as 'sent' beside a
 * non-zero paid_amount, a state no native invoice is ever in: a native part
 * payment sets 'partially_paid' and leaves paid_at empty until the invoice is
 * fully paid (settle-invoice-payment.ts). Provider-neutral: the DTO is the
 * same for every provider.
 */
describe('mapSalesInvoice: a part-paid open invoice is partially_paid', () => {
  it.each(['sent', 'booked', 'overdue'] as InvoiceStatusCode[])(
    'lifecycle %s with 0 < paid < total → partially_paid, paid_at null',
    (status) => {
      const inv = mapSales({ status, paid: false, balance: 300, total: 1000, lastPaymentDate: '2026-02-05' })
      expect(inv.status).toBe('partially_paid')
      expect(inv.paid_amount).toBe(700)
      expect(inv.remaining_amount).toBe(300)
      expect(inv.paid_at).toBeNull()
    },
  )

  it('the same from a Visma-style enum flag beside a positive balance', () => {
    const inv = mapSales({ status: 'overdue', paid: false, balance: 0.5, total: 1000, source: 'enum' })
    expect(inv.status).toBe('partially_paid')
    expect(inv.paid_amount).toBe(999.5)
    expect(inv.remaining_amount).toBe(0.5)
  })

  it('a fully paid invoice stays paid', () => {
    const inv = mapSales({ status: 'paid', paid: true, balance: 0, total: 1000, lastPaymentDate: '2026-02-05' })
    expect(inv.status).toBe('paid')
    expect(inv.paid_at).toBe('2026-02-05')
  })

  it('an unpaid invoice keeps its lifecycle status', () => {
    expect(mapSales({ status: 'sent', paid: false, balance: 1000, total: 1000 }).status).toBe('sent')
    expect(mapSales({ status: 'overdue', paid: false, balance: 1000, total: 1000 }).status).toBe('overdue')
  })

  it('an unissued or cancelled invoice is never turned into partially_paid', () => {
    expect(mapSales({ status: 'draft', paid: false, balance: 1000, total: 1000 }).status).toBe('draft')
    expect(mapSales({ status: 'cancelled', paid: false, balance: 300, total: 1000 }).status).toBe('cancelled')
  })

  it('a credit note is never partially_paid', () => {
    const dto = makeSalesDto({ status: 'sent', paid: false, balance: 300, total: 1000 })
    dto.invoiceTypeCode = '381'
    const inv = mapSalesInvoice(dto, 'user-1', 'company-1', 'customer-1').invoice
    expect(inv.status).toBe('credited')
    expect(inv.paid_amount).toBe(0)
    expect(inv.paid_at).toBeNull()
  })
})

/**
 * Prod: Fora credit note 1188488603 landed as 'credited' with
 * remaining_amount 5905, its own total, because the amounts were derived as
 * for an unpaid invoice. The customer side already zeroes both amounts.
 */
describe('mapSupplierInvoice: kreditfaktura carries no payable amounts', () => {
  it('zeroes paid_amount and remaining_amount on a credit note the provider reports as unpaid', () => {
    const inv = map({ status: 'booked', paid: false, balance: 5905, total: 5905, invoiceTypeCode: '381' })
    expect(inv.status).toBe('credited')
    expect(inv.is_credit_note).toBe(true)
    expect(inv.remaining_amount).toBe(0)
    expect(inv.paid_amount).toBe(0)
    expect(inv.paid_at).toBeNull()
  })

  it('zeroes them on a credit note the provider reports as paid too', () => {
    const inv = map({ status: 'paid', paid: true, balance: 0, total: 5905, invoiceTypeCode: '381', lastPaymentDate: '2026-02-01' })
    expect(inv.status).toBe('credited')
    expect(inv.remaining_amount).toBe(0)
    expect(inv.paid_amount).toBe(0)
    expect(inv.paid_at).toBeNull()
  })
})

/**
 * Bokio (2026-09-14): its API returns totalAmount 0 for supplier invoices
 * older than the register it exposes. The balance rule then read 0 <= 0 as a
 * settlement and wrote 292 + 92 rows as "betald" for 0 kr, which is what made
 * the pre-2020 half of one company's import look correct. A balance may
 * declare a settlement only when there is an amount to settle.
 */
describe('mapSupplierInvoice: a zero total is an amount-less record, not a settlement', () => {
  it('total 0 with balance 0 is not paid', () => {
    const inv = map({ status: 'booked', paid: false, balance: 0, total: 0 })
    expect(inv.status).toBe('registered')
    expect(inv.paid_amount).toBe(0)
    expect(inv.remaining_amount).toBe(0)
    expect(inv.paid_at).toBeNull()
  })

  it('an explicit paid flag on a zero total is still honoured: the provider said so', () => {
    const inv = map({ status: 'booked', paid: true, balance: 0, total: 0, lastPaymentDate: '2026-02-05' })
    expect(inv.status).toBe('paid')
  })

  it('a real total with balance 0 is unaffected', () => {
    const inv = map({ status: 'booked', paid: false, balance: 0, total: 1000 })
    expect(inv.status).toBe('paid')
    expect(inv.paid_amount).toBe(1000)
    expect(inv.remaining_amount).toBe(0)
  })
})

/**
 * #2719: every Fortnox-migrated paid invoice carried paid_at = invoice_date.
 * The Fortnox mapper builds paymentStatus as { paid, balance } and never sets
 * lastPaymentDate (Visma and WINT do), and both mappers fell back to the
 * issue date, turning "the source did not say when" into a confident wrong
 * date the UI rendered as fact. The settlement date is now the provider's or
 * null, on both ledgers.
 */
describe('paid_at is the provider payment date or null, never the issue date (#2719)', () => {
  it('customer invoice: paid with no provider date (the Fortnox shape) stays settled but undated', () => {
    const inv = mapSales({ status: 'paid', paid: true, balance: 0, total: 1000 })
    expect(inv.status).toBe('paid')
    expect(inv.paid_amount).toBe(1000)
    expect(inv.remaining_amount).toBe(0)
    expect(inv.paid_at).toBeNull()
  })

  it('customer invoice: the provider date passes through (Visma, WINT)', () => {
    const inv = mapSales({ status: 'paid', paid: true, balance: 0, total: 1000, lastPaymentDate: '2026-02-05' })
    expect(inv.status).toBe('paid')
    expect(inv.paid_at).toBe('2026-02-05')
  })

  it('customer invoice: an unpaid invoice never carries a date whatever the provider sent', () => {
    const inv = mapSales({ status: 'sent', paid: false, balance: 1000, total: 1000, lastPaymentDate: '2026-02-05' })
    expect(inv.status).toBe('sent')
    expect(inv.paid_at).toBeNull()
  })

  it('supplier invoice: paid with no provider date stays settled but undated', () => {
    const inv = map({ status: 'paid', paid: true, balance: 0, total: 1000 })
    expect(inv.status).toBe('paid')
    expect(inv.paid_amount).toBe(1000)
    expect(inv.remaining_amount).toBe(0)
    expect(inv.paid_at).toBeNull()
  })

  it('supplier invoice: the provider date passes through', () => {
    const inv = map({ status: 'paid', paid: true, balance: 0, total: 1000, lastPaymentDate: '2026-02-05' })
    expect(inv.status).toBe('paid')
    expect(inv.paid_at).toBe('2026-02-05')
  })

  it('never writes the issue date as a payment date on either ledger', () => {
    const sales = mapSales({ status: 'paid', paid: true, balance: 0, total: 1000 })
    const supplier = map({ status: 'paid', paid: true, balance: 0, total: 1000 })
    expect(sales.paid_at).not.toBe(sales.invoice_date)
    expect(supplier.paid_at).not.toBe(supplier.invoice_date)
  })
})

/**
 * crm#1245: a Fortnox invoice saved but never sent or booked. Its detail form
 * states Sent false and Booked false; a zero Balance must not make it paid,
 * and its rows and VAT come over as on any hydrated invoice.
 */
describe('mapSalesInvoice: an unissued Fortnox draft', () => {
  const draft = {
    DocumentNumber: '4711', InvoiceDate: '2026-10-20', DueDate: '2026-11-19', Currency: 'SEK',
    CustomerName: 'Kund AB', Sent: false, Booked: false, Cancelled: false,
    Total: 1250, Net: 1000, TotalVAT: 250, Balance: 0, VATIncluded: false,
    InvoiceRows: [
      { RowId: 1, Description: 'Konsulttimmar', DeliveredQuantity: '8', Price: 100, Total: 800, VAT: 25, AccountNumber: 3041 },
      { RowId: 2, Description: 'Resa', DeliveredQuantity: '1', Price: 200, Total: 200, VAT: 25, AccountNumber: 3041 },
    ],
  }

  it('lands as a draft with nothing paid, its rows in order and 25 % VAT', () => {
    const mapped = mapSalesInvoice(mapFortnoxToSalesInvoice(draft), 'user-1', 'company-1', 'customer-1')
    expect(mapped.invoice.status).toBe('draft')
    expect(mapped.invoice.paid_amount).toBe(0)
    expect(mapped.invoice.remaining_amount).toBe(1250)
    expect(mapped.invoice.paid_at).toBeNull()
    expect(mapped.invoice.vat_rate).toBe(25)
    expect(mapped.invoice.vat_amount).toBe(250)
    expect(mapped.items.map((item) => [item.sort_order, item.description, item.vat_amount]))
      .toEqual([[1, 'Konsulttimmar', 200], [2, 'Resa', 50]])
  })
})
