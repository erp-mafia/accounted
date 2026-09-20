import { describe, it, expect } from 'vitest'
import { mapSalesInvoice, mapSupplierInvoice, resolveSupplierSettlement } from '../entity-mapper'
import type { SalesInvoiceDto, SupplierInvoiceDto, InvoiceStatusCode, PartyDto, PaymentStatusDto } from '@/lib/providers/dto'

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

  it('a partial payment carries the provider payment date when there is one', () => {
    const inv = map({ status: 'booked', paid: false, balance: 300, total: 1000, lastPaymentDate: '2026-02-05' })
    expect(inv.status).toBe('partially_paid')
    expect(inv.paid_at).toBe('2026-02-05')
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
 * Company 5208b894 (Visma, 2026-09-10): 582 supplier invoices imported, 0
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
 * The settlement rule is exported so the repair pass
 * (refresh-migrated-payment-state.ts) reads a provider's payment fields
 * exactly as the import did. Two copies would drift and the repair would then
 * contradict the import it repairs.
 */
describe('resolveSupplierSettlement', () => {
  const balanceStatus = (paid: boolean, balance: number, lastPaymentDate?: string): PaymentStatusDto => ({
    paid,
    balance: { value: balance, currencyCode: 'SEK' },
    lastPaymentDate,
    source: 'balance',
  })

  it('settles a fully paid invoice and dates it from the provider payment date', () => {
    expect(resolveSupplierSettlement(balanceStatus(false, 0, '2026-02-05'), 1000)).toEqual({
      status: 'paid',
      paidAmount: 1000,
      remainingAmount: 0,
      paidAt: '2026-02-05',
    })
  })

  it('leaves paidAt null when the provider names no payment date: unknown is not the issue date', () => {
    expect(resolveSupplierSettlement(balanceStatus(false, 0), 1000)).toEqual({
      status: 'paid',
      paidAmount: 1000,
      remainingAmount: 0,
      paidAt: null,
    })
  })

  it('normalises an empty payment date string to null rather than writing it', () => {
    expect(resolveSupplierSettlement(balanceStatus(false, 0, ''), 1000).paidAt).toBeNull()
  })

  it('reports a partial payment as partially_paid with both amounts', () => {
    expect(resolveSupplierSettlement(balanceStatus(false, 300), 1000)).toMatchObject({
      status: 'partially_paid',
      paidAmount: 700,
      remainingAmount: 300,
    })
  })

  it('says nothing about a still-open invoice, so the caller keeps its lifecycle status', () => {
    expect(resolveSupplierSettlement(balanceStatus(false, 1000), 1000)).toEqual({
      status: null,
      paidAmount: 0,
      remainingAmount: 1000,
      paidAt: null,
    })
  })

  it('never settles a zero total', () => {
    expect(resolveSupplierSettlement(balanceStatus(false, 0), 0).status).toBeNull()
  })

  it('never lets a zero balance override an explicit unpaid enum', () => {
    const enumStatus: PaymentStatusDto = {
      paid: false,
      balance: { value: 0, currencyCode: 'SEK' },
      source: 'enum',
    }
    expect(resolveSupplierSettlement(enumStatus, 1000)).toEqual({
      status: null,
      paidAmount: 0,
      remainingAmount: 1000,
      paidAt: null,
    })
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
