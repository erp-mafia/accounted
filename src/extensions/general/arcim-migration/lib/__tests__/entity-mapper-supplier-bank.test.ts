import { describe, expect, it } from 'vitest'
import { mapSupplier, supplierBankAccount } from '../entity-mapper'
import { mapFortnoxToSupplier } from '@/lib/providers/fortnox/mapper'
import { mapVismaToSupplier } from '@/lib/providers/visma/mapper'
import { mapBokioToSupplier } from '@/lib/providers/bokio/mapper'
import { resolveSupplierPayee } from '@/lib/payments/supplier-payee'
import type { SupplierDto } from '@/lib/providers/dto'

/**
 * An imported supplier lands with the bank details the supplier form shows
 * and payments read: the clearing and account number, the IBAN, the BIC and
 * the currency it bills in. The account number used to go alone into the
 * free-text bank_account, which the form does not show and payments could
 * not route without its clearing number, and IBAN, BIC and currency were
 * never imported at all.
 */

const supplier = (over: Partial<SupplierDto> = {}): SupplierDto => ({
  id: '7', supplierNumber: '7', active: true, party: { name: 'Leverantör AB', identifications: [] }, ...over,
})

const bank = (row: Record<string, unknown>) => ({
  bank_account: row.bank_account, clearing_number: row.clearing_number, account_number: row.account_number,
  iban: row.iban, bic: row.bic, default_currency: row.default_currency,
})

describe('mapSupplier: bank details', () => {
  it('writes the clearing and account number a provider keeps apart, and the payee resolves to them', () => {
    const row = mapSupplier(supplier({ clearingNumber: '8327-9', bankAccount: '123 456 789-0' }), 'u', 'c')
    expect(bank(row)).toEqual({
      bank_account: undefined, clearing_number: '8327-9', account_number: '123 456 789-0', iban: null, bic: null, default_currency: 'SEK',
    })
    expect(resolveSupplierPayee({ bankgiro: null, plusgiro: null, bank_account: null, ...row } as never))
      .toEqual({ ok: true, payee: { type: 'bank_account', clearing: '83279', account: '1234567890' } })
  })

  it('splits an account typed with its clearing number in front, and keeps a bare one as the account', () => {
    expect(supplierBankAccount({ bankAccount: '3300-1234567' })).toEqual({ clearing_number: '3300', account_number: '1234567' })
    expect(supplierBankAccount({ bankAccount: '1234567' })).toEqual({ clearing_number: null, account_number: '1234567' })
    expect(supplierBankAccount({ clearingNumber: '3300' })).toEqual({ clearing_number: null, account_number: null })
  })

  it('writes a valid IBAN and BIC, normalised, and leaves out a malformed one', () => {
    expect(bank(mapSupplier(supplier({ iban: 'de89 3704 0044 0532 0130 00', bic: 'cobadeffxxx' }), 'u', 'c')))
      .toMatchObject({ iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' })
    expect(bank(mapSupplier(supplier({ iban: 'DE00 1234', bic: 'X' }), 'u', 'c'))).toMatchObject({ iban: null, bic: null })
  })

  it('keeps the currency the supplier bills in, and SEK for one Accounted does not book', () => {
    expect(mapSupplier(supplier({ currencyCode: 'eur' }), 'u', 'c').default_currency).toBe('EUR')
    expect(mapSupplier(supplier({ currencyCode: 'JPY' }), 'u', 'c').default_currency).toBe('SEK')
    expect(mapSupplier(supplier(), 'u', 'c').default_currency).toBe('SEK')
  })
})

describe('each provider\'s supplier, imported', () => {
  const expected = { clearing_number: '8327-9', account_number: '1234567', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', default_currency: 'EUR' }

  it('Fortnox', () => {
    expect(bank(mapSupplier(mapFortnoxToSupplier({
      SupplierNumber: '7', Name: 'Lieferant GmbH', ClearingNumber: '8327-9', BankAccountNumber: '1234567',
      IBAN: 'DE89370400440532013000', BIC: 'COBADEFFXXX', Currency: 'EUR',
    }), 'u', 'c'))).toMatchObject(expected)
  })

  it('Visma', () => {
    expect(bank(mapSupplier(mapVismaToSupplier({
      Id: 's-1', Name: 'Lieferant GmbH', Clearing: '8327-9', BankAccountNumber: '1234567',
      BankIban: 'DE89370400440532013000', BankBic: 'COBADEFFXXX', CurrencyCode: 'EUR',
    }), 'u', 'c'))).toMatchObject(expected)
  })

  it('Bokio, which pays a supplier one way', () => {
    const bokio = (paymentDetails: unknown) => bank(mapSupplier(mapBokioToSupplier({
      id: 's-1', name: 'Lieferant GmbH', currency: 'EUR', paymentDetails,
    }), 'u', 'c'))
    expect(bokio({ type: 'transfer', clearingNumber: '8327-9', accountNumber: '1234567' }))
      .toMatchObject({ clearing_number: '8327-9', account_number: '1234567', iban: null, default_currency: 'EUR' })
    expect(bokio({ type: 'internationalPayment', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' }))
      .toMatchObject({ clearing_number: null, account_number: null, iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' })
  })
})
