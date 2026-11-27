/**
 * The supplier invoice side of a storno of its registration verifikat:
 * refused before the storno while the invoice the verifikat registers has
 * payments; afterwards the pointer to the reversed verifikat is cleared, so
 * the invoice reads not booked and Bokför books it again. A registration no
 * invoice points at (the create flow undoing a failed registration) passes
 * and changes no invoice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }))

import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { SupplierInvoiceRegistrationHasPaymentsError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  assertSupplierInvoiceRegistrationReversible,
  releaseSupplierInvoiceRegistrationAfterReversal,
} from '../registration-reversal'

const COMPANY = 'company-1'

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'si-1',
    company_id: COMPANY,
    registration_journal_entry_id: 'je-reg',
    status: 'approved',
    paid_amount: 0,
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('assertSupplierInvoiceRegistrationReversible', () => {
  it('lets the registration of an unpaid invoice through', async () => {
    const { supabase } = createRowsMockSupabase({ supplier_invoices: [invoice()], supplier_invoice_payments: [] })
    await expect(assertSupplierInvoiceRegistrationReversible(supabase as never, COMPANY, 'je-reg')).resolves.toBeUndefined()
  })

  it('refuses while the invoice has a payment row', async () => {
    const { supabase } = createRowsMockSupabase({
      supplier_invoices: [invoice()],
      supplier_invoice_payments: [{ id: 'pay-1', company_id: COMPANY, supplier_invoice_id: 'si-1', amount: 100 }],
    })
    const refusal = assertSupplierInvoiceRegistrationReversible(supabase as never, COMPANY, 'je-reg')
    await expect(refusal).rejects.toBeInstanceOf(SupplierInvoiceRegistrationHasPaymentsError)
    await expect(refusal).rejects.toMatchObject({ code: 'SI_REGISTRATION_STORNO_HAS_PAYMENTS', supplierInvoiceId: 'si-1' })
  })

  it('refuses while the invoice carries a paid amount, even without a payment row', async () => {
    const { supabase, tables } = createRowsMockSupabase({
      supplier_invoices: [invoice({ status: 'paid', paid_amount: '1250.00' })],
      supplier_invoice_payments: [],
    })
    await expect(assertSupplierInvoiceRegistrationReversible(supabase as never, COMPANY, 'je-reg')).rejects.toBeInstanceOf(
      SupplierInvoiceRegistrationHasPaymentsError,
    )
    expect(tables()).toEqual(['supplier_invoices'])
  })

  it('lets a registration no invoice points at through (the create flow undoing a failed registration)', async () => {
    // The invoice of the same source_id exists, but its pointer was never set
    // to this verifikat: it is not the invoice's registration.
    const { supabase, tables } = createRowsMockSupabase({
      supplier_invoices: [invoice({ registration_journal_entry_id: null })],
      supplier_invoice_payments: [{ id: 'pay-1', company_id: COMPANY, supplier_invoice_id: 'si-1', amount: 100 }],
    })
    await expect(assertSupplierInvoiceRegistrationReversible(supabase as never, COMPANY, 'je-reg')).resolves.toBeUndefined()
    expect(tables()).toEqual(['supplier_invoices'])
  })

  it('reads company-scoped, by the registration pointer', async () => {
    const { supabase, findCalls } = createRowsMockSupabase({ supplier_invoices: [invoice()], supplier_invoice_payments: [] })
    await assertSupplierInvoiceRegistrationReversible(supabase as never, COMPANY, 'je-reg')
    expect(findCalls('supplier_invoices', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['registration_journal_entry_id', 'je-reg'],
    ])
    expect(findCalls('supplier_invoice_payments', 'eq')).toEqual([['company_id', COMPANY]])
    expect(findCalls('supplier_invoice_payments', 'in')).toEqual([['supplier_invoice_id', ['si-1']]])
  })

  it('throws on a failed read: unknown is never reversible', async () => {
    const failedInvoices = createTableMockSupabase({ supplier_invoices: { data: null, error: { message: 'boom' } } })
    await expect(
      assertSupplierInvoiceRegistrationReversible(failedInvoices.supabase as never, COMPANY, 'je-reg'),
    ).rejects.toThrow(/lookup by voucher failed/)

    const failedPayments = createTableMockSupabase({
      supplier_invoices: { data: [invoice()] },
      supplier_invoice_payments: { data: null, error: { message: 'boom' } },
    })
    await expect(
      assertSupplierInvoiceRegistrationReversible(failedPayments.supabase as never, COMPANY, 'je-reg'),
    ).rejects.toThrow(/payment lookup failed/)
  })

  it('names the payments to undo first, in Swedish and in English', () => {
    const refusal = new SupplierInvoiceRegistrationHasPaymentsError('si-1')
    expect(getErrorMessage(refusal)).toMatch(/Ångra betalningarna först/)
    expect(getErrorMessage(refusal, { locale: 'en' })).toMatch(/Undo the payments first/)
  })
})

describe('releaseSupplierInvoiceRegistrationAfterReversal', () => {
  it('clears the pointer that names the reversed verifikat and nothing else', async () => {
    const writes: { table: string; method: string; row: unknown }[] = []
    const { supabase, findCalls } = createRowsMockSupabase({ supplier_invoices: [invoice()] }, writes)
    await releaseSupplierInvoiceRegistrationAfterReversal(supabase as never, COMPANY, 'je-reg')
    expect(writes).toEqual([
      { table: 'supplier_invoices', method: 'update', row: { registration_journal_entry_id: null } },
    ])
    // Compare-and-set on the pointer: an invoice booked again meanwhile keeps its new registration.
    expect(findCalls('supplier_invoices', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['registration_journal_entry_id', 'je-reg'],
    ])
  })

  it('logs a failed release, never throws (the storno stands)', async () => {
    const { supabase } = createTableMockSupabase({ supplier_invoices: { data: null, error: { message: 'boom' } } })
    await expect(releaseSupplierInvoiceRegistrationAfterReversal(supabase as never, COMPANY, 'je-reg')).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledOnce()
  })
})
