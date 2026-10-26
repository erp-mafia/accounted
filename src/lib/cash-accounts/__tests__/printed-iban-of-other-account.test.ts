import { describe, it, expect } from 'vitest'
import type { CashAccount } from '@/types'
import { accountsPrintingOtherAccountIban } from '../invoice-payee-rules'

const SAVINGS = 'SE4550000000058398257466'
const TRANSACTION = 'SE3550000000054910000003'

function account(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: 'ca-1',
    company_id: 'company-1',
    bank_connection_id: null,
    external_uid: null,
    iban: null,
    bban: null,
    payee_iban: null,
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
    source: 'open_payments',
    voucher_series: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const savings = account({ id: 'ca-2', name: 'Sparkonto', ledger_account: '1931', is_primary: false, iban: SAVINGS, invoice_payee: false })

describe('accountsPrintingOtherAccountIban (crm#1483)', () => {
  it('flags an account that prints the bank IBAN of another account, with its own IBAN as the fix', () => {
    const main = account({ iban: TRANSACTION, payee_iban: SAVINGS })
    expect(accountsPrintingOtherAccountIban([main, savings])).toEqual([
      { account: main, other: savings, printedIban: SAVINGS, ownIban: TRANSACTION },
    ])
  })

  it('compares without spaces and case, and returns the printed IBAN compact', () => {
    const main = account({ iban: 'se35 5000 0000 0549 1000 0003', payee_iban: 'SE45 5000 0000 0583 9825 7466' })
    const other = account({ ...savings, iban: 'se4550000000058398257466' })
    expect(accountsPrintingOtherAccountIban([main, other])).toEqual([
      { account: main, other, printedIban: SAVINGS, ownIban: TRANSACTION },
    ])
  })

  it('offers no one-click fix when the account has no IBAN of its own', () => {
    const typed = account({ iban: null, source: 'manual', payee_iban: SAVINGS })
    expect(accountsPrintingOtherAccountIban([typed, savings])).toEqual([
      { account: typed, other: savings, printedIban: SAVINGS, ownIban: null },
    ])
    const odd = account({ iban: 'not an iban', payee_iban: SAVINGS })
    expect(accountsPrintingOtherAccountIban([odd, savings])[0].ownIban).toBeNull()
  })

  it('leaves an account alone that prints its own IBAN, an IBAN no other account has, or nothing', () => {
    expect(accountsPrintingOtherAccountIban([account({ iban: TRANSACTION, payee_iban: TRANSACTION }), savings])).toEqual([])
    expect(accountsPrintingOtherAccountIban([account({ iban: TRANSACTION, payee_iban: 'SE7280000810340009783242' }), savings])).toEqual([])
    expect(accountsPrintingOtherAccountIban([account({ iban: TRANSACTION, payee_iban: null, bankgiro: '5050-1234' }), savings])).toEqual([])
  })

  it('leaves an account alone that is not shown on invoices', () => {
    expect(accountsPrintingOtherAccountIban([account({ iban: TRANSACTION, payee_iban: SAVINGS, invoice_payee: false }), savings])).toEqual([])
  })

  it('lists every affected account in list order', () => {
    const main = account({ iban: TRANSACTION, payee_iban: SAVINGS })
    const euro = account({ id: 'ca-3', ledger_account: '1932', currency: 'EUR', is_primary: false, iban: null, payee_iban: TRANSACTION })
    expect(accountsPrintingOtherAccountIban([main, savings, euro]).map((hit) => [hit.account.id, hit.other.id])).toEqual([
      ['ca-1', 'ca-2'],
      ['ca-3', 'ca-1'],
    ])
  })
})
