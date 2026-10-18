/**
 * Routing pins for an invoice carried over a kontantmetod year end
 * (årsomföring, #3440). The carry links the invoice to its year_end verifikat
 * through invoices.journal_entry_id / supplier_invoices.
 * registration_journal_entry_id, and the design rests on every payment door
 * already routing on that link: a carried invoice is settled against 1510 /
 * 2440 with no revenue, cost or moms, exactly like one booked at issue. No
 * door changed for it; these tests pin that they route it that way.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice } from '@/types'
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: vi.fn(),
  createInvoiceCashEntry: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: vi.fn(),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))

import {
  createInvoiceCashEntry,
  createInvoicePaymentJournalEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { settleInvoicePayment } from '../settle-invoice-payment'
import { planSupplierBankMatch } from '../apply-supplier-payment'
import { findCashMethodUnbookedAllocations } from '../batch-cash-method-guard'
import {
  cashPartialBlockReason,
  creditNoteNeedsJournalEntry,
  supplierCreditNoteNeedsJournalEntry,
} from '@/lib/bookkeeping/booking-mode'
import { resolveInvoicePaymentSourceType } from '@/lib/bookkeeping/propose-payment-lines'
import { invoiceSettlementSideFor } from '../invoice-settlement-side'
import { eventBus } from '@/lib/events'

const CARRY = 'je-carry-2026'

function carriedInvoice(overrides: Partial<Invoice> = {}) {
  return {
    ...makeInvoice({ id: 'inv-1', status: 'sent', total: 1250, currency: 'SEK' }),
    journal_entry_id: CARRY,
    remaining_amount: 1250,
    paid_amount: 0,
    customer: { name: 'Kund AB' },
    ...overrides,
  } as Invoice & { customer?: { name?: string | null } | null }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.mocked(createInvoicePaymentJournalEntry).mockResolvedValue({ id: 'je-clearing' } as never)
  vi.mocked(createInvoiceCashEntry).mockResolvedValue({ id: 'je-cash' } as never)
})

describe('settleInvoicePayment: a carried invoice under kontantmetoden', () => {
  it('clears 1510 through the payment entry, never the revenue-and-moms cash entry', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null })
    enqueue({ data: [{ id: 'inv-1' }] })

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      invoice: carriedInvoice(),
      paymentAmountInInvoiceCurrency: 1250,
      paymentDate: '2027-02-10',
      accountingMethod: 'cash',
      entityType: 'aktiebolag',
    })

    expect(result).toMatchObject({ ok: true, newStatus: 'paid', journalEntryId: 'je-clearing' })
    expect(createInvoicePaymentJournalEntry).toHaveBeenCalledTimes(1)
    expect(createInvoiceCashEntry).not.toHaveBeenCalled()
    // The clearing's source type: invoice_paid, never invoice_cash_payment
    // (the database refuses that one for a carried invoice).
    expect(resolveInvoicePaymentSourceType({ invoiceAlreadyBooked: true, accountingMethod: 'cash' }))
      .toBe('invoice_paid')
  })

  it('allows a partial payment (the carry holds the receivable to clear in parts)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' }, error: null })
    enqueue({ data: [{ id: 'inv-1' }] })

    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      invoice: carriedInvoice(),
      paymentAmountInInvoiceCurrency: 500,
      paymentDate: '2027-01-20',
      accountingMethod: 'cash',
      entityType: 'aktiebolag',
    })

    expect(result).toMatchObject({ ok: true, newStatus: 'partially_paid' })
    expect(createInvoiceCashEntry).not.toHaveBeenCalled()
    expect(cashPartialBlockReason({
      invoiceAlreadyBooked: true,
      accountingMethod: 'cash',
      priorPaidAmount: 500,
      paysRemainingInFull: false,
    })).toBeNull()
  })
})

describe('planSupplierBankMatch: a carried supplier invoice under kontantmetoden', () => {
  it('plans a 2440 clearing, not a kontantmetod cash booking', () => {
    const r = planSupplierBankMatch({
      invoice: {
        total: 500,
        paid_amount: 0,
        remaining_amount: 500,
        currency: 'SEK',
        exchange_rate: null,
        registration_journal_entry_id: CARRY,
      },
      transaction: { amount: -500, currency: 'SEK', amount_sek: null },
      accountingMethod: 'cash',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.booking).toMatchObject({ kind: 'clearing', sekClearingDebt: 500 })
  })

  it('allows a partial payment of a carried invoice', () => {
    const r = planSupplierBankMatch({
      invoice: {
        total: 500,
        paid_amount: 0,
        remaining_amount: 500,
        currency: 'SEK',
        exchange_rate: null,
        registration_journal_entry_id: CARRY,
      },
      transaction: { amount: -200, currency: 'SEK', amount_sek: null },
      accountingMethod: 'cash',
    })
    expect(r).toMatchObject({ ok: true, plan: { newStatus: 'partially_paid', booking: { kind: 'clearing' } } })
  })
})

describe('findCashMethodUnbookedAllocations: a carried invoice is batch-allocatable', () => {
  it('lets carried customer and supplier invoices through as pure clearings', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { accounting_method: 'cash' }, error: null })
    enqueue({ data: [{ id: 'inv-1', invoice_number: 'F-1', journal_entry_id: CARRY }], error: null })
    enqueue({ data: [{ id: 'si-1', supplier_invoice_number: 'L-1', registration_journal_entry_id: CARRY }], error: null })

    const result = await findCashMethodUnbookedAllocations(supabase as never, 'company-1', [
      { kind: 'customer_invoice', invoice_id: 'inv-1' },
      { kind: 'supplier_invoice', supplier_invoice_id: 'si-1' },
    ])
    expect(result).toEqual({ ok: true, unbooked: [] })
  })
})

describe('credit notes on a carried invoice', () => {
  it('reverse the carry (customer): the link is the booked-ness signal', () => {
    expect(creditNoteNeedsJournalEntry('cash', {
      journal_entry_id: CARRY, status: 'sent', paid_at: null, paid_amount: 0,
    })).toBe(true)
  })

  it('reverse the carry (supplier): the registration link is the booked-ness signal', () => {
    expect(supplierCreditNoteNeedsJournalEntry('cash', {
      registration_journal_entry_id: CARRY, payment_journal_entry_id: null,
      status: 'registered', paid_at: null, paid_amount: 0,
    })).toBe(true)
  })
})

describe('voucher linking side of a carried invoice', () => {
  it('reads the 151x credit, like an invoice booked at issue', () => {
    expect(invoiceSettlementSideFor('cash', CARRY)).toMatchObject({ side: 'ar_credit', accountPrefix: '151' })
    expect(invoiceSettlementSideFor('cash', null)).toMatchObject({ side: 'bank_debit', accountPrefix: '19' })
  })
})
