/**
 * Unit tests for findInvoiceMatchSuggestion, the invoice-match intercept
 * shared by the dashboard categorize route and the v1 :categorize /
 * batch-categorize routes. The currency-band behaviour is covered end to end
 * through the dashboard route in
 * app/api/transactions/[id]/categorize/__tests__/suggestion-band-currency.test.ts;
 * this pins the gates (which mappings are intercepted, the override) and the
 * returned code + candidate shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import { findInvoiceMatchSuggestion } from '../invoice-match-suggestion'

const log: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => log,
}

const supplierPayment = {
  date: '2026-05-12',
  amount: -1250,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  merchant_name: 'Kontorsbolaget',
  description: 'Kontorsbolaget',
}
const openSupplierInvoice = {
  id: 'si-1',
  supplier_invoice_number: 'F-100',
  invoice_date: '2026-04-30',
  remaining_amount: 1250,
  total: 1250,
  currency: 'SEK',
  total_sek: 1250,
  exchange_rate: null,
  supplier: { name: 'Kontorsbolaget AB' },
}

let mock: ReturnType<typeof createTableMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  mock = createTableMockSupabase()
  mock.setTable('suppliers', { data: [{ id: 'sup-1' }] })
  mock.setTable('supplier_invoices', { data: [openSupplierInvoice] })
})

const supabase = () => mock.supabase as unknown as SupabaseClient

describe('findInvoiceMatchSuggestion', () => {
  it('returns TX_CATEGORIZE_SUGGEST_SI_MATCH with the open supplier invoice for a plain 244x payment', async () => {
    const suggestion = await findInvoiceMatchSuggestion(
      supabase(),
      'company-1',
      { transaction: supplierPayment, debitAccount: '2440', creditAccount: '1930', isBusiness: true },
      log,
    )

    expect(suggestion).toEqual({
      code: 'TX_CATEGORIZE_SUGGEST_SI_MATCH',
      details: {
        candidates: [
          {
            supplier_invoice_id: 'si-1',
            invoice_number: 'F-100',
            invoice_date: '2026-04-30',
            remaining_amount: 1250,
            currency: 'SEK',
            supplier_name: 'Kontorsbolaget AB',
          },
        ],
      },
    })
  })

  it('returns null and queries nothing when confirm_no_match overrides the intercept', async () => {
    const suggestion = await findInvoiceMatchSuggestion(
      supabase(),
      'company-1',
      {
        transaction: supplierPayment,
        debitAccount: '2440',
        creditAccount: '1930',
        isBusiness: true,
        confirmNoMatch: true,
      },
      log,
    )

    expect(suggestion).toBeNull()
    expect(mock.supabase.from).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith('supplier-invoice match suggestion bypassed', expect.anything())
  })

  it.each([
    ['an ordinary expense account', { debitAccount: '6110', creditAccount: '1930', isBusiness: true }],
    ['a 244x debit against a non-cash credit', { debitAccount: '2440', creditAccount: '2893', isBusiness: true }],
    ['a private marking', { debitAccount: '2440', creditAccount: '1930', isBusiness: false }],
  ])('does not intercept %s', async (_label, mapping) => {
    const suggestion = await findInvoiceMatchSuggestion(
      supabase(),
      'company-1',
      { transaction: supplierPayment, ...mapping },
      log,
    )

    expect(suggestion).toBeNull()
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('returns null when no open supplier invoice matches the amount', async () => {
    mock.setTable('supplier_invoices', { data: [{ ...openSupplierInvoice, remaining_amount: 9000, total: 9000, total_sek: 9000 }] })

    const suggestion = await findInvoiceMatchSuggestion(
      supabase(),
      'company-1',
      { transaction: supplierPayment, debitAccount: '2440', creditAccount: '1930', isBusiness: true },
      log,
    )

    expect(suggestion).toBeNull()
  })

  it('returns TX_CATEGORIZE_SUGGEST_CI_MATCH for a plain 151x receipt an unpaid customer invoice covers', async () => {
    mock.setTable('customers', { data: [{ id: 'cust-1' }] })
    mock.setTable('invoices', {
      data: [
        {
          id: 'inv-1',
          invoice_number: '1001',
          invoice_date: '2026-04-12',
          due_date: '2026-05-12',
          remaining_amount: 5000,
          total: 5000,
          currency: 'SEK',
          total_sek: 5000,
          exchange_rate: null,
          customer: { name: 'Kund AB' },
        },
      ],
    })

    const suggestion = await findInvoiceMatchSuggestion(
      supabase(),
      'company-1',
      {
        transaction: { ...supplierPayment, amount: 5000, merchant_name: 'Kund AB', description: 'Kund AB' },
        debitAccount: '1930',
        creditAccount: '1510',
        isBusiness: true,
      },
      log,
    )

    expect(suggestion).toEqual({
      code: 'TX_CATEGORIZE_SUGGEST_CI_MATCH',
      details: {
        candidates: [
          {
            invoice_id: 'inv-1',
            invoice_number: '1001',
            invoice_date: '2026-04-12',
            remaining_amount: 5000,
            currency: 'SEK',
            customer_name: 'Kund AB',
            match_reason: 'name_amount_fuzzy',
          },
        ],
      },
    })
  })
})
