import { describe, it, expect } from 'vitest'
import {
  cashAccountBankName,
  cashAccountKontoLabel,
  cashAccountLogoUrl,
  type CashAccountWithBank,
} from '../labels'

// Synthetic fixtures: no real IBANs or account numbers.
function account(overrides: Partial<CashAccountWithBank>): CashAccountWithBank {
  return {
    id: 'ca-1',
    name: 'Bolaget AB',
    ledger_account: '1931',
    iban: 'LT000000000000012345',
    bank_connection: { bank_name: 'Revolut' },
    // Payee columns: what invoices print, never the account's identity.
    bank_name: null,
    clearing_number: null,
    account_number: null,
    ...overrides,
  } as CashAccountWithBank
}

describe('cashAccountKontoLabel', () => {
  it('names the connection bank and the IBAN tail, ignoring the printed payee', () => {
    // The reported case: another bank's payee details backfilled onto the
    // Revolut SEK account. The row still belongs to Revolut.
    const revolut = account({ bank_name: 'Northmill', clearing_number: '9999', account_number: '1234567' })
    expect(cashAccountKontoLabel(revolut)).toBe('Revolut ••2345')
    expect(cashAccountBankName(revolut)).toBe('Revolut')
  })

  it('strips whitespace from a spaced IBAN before taking the tail', () => {
    expect(cashAccountKontoLabel(account({ iban: 'SE00 0000 0000 0000 0000 6789' }))).toBe('Revolut ••6789')
  })

  it('falls back to the account name and ledger for an account without a connection', () => {
    const manual = account({ bank_connection: null, name: 'Företagskonto', iban: null, ledger_account: '1930' })
    expect(cashAccountKontoLabel(manual)).toBe('Företagskonto 1930')
  })

  it('shows only the ledger account when nothing names the bank', () => {
    expect(cashAccountKontoLabel(account({ bank_connection: null, name: null, iban: null }))).toBe('1931')
    expect(cashAccountBankName(account({ bank_connection: null, name: null }))).toBeNull()
  })

  it('uses the account name when the connection carries no bank name', () => {
    expect(cashAccountBankName(account({ bank_connection: { bank_name: null }, name: 'Lunar Business' }))).toBe(
      'Lunar Business',
    )
  })
})

describe('cashAccountLogoUrl', () => {
  it('resolves the mark from the connection bank, not the printed payee', () => {
    expect(cashAccountLogoUrl(account({ bank_name: 'Northmill' }))).toBe('/logos/banks/revolut.png')
  })

  it('falls back to the account name when the connection name has no mark', () => {
    expect(cashAccountLogoUrl(account({ bank_connection: { bank_name: 'Vadstena Sparbank' }, name: 'Swedbank Företag' })))
      .toBe('/logos/banks/swedbank.png')
  })

  it('returns null for the monogram fallback', () => {
    expect(cashAccountLogoUrl(account({ bank_connection: null, name: 'Kassa' }))).toBeNull()
  })
})
