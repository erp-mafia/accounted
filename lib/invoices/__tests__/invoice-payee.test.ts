import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { CashAccount } from '@/types'
import { resolveInvoicePayeeChoice, resolveInvoiceSettlementAccount, snapshotInvoicePayee } from '../invoice-payee'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const CA_1 = '11111111-1111-4111-8111-111111111111'

function account(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: CA_1,
    company_id: 'company-1',
    bank_connection_id: null,
    external_uid: null,
    iban: null,
    bban: null,
    bank_name: 'Testbanken',
    clearing_number: null,
    account_number: null,
    bankgiro: '5050-1055',
    plusgiro: null,
    swish: null,
    bic: null,
    bank_code: null,
    foreign_account_number: null,
    invoice_payee: true,
    name: 'Sparkonto',
    currency: 'SEK',
    ledger_account: '1931',
    balance: null,
    available_balance: null,
    balance_updated_at: null,
    enabled: true,
    is_primary: false,
    source: 'manual',
    voucher_series: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('resolveInvoicePayeeChoice', () => {
  it('no choice clears both columns without touching the database', async () => {
    const result = await resolveInvoicePayeeChoice(supabase as never, 'company-1', 'SEK', null)
    expect(result).toEqual({ ok: true, fields: { payment_cash_account_id: null, payment_details: null } })
    expect(findCalls('cash_accounts', 'select')).toHaveLength(0)
  })

  it('rejects an account that is not the company\'s, disabled, not a payee, or unusable for the currency', async () => {
    enqueue({ data: null })
    expect(await resolveInvoicePayeeChoice(supabase as never, 'company-1', 'SEK', CA_1)).toMatchObject({
      ok: false, code: 'INVOICE_PAYEE_ACCOUNT_INVALID', details: { reason: 'not_found' },
    })
    enqueue({ data: account({ enabled: false }) })
    expect(await resolveInvoicePayeeChoice(supabase as never, 'company-1', 'SEK', CA_1)).toMatchObject({
      ok: false, details: { reason: 'disabled' },
    })
    enqueue({ data: account({ invoice_payee: false }) })
    expect(await resolveInvoicePayeeChoice(supabase as never, 'company-1', 'SEK', CA_1)).toMatchObject({
      ok: false, details: { reason: 'not_payee' },
    })
    // Bankgiro only: fine for SEK, not for EUR (needs an IBAN).
    enqueue({ data: account() })
    expect(await resolveInvoicePayeeChoice(supabase as never, 'company-1', 'EUR', CA_1)).toMatchObject({
      ok: false, details: { reason: 'unusable_for_currency' },
    })
  })

  it('freezes the account payee fields on a valid choice', async () => {
    enqueue({ data: account({ iban: 'se45 5000 0000 0583 9825 7466' }) })
    const result = await resolveInvoicePayeeChoice(supabase as never, 'company-1', 'SEK', CA_1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fields.payment_cash_account_id).toBe(CA_1)
    expect(result.fields.payment_details).toMatchObject({
      bank_name: 'Testbanken',
      bankgiro: '5050-1055',
      iban: 'SE4550000000058398257466',
      plusgiro: null,
    })
    const eqCalls = findCalls('cash_accounts', 'eq')
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
    expect(eqCalls).toContainEqual(['id', CA_1])
  })
})

describe('snapshotInvoicePayee', () => {
  it('leaves an invoice without a chosen account alone', async () => {
    const result = await snapshotInvoicePayee(supabase as never, 'company-1', {
      id: 'inv-1', currency: 'SEK', payment_cash_account_id: null, payment_details: null,
    })
    expect(result).toEqual({ ok: true, payee: null })
    expect(findCalls('cash_accounts', 'select')).toHaveLength(0)
  })

  it('skips credit notes and quotes even when they carry a stale account', async () => {
    const result = await snapshotInvoicePayee(supabase as never, 'company-1', {
      id: 'kr-1', currency: 'SEK', payment_cash_account_id: CA_1, credited_invoice_id: 'inv-1',
      payment_details: { bankgiro: '5050-1055' } as never,
    })
    expect(result).toMatchObject({ ok: true, payee: { bankgiro: '5050-1055' } })
    expect(findCalls('cash_accounts', 'select')).toHaveLength(0)
  })

  it('refreshes and persists the payee from the account as it is at issue', async () => {
    enqueue({ data: account({ plusgiro: '123456-7' }) })
    enqueue({ data: null }) // update
    const result = await snapshotInvoicePayee(supabase as never, 'company-1', {
      id: 'inv-1', currency: 'SEK', payment_cash_account_id: CA_1,
      payment_details: { bankgiro: '5050-1055' } as never,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payee).toMatchObject({ bankgiro: '5050-1055', plusgiro: '123456-7' })
    const [update] = findCalls('invoices', 'update')
    expect((update[0] as { payment_details: { plusgiro: string } }).payment_details.plusgiro).toBe('123456-7')
    expect(findCalls('invoices', 'eq')).toContainEqual(['id', 'inv-1'])
  })

  it('does not rewrite an unchanged snapshot', async () => {
    const payee = {
      bank_name: 'Testbanken', clearing_number: null, account_number: null, bankgiro: '5050-1055',
      plusgiro: null, swish: null, iban: null, bic: null, bank_code: null, foreign_account_number: null,
    }
    enqueue({ data: account() })
    const result = await snapshotInvoicePayee(supabase as never, 'company-1', {
      id: 'inv-1', currency: 'SEK', payment_cash_account_id: CA_1, payment_details: payee,
    })
    expect(result.ok).toBe(true)
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })

  it('blocks issue when the chosen account can no longer be used', async () => {
    enqueue({ data: account({ invoice_payee: false }) })
    const result = await snapshotInvoicePayee(supabase as never, 'company-1', {
      id: 'inv-1', currency: 'SEK', payment_cash_account_id: CA_1, payment_details: null,
    })
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_SEND_PAYMENT_ACCOUNT_INVALID' })
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })
})

describe('resolveInvoiceSettlementAccount', () => {
  it('defaults to 1930 without a chosen account and never queries', async () => {
    expect(await resolveInvoiceSettlementAccount(supabase as never, 'company-1', { payment_cash_account_id: null })).toBe('1930')
    expect(findCalls('cash_accounts', 'select')).toHaveLength(0)
  })

  it('debits the chosen account\'s ledger account, and falls back to 1930 when the row is gone', async () => {
    enqueue({ data: { ledger_account: '1931' } })
    expect(await resolveInvoiceSettlementAccount(supabase as never, 'company-1', { payment_cash_account_id: CA_1 })).toBe('1931')
    expect(findCalls('cash_accounts', 'eq')).toContainEqual(['company_id', 'company-1'])
    enqueue({ data: null })
    expect(await resolveInvoiceSettlementAccount(supabase as never, 'company-1', { payment_cash_account_id: CA_1 })).toBe('1930')
  })
})
