import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  AP_DEBIT_SIDE,
  OWNER_PRIVATE_FUNDS_ACCOUNTS,
  resolveSupplierSettlementSide,
  settlesOnAccount,
  voucherBooksPurchase,
} from '../supplier-settlement-side'
import { createQueuedMockSupabase } from '@/tests/helpers'

describe('resolveSupplierSettlementSide', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks the database function, by invoice id, and returns what it says', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { settlement_side: 'bank_credit', account_prefix: '19', entry_side: 'credit' } })

    const side = await resolveSupplierSettlementSide(supabase as never, 'company-1', 'si-1')

    expect(side).toEqual({ side: 'bank_credit', accountPrefix: '19', entrySide: 'credit' })
    expect(supabase.rpc).toHaveBeenCalledWith('supplier_invoice_settlement_side', {
      p_supplier_invoice_id: 'si-1',
      p_company_id: 'company-1',
    })
  })

  // Falling back to the 244x debit is the behaviour every invoice had before the
  // function existed: a deploy that reaches the app before the migration, or a
  // transient read failure, must never widen the search to 19xx on a guess.
  it.each([
    ['the call fails', { data: null, error: { message: 'function does not exist' } }],
    ['the invoice is not visible (no row)', { data: null }],
    ['the answer is not one of the two sides', { data: { settlement_side: 'x', account_prefix: '30', entry_side: 'credit' } }],
  ])('falls back to the 244x debit when %s', async (_label, response) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(response)
    const side = await resolveSupplierSettlementSide(supabase as never, 'company-1', 'si-1')
    expect(side).toEqual(AP_DEBIT_SIDE)
  })
})

// The SQL twins and their parity are pinned in
// tests/pg/link-supplier-invoice-voucher-owner-paid.pg.test.ts.
describe('settlesOnAccount (crm#1817)', () => {
  const BANK_CREDIT = { side: 'bank_credit', accountPrefix: '19', entrySide: 'credit' } as const

  it('names the two owner accounts, as strings', () => {
    expect(OWNER_PRIVATE_FUNDS_ACCOUNTS).toEqual(['2018', '2893'])
  })

  it('bank_credit: 19xx always, the owner accounts only on a verifikat that books a purchase', () => {
    expect(settlesOnAccount(BANK_CREDIT, '1930', false)).toBe(true)
    expect(settlesOnAccount(BANK_CREDIT, '2018', true)).toBe(true)
    expect(settlesOnAccount(BANK_CREDIT, '2893', true)).toBe(true)
    expect(settlesOnAccount(BANK_CREDIT, '2018', false)).toBe(false)
    expect(settlesOnAccount(BANK_CREDIT, '2820', true)).toBe(false)
    expect(settlesOnAccount(BANK_CREDIT, '2890', true)).toBe(false)
    expect(settlesOnAccount(BANK_CREDIT, '2440', true)).toBe(false)
    expect(settlesOnAccount(BANK_CREDIT, null, true)).toBe(false)
  })

  it('ap_debit: 244x only, whatever the verifikat books', () => {
    expect(settlesOnAccount(AP_DEBIT_SIDE, '2440', false)).toBe(true)
    expect(settlesOnAccount(AP_DEBIT_SIDE, '2893', true)).toBe(false)
    expect(settlesOnAccount(AP_DEBIT_SIDE, '1930', true)).toBe(false)
  })
})

describe('voucherBooksPurchase (crm#1817)', () => {
  const line = (account_number: string | null, debit_amount: number | string, credit_amount: number | string) => ({
    account_number,
    debit_amount,
    credit_amount,
  })

  it('a debit on a cost account books a purchase', () => {
    expect(voucherBooksPurchase([line('6230', 1000, 0), line('2641', 250, 0), line('2018', 0, 1250)], [])).toBe(true)
    expect(voucherBooksPurchase([line('4010', '1250.00', '0.00'), line('2893', 0, 1250)], [])).toBe(true)
  })

  it('an owner deposit, a cleared skuld and a cost credit do not', () => {
    expect(voucherBooksPurchase([line('1930', 1250, 0), line('2018', 0, 1250)], [])).toBe(false)
    expect(voucherBooksPurchase([line('2440', 1250, 0), line('2893', 0, 1250)], [])).toBe(false)
    expect(voucherBooksPurchase([line('2018', 1250, 0), line('6230', 0, 1250)], [])).toBe(false)
    expect(voucherBooksPurchase([], [])).toBe(false)
  })

  it('a debit on the invoice line account counts, never a 19xx one', () => {
    expect(voucherBooksPurchase([line('1220', 1250, 0), line('2893', 0, 1250)], [])).toBe(false)
    expect(voucherBooksPurchase([line('1220', 1250, 0), line('2893', 0, 1250)], ['1220'])).toBe(true)
    expect(voucherBooksPurchase([line('1930', 1250, 0), line('2018', 0, 1250)], ['1930'])).toBe(false)
  })
})
