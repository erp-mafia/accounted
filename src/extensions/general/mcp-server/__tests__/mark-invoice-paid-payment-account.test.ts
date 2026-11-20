/**
 * gnubok_mark_invoice_as_paid: payment_account (crm#1823). A company that
 * receives customer payments on another bank account than the invoice names
 * or the primary says where the money landed. The named account is checked at
 * staging against the company's own enabled cash accounts, carried in the
 * staged params and shown in the preview; an unnamed call stages what it
 * always did, now with the resolved account in the preview.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Whether a credit note is active: mocked so it takes no slot in the Supabase
// mock; the read is pinned by lib/invoices/__tests__/active-credit-note.test.ts.
const { mockHasActiveCreditNote } = vi.hoisted(() => ({ mockHasActiveCreditNote: vi.fn(async (..._args: unknown[]) => false) }))
vi.mock('@/lib/invoices/active-credit-note', () => ({ invoiceHasActiveCreditNote: mockHasActiveCreditNote }))
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
}))

vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForInvoice: vi.fn(async () => []),
}))

import { tools } from '../server'

const markPaid = tools.find((t) => t.name === 'gnubok_mark_invoice_as_paid')!

const INVOICE_ID = '33333333-3333-4333-8333-333333333333'
const ACTOR = { type: 'api_key' } as never

const INVOICE = {
  id: INVOICE_ID,
  invoice_number: 'F-1001',
  status: 'sent',
  document_type: 'invoice',
  credited_invoice_id: null,
  journal_entry_id: 'je-issue',
  payment_cash_account_id: null,
  total: 12500,
  total_sek: 12500,
  subtotal: 10000,
  subtotal_sek: 10000,
  vat_amount: 2500,
  vat_amount_sek: 2500,
  currency: 'SEK',
  exchange_rate: null,
  vat_treatment: 'standard_25',
  paid_amount: 0,
  remaining_amount: 12500,
  customer: { id: 'cust-1', name: 'Testkund AB' },
}

const COMPANY_CASH_ACCOUNTS = [
  { ledger_account: '1930', enabled: true },
  { ledger_account: '1931', enabled: true },
  { ledger_account: '1935', enabled: true },
  { ledger_account: '1940', enabled: false },
]

function setup(cashAccounts: unknown) {
  return createTableMockSupabase({
    invoices: { data: INVOICE },
    invoice_items: { data: [] },
    company_settings: {
      data: { accounting_method: 'accrual', entity_type: 'aktiebolag', bookkeeping_locked_through: null },
    },
    cash_accounts: { data: cashAccounts },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    pending_operations: { data: { id: 'op-1' } },
  })
}

type Staged = {
  staged: boolean
  preview: { payment_account: string | null; journal_entry_preview: { lines: Array<{ account_number: string; debit_amount: number }> } }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_mark_invoice_as_paid: payment_account', () => {
  it('declares the argument in a strict schema', () => {
    const schema = markPaid.inputSchema as { additionalProperties: boolean; properties: Record<string, unknown>; required: string[] }
    expect(schema.properties).toHaveProperty('payment_account')
    expect(schema.required).toEqual(['invoice_id'])
    expect(schema.additionalProperties).toBe(false)
  })

  it('stages the debit on the named account, in the params and in the preview', async () => {
    const { supabase, findCall } = setup(COMPANY_CASH_ACCOUNTS)

    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15', payment_account: '1931' },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as Staged

    expect(result.staged).toBe(true)
    expect(result.preview.payment_account).toBe('1931')
    const debit = result.preview.journal_entry_preview.lines.find((l) => l.debit_amount > 0)
    expect(debit).toMatchObject({ account_number: '1931', debit_amount: 12500 })
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toMatchObject({ invoice_id: INVOICE_ID, payment_date: '2026-09-15', payment_account: '1931' })
  })

  it('without the argument stages as before, and the preview names the account it resolved', async () => {
    // The primary read answers one row.
    const { supabase, findCall } = setup({ id: 'ca-primary', ledger_account: '1935', enabled: true, currency: 'SEK' })

    const result = (await markPaid.execute(
      { invoice_id: INVOICE_ID, payment_date: '2026-09-15' },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as Staged

    expect(result.staged).toBe(true)
    expect(result.preview.payment_account).toBe('1935')
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toEqual({ invoice_id: INVOICE_ID, payment_date: '2026-09-15', allow_duplicate: false })
  })

  it('refuses an account the company holds no enabled cash account for, naming the ones it can use, and stages nothing', async () => {
    for (const account of ['1932', '1940']) {
      const { supabase, findCall } = setup(COMPANY_CASH_ACCOUNTS)
      await expect(
        markPaid.execute(
          { invoice_id: INVOICE_ID, payment_date: '2026-09-15', payment_account: account },
          'company-1', 'user-1', supabase as never, ACTOR,
        ),
      ).rejects.toMatchObject({
        code: 'INVOICE_PAID_PAYMENT_ACCOUNT_INVALID',
        message: expect.stringContaining('1930, 1931, 1935'),
      })
      expect(findCall('pending_operations', 'insert')).toBeUndefined()
    }
  })

  it('refuses an account outside 19xx, or a number, as a bad argument before any read', async () => {
    for (const account of ['1686', '2440', 1931]) {
      const { supabase, findCall } = setup(COMPANY_CASH_ACCOUNTS)
      await expect(
        markPaid.execute(
          { invoice_id: INVOICE_ID, payment_account: account },
          'company-1', 'user-1', supabase as never, ACTOR,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
      expect(findCall('invoices', 'select')).toBeUndefined()
    }
  })
})
