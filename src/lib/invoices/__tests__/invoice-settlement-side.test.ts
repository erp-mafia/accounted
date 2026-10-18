import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  AR_CREDIT_SIDE,
  BANK_DEBIT_SIDE,
  invoiceSettlementSideFor,
  resolveInvoiceSettlementSide,
} from '../invoice-settlement-side'
import { createQueuedMockSupabase } from '@/tests/helpers'

describe('invoiceSettlementSideFor (the TypeScript twin of invoice_settlement_side)', () => {
  it.each([
    ['cash', null, BANK_DEBIT_SIDE],
    ['cash', undefined, BANK_DEBIT_SIDE],
    // A kontantmetod invoice carried over the year end, or booked at issue
    // before a method switch: its receivable sits on 1510 (#3440).
    ['cash', 'je-carry', AR_CREDIT_SIDE],
    ['accrual', null, AR_CREDIT_SIDE],
    ['accrual', 'je-reg', AR_CREDIT_SIDE],
    // No settings row: faktureringsmetoden, as the SQL COALESCE.
    [null, null, AR_CREDIT_SIDE],
    [undefined, null, AR_CREDIT_SIDE],
  ] as const)('method %s, journal_entry_id %s', (method, link, expected) => {
    expect(invoiceSettlementSideFor(method, link)).toEqual(expected)
  })
})

describe('resolveInvoiceSettlementSide', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks the database function, by invoice id, and returns what it says', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { settlement_side: 'bank_debit', account_prefix: '19', entry_side: 'debit' } })

    const side = await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1')

    expect(side).toEqual(BANK_DEBIT_SIDE)
    expect(supabase.rpc).toHaveBeenCalledWith('invoice_settlement_side', {
      p_invoice_id: 'inv-1',
      p_company_id: 'company-1',
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('reads the 151x credit for a carried kontantmetod invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { settlement_side: 'ar_credit', account_prefix: '151', entry_side: 'credit' } })
    expect(await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1'))
      .toEqual(AR_CREDIT_SIDE)
  })

  // A deploy that reaches the app before the migration, or a transient read
  // failure: the twin decides from the same two facts, read directly.
  it.each([
    ['the call fails', { data: null, error: { message: 'function does not exist' } }],
    ['the invoice is not visible (no row)', { data: null }],
    ['the answer is not one of the two sides', { data: { settlement_side: 'x' } }],
  ])('falls back to the twin when %s', async (_label, response) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(response)
    enqueue({ data: { accounting_method: 'cash' } }) // company_settings
    enqueue({ data: { id: 'inv-1', journal_entry_id: null } }) // invoices
    expect(await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1'))
      .toEqual(BANK_DEBIT_SIDE)
  })

  it('keeps a carried invoice on 151x in the fallback too', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: { accounting_method: 'cash' } })
    enqueue({ data: { id: 'inv-1', journal_entry_id: 'je-carry' } })
    expect(await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1'))
      .toEqual(AR_CREDIT_SIDE)
  })

  it('answers the 151x credit when even the fallback read fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    enqueue({ data: null, error: { message: 'settings read failed' } })
    enqueue({ data: null })
    expect(await resolveInvoiceSettlementSide(supabase as never, 'company-1', 'inv-1'))
      .toEqual(AR_CREDIT_SIDE)
  })
})
