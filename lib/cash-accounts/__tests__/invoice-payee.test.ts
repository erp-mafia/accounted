import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { CashAccount } from '@/types'
import {
  cashAccountPayee,
  createManualBankAccount,
  isBankCashAccount,
  isUsableInvoicePayee,
  propagateLegacyPayeeWrite,
  updateCashAccountPayee,
} from '../invoice-payee'

vi.mock('@/lib/import/account-sync', () => ({
  syncMappedAccounts: vi.fn().mockResolvedValue({ error: null }),
}))

vi.mock('@/lib/cash-accounts/service', () => ({
  findFreeLedgerAccount: vi.fn().mockResolvedValue('1931'),
}))

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

function account(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: 'ca-1',
    company_id: 'company-1',
    bank_connection_id: null,
    external_uid: null,
    iban: null,
    bban: null,
    bank_name: null,
    clearing_number: null,
    account_number: null,
    bankgiro: null,
    plusgiro: null,
    swish: null,
    bic: null,
    bank_code: null,
    foreign_account_number: null,
    invoice_payee: true,
    name: 'Företagskonto',
    currency: 'SEK',
    ledger_account: '1930',
    balance: null,
    available_balance: null,
    balance_updated_at: null,
    enabled: true,
    is_primary: true,
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

describe('cashAccountPayee', () => {
  it('normalises IBAN and BIC and passes the giro numbers through', () => {
    const payee = cashAccountPayee(account({ iban: 'se45 5000 0000 0583 9825 7466', bic: 'esse sess', bankgiro: '5050-1234' }))
    expect(payee.iban).toBe('SE4550000000058398257466')
    expect(payee.bic).toBe('ESSESESS')
    expect(payee.bankgiro).toBe('5050-1234')
    expect(payee.plusgiro).toBeNull()
  })
})

describe('isUsableInvoicePayee', () => {
  it('needs the payee flag, enabled, and identifiers the currency accepts', () => {
    expect(isUsableInvoicePayee(account({ bankgiro: '5050-1234' }), 'SEK')).toBe(true)
    expect(isUsableInvoicePayee(account({ bankgiro: '5050-1234', invoice_payee: false }), 'SEK')).toBe(false)
    expect(isUsableInvoicePayee(account({ bankgiro: '5050-1234', enabled: false }), 'SEK')).toBe(false)
    expect(isUsableInvoicePayee(account(), 'SEK')).toBe(false)
  })

  it('a SEK account with an IBAN is a usable EUR payee; a bankgiro-only one is not', () => {
    expect(isUsableInvoicePayee(account({ iban: 'SE4550000000058398257466' }), 'EUR')).toBe(true)
    expect(isUsableInvoicePayee(account({ bankgiro: '5050-1234' }), 'EUR')).toBe(false)
  })

  it('accepts the USD routing triple without an IBAN', () => {
    expect(isUsableInvoicePayee(
      account({ currency: 'USD', ledger_account: '1933', bank_code: '021000021', foreign_account_number: '12345678', bic: 'CHASUS33' }),
      'USD',
    )).toBe(true)
  })
})

describe('isBankCashAccount', () => {
  it('keeps 19xx rows and drops PSP clearing accounts', () => {
    expect(isBankCashAccount({ ledger_account: '1930' })).toBe(true)
    expect(isBankCashAccount({ ledger_account: '1945' })).toBe(true)
    expect(isBankCashAccount({ ledger_account: '1686' })).toBe(false)
    expect(isBankCashAccount({ ledger_account: '1584' })).toBe(false)
  })
})

describe('updateCashAccountPayee', () => {
  it('writes only the supplied keys, clears with null, normalises IBAN/BIC', async () => {
    enqueue({ data: account({ bankgiro: '5050-1234' }) })
    await updateCashAccountPayee(supabase as never, 'company-1', 'ca-1', {
      bankgiro: '5050-1234',
      plusgiro: null,
      iban: 'se45 5000 0000 0583 9825 7466',
      invoice_payee: true,
    })
    expect(findCalls('cash_accounts', 'update')).toEqual([[{
      bankgiro: '5050-1234',
      plusgiro: null,
      iban: 'SE4550000000058398257466',
      invoice_payee: true,
    }]])
    const eqCalls = findCalls('cash_accounts', 'eq')
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
    expect(eqCalls).toContainEqual(['id', 'ca-1'])
  })
})

describe('createManualBankAccount', () => {
  it('allocates a free 19xx slot, syncs the chart, and inserts a manual payee row', async () => {
    enqueue({ data: account({ id: 'ca-new', ledger_account: '1931', source: 'manual', bankgiro: '5050-1234' }) })
    const created = await createManualBankAccount(supabase as never, 'company-1', 'user-1', {
      name: 'Sparkonto',
      currency: 'sek',
      payee: { bankgiro: '5050-1234', iban: ' se45 5000 0000 0583 9825 7466 ' },
    })
    expect(created.id).toBe('ca-new')
    const [insert] = findCalls('cash_accounts', 'insert')
    expect(insert[0]).toMatchObject({
      company_id: 'company-1',
      ledger_account: '1931',
      currency: 'SEK',
      name: 'Sparkonto',
      source: 'manual',
      invoice_payee: true,
      is_primary: false,
      bankgiro: '5050-1234',
      iban: 'SE4550000000058398257466',
    })
  })
})

describe('propagateLegacyPayeeWrite', () => {
  it('writes a legacy SEK column change through to the SEK default account', async () => {
    enqueue({ data: [{ currency: 'SEK', cash_account_id: 'ca-1' }] }) // defaults
    enqueue({ data: account({ bankgiro: '5050-1234' }) })                // update
    const written = await propagateLegacyPayeeWrite(supabase as never, 'company-1', { bankgiro: '5050-1234' })
    expect(written).toEqual(['SEK'])
    expect(findCalls('cash_accounts', 'update')).toEqual([[{ invoice_payee: true, bankgiro: '5050-1234' }]])
    expect(findCalls('invoice_payee_defaults', 'upsert')).toHaveLength(0)
  })

  it('adopts the primary SEK account when no SEK default exists yet', async () => {
    enqueue({ data: [] })                       // defaults: none
    enqueue({ data: { id: 'ca-primary' } })      // primary lookup
    enqueue({ data: null })                      // upsert default
    enqueue({ data: account({ id: 'ca-primary', iban: 'SE4550000000058398257466' }) }) // update
    const written = await propagateLegacyPayeeWrite(supabase as never, 'company-1', {
      iban: 'SE4550000000058398257466',
      bic: '',
    })
    expect(written).toEqual(['SEK'])
    expect(findCalls('invoice_payee_defaults', 'upsert')[0][0]).toEqual({
      company_id: 'company-1',
      currency: 'SEK',
      cash_account_id: 'ca-primary',
    })
    expect(findCalls('cash_accounts', 'update')).toEqual([[{
      invoice_payee: true,
      iban: 'SE4550000000058398257466',
      bic: null,
    }]])
  })

  it('a full map entry replaces every payee field on the default account; currencies without a default are skipped', async () => {
    enqueue({ data: [{ currency: 'EUR', cash_account_id: 'ca-1' }] })
    enqueue({ data: account({ iban: 'SE4550000000058398257466' }) })
    const written = await propagateLegacyPayeeWrite(supabase as never, 'company-1', {
      invoice_payment_accounts: {
        EUR: { iban: 'SE4550000000058398257466', bic: 'ESSESESS' },
        USD: { iban: 'GB33BUKB20201555555555' },
      },
    })
    expect(written).toEqual(['EUR'])
    const [payload] = findCalls('cash_accounts', 'update')[0] as [Record<string, unknown>]
    expect(payload).toMatchObject({ invoice_payee: true, iban: 'SE4550000000058398257466', bic: 'ESSESESS', bankgiro: null, swish: null })
  })

  it('does nothing when the change carries no payment instructions', async () => {
    const written = await propagateLegacyPayeeWrite(supabase as never, 'company-1', { email: 'x@y.se' } as never)
    expect(written).toEqual([])
    expect(findCalls('invoice_payee_defaults', 'select')).toHaveLength(0)
  })
})
