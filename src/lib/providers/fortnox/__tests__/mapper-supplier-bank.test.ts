import { describe, expect, it } from 'vitest'
import { mapFortnoxToSupplier } from '../mapper'

/**
 * A Fortnox supplier keeps the clearing number apart from the account number
 * (ClearingNumber, BankAccountNumber), and names its IBAN, BIC and currency.
 * The import read the account number alone, so a supplier paid to a bank
 * account arrived without the clearing number payments need, and a foreign
 * supplier without its IBAN, BIC and currency.
 */

const SUPPLIER = {
  SupplierNumber: '7',
  Name: 'Lieferant GmbH',
  Active: true,
  ClearingNumber: '8327-9',
  BankAccountNumber: '123 456 789-0',
  IBAN: 'DE89370400440532013000',
  BIC: 'COBADEFFXXX',
  Currency: 'EUR',
}

describe('mapFortnoxToSupplier: bank details', () => {
  it('reads the clearing number, the account, the IBAN, the BIC and the currency', () => {
    expect(mapFortnoxToSupplier(SUPPLIER)).toMatchObject({
      clearingNumber: '8327-9',
      bankAccount: '123 456 789-0',
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
      currencyCode: 'EUR',
    })
  })

  it('reads an empty field as no value', () => {
    expect(mapFortnoxToSupplier({ ...SUPPLIER, ClearingNumber: '', IBAN: ' ', BIC: '', Currency: '' }))
      .toMatchObject({ clearingNumber: undefined, iban: undefined, bic: undefined, currencyCode: undefined })
  })
})
