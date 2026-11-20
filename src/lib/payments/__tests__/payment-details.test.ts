import { describe, expect, it } from 'vitest'
import {
  cleanSupplierPaymentDetails,
  isValidBic,
  isValidIban,
  statedPayeeColumns,
} from '../payment-details'

describe('isValidIban', () => {
  it('accepts a real IBAN with or without spaces and rejects a misread digit', () => {
    expect(isValidIban('SE45 5000 0000 0583 9825 7466')).toBe(true)
    expect(isValidIban('DE89370400440532013000')).toBe(true)
    expect(isValidIban('SE4550000000058398257467')).toBe(false)
    expect(isValidIban('991-2346')).toBe(false)
    expect(isValidIban(null)).toBe(false)
  })
})

describe('isValidBic', () => {
  it('takes 8 or 11 characters only', () => {
    expect(isValidBic('ESSESESS')).toBe(true)
    expect(isValidBic('DEUTDEFF500')).toBe(true)
    expect(isValidBic('ESSE')).toBe(false)
  })
})

describe('cleanSupplierPaymentDetails', () => {
  it('keeps each valid detail on its own and drops the invalid ones', () => {
    expect(cleanSupplierPaymentDetails({ bankgiro: '5050-1055', plusgiro: '123-4', iban: 'SE45 5000 0000 0583 9825 7466', bic: 'essesess' })).toEqual({
      bankgiro: '5050-1055',
      iban: 'SE4550000000058398257466',
      bic: 'ESSESESS',
    })
    expect(cleanSupplierPaymentDetails({ bankgiro: '12', plusgiro: null })).toEqual({})
    expect(cleanSupplierPaymentDetails(null)).toEqual({})
  })
})

describe('statedPayeeColumns', () => {
  it('keeps what the document states even when the supplier card differs, validated', () => {
    // Unlike the backfill, the invoice's own giro is kept whatever the supplier
    // card says: the payment compares the two.
    expect(statedPayeeColumns({ bankgiro: '5050-1055', iban: 'SE45 5000 0000 0583 9825 7466', bic: 'essesess' })).toEqual({
      payee_bankgiro: '5050-1055',
      payee_plusgiro: null,
      payee_iban: 'SE4550000000058398257466',
      payee_bic: 'ESSESESS',
    })
  })

  it('stores nothing invalid and nothing when the document stated no payee', () => {
    expect(statedPayeeColumns({ bankgiro: '12', plusgiro: '123-4' })).toEqual({
      payee_bankgiro: null,
      payee_plusgiro: null,
      payee_iban: null,
      payee_bic: null,
    })
    expect(statedPayeeColumns(undefined)).toEqual({
      payee_bankgiro: null,
      payee_plusgiro: null,
      payee_iban: null,
      payee_bic: null,
    })
  })
})
