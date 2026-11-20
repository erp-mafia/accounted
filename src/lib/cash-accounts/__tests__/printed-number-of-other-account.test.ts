import { describe, it, expect } from 'vitest'
import type { CashAccount } from '@/types'
import { accountsPrintingOtherAccountNumber } from '../invoice-payee-rules'

// Swedbank style: a five-digit clearing and a ten-digit account number.
const CLEARING = '84521'
const MAIN_NUMBER = '9031234567'
const SAVINGS_NUMBER = '9037654321'

function account(overrides: Partial<CashAccount> = {}): CashAccount {
  return {
    id: 'ca-1',
    company_id: 'company-1',
    bank_connection_id: 'conn-1',
    external_uid: null,
    iban: null,
    bban: CLEARING + MAIN_NUMBER,
    payee_iban: null,
    bank_name: null,
    clearing_number: CLEARING,
    account_number: MAIN_NUMBER,
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

const savings = account({
  id: 'ca-2',
  name: 'Placeringskonto',
  ledger_account: '1931',
  is_primary: false,
  bban: CLEARING + SAVINGS_NUMBER,
  account_number: SAVINGS_NUMBER,
  invoice_payee: false,
})

describe('accountsPrintingOtherAccountNumber', () => {
  it('flags an account that prints the number of another account, with its own number as the fix', () => {
    const main = account({ account_number: SAVINGS_NUMBER })
    expect(accountsPrintingOtherAccountNumber([main, savings])).toEqual([
      { account: main, other: savings, printedAccountNumber: SAVINGS_NUMBER, ownAccountNumber: MAIN_NUMBER },
    ])
  })

  it('flags both accounts when their numbers are crossed', () => {
    const main = account({ account_number: '903 765 432-1' })
    const crossed = { ...savings, invoice_payee: true, account_number: MAIN_NUMBER }
    expect(accountsPrintingOtherAccountNumber([main, crossed]).map((hit) => [hit.account.id, hit.other.id, hit.ownAccountNumber])).toEqual([
      ['ca-1', 'ca-2', MAIN_NUMBER],
      ['ca-2', 'ca-1', SAVINGS_NUMBER],
    ])
  })

  it('finds the other account by its IBAN when it has no BBAN', () => {
    const main = account({ clearing_number: '5491', account_number: '0000003', bban: '54910000003' })
    const other = account({ id: 'ca-2', ledger_account: '1931', bban: null, iban: 'SE4550000000058398257466', invoice_payee: false })
    const printingOther = { ...main, account_number: '8398257' }
    expect(accountsPrintingOtherAccountNumber([printingOther, other])).toEqual([
      { account: printingOther, other, printedAccountNumber: '8398257', ownAccountNumber: '0000003' },
    ])
  })

  it('offers no one-click fix when the BBAN does not start with the printed clearing number', () => {
    // Handelsbanken style: the bank sends the account number without clearing.
    const main = account({ clearing_number: '6789', account_number: '987654321', bban: '123456789' })
    const other = account({ id: 'ca-2', ledger_account: '1931', bban: '987654321', invoice_payee: false })
    expect(accountsPrintingOtherAccountNumber([main, other])[0].ownAccountNumber).toBeNull()
  })

  it('offers no one-click fix when the rest of the BBAN is no payable account number', () => {
    const main = account({ account_number: SAVINGS_NUMBER, bban: `${CLEARING}00000${MAIN_NUMBER}` })
    expect(accountsPrintingOtherAccountNumber([main, savings])[0].ownAccountNumber).toBeNull()
  })

  it('flags a typed account without a bank identity that prints a connected account, with no one-click fix', () => {
    const typed = account({ bank_connection_id: null, source: 'manual', bban: null, account_number: SAVINGS_NUMBER })
    expect(accountsPrintingOtherAccountNumber([typed, savings])).toEqual([
      { account: typed, other: savings, printedAccountNumber: SAVINGS_NUMBER, ownAccountNumber: null },
    ])
  })

  it('leaves an account alone that prints its own number, a number no other account has, or none', () => {
    expect(accountsPrintingOtherAccountNumber([account(), savings])).toEqual([])
    expect(accountsPrintingOtherAccountNumber([account({ account_number: '1112223334' }), savings])).toEqual([])
    expect(accountsPrintingOtherAccountNumber([account({ clearing_number: null, account_number: null, bankgiro: '5050-1234' }), savings])).toEqual([])
  })

  it('leaves an account alone that is not shown on invoices', () => {
    expect(accountsPrintingOtherAccountNumber([account({ account_number: SAVINGS_NUMBER, invoice_payee: false }), savings])).toEqual([])
  })
})
