import { describe, expect, it } from 'vitest'
import { bankCoveredByOpenPayments, bankReached, enableBankingOffers, enableBankingWayOn } from '../bank-coverage'

describe('bankCoveredByOpenPayments', () => {
  it('holds back only the banks missing from the Open Payments list in every country', () => {
    for (const name of ['Wise', 'PayPal', 'Bank Norwegian', 'Nordea First Card', 'Juni', 'Wamo', 'Pleo']) {
      expect(bankCoveredByOpenPayments(name)).toBe(false)
    }
  })

  it('counts Svea Bank as reached: Open Payments serves it under SVEASESS, signed on the bank\'s own page', () => {
    expect(bankCoveredByOpenPayments('Svea Bank')).toBe(true)
  })

  it('reaches the banks and savings banks on its list', () => {
    for (const name of ['SEB', 'Swedbank', 'Nordea', 'Handelsbanken', 'Lunar', 'Revolut', 'Sparbanken i Karlshamn', 'Skandia']) {
      expect(bankCoveredByOpenPayments(name)).toBe(true)
    }
  })
})

describe('enableBankingOffers', () => {
  it('offers every bank while Open Payments is closed to the company', () => {
    expect(enableBankingOffers(false)).toBeUndefined()
  })

  it('offers only the banks Open Payments does not reach once it is open (crm#1363)', () => {
    const offered = enableBankingOffers(true)!
    // A Swedbank customer on Open Payments connects through Koppla bank, never the earlier provider's list.
    for (const name of ['Swedbank', 'Handelsbanken', 'Nordea', 'SEB', 'Danske Bank']) {
      expect(offered({ name })).toBe(false)
    }
    // The banks its "not reached" line sends to this list stay in it.
    for (const name of ['Wise', 'PayPal', 'Bank Norwegian', 'Nordea First Card', 'Juni', 'Wamo', 'Pleo']) {
      expect(offered({ name })).toBe(true)
    }
    expect(offered({ name: 'Svea Bank' })).toBe(false)
  })
})

describe('bankReached', () => {
  it("takes the server's answer for the company when the list carried one, else the coverage list", () => {
    // A pilot company may go on with a bank the list holds back.
    expect(bankReached('Wise', true)).toBe(true)
    expect(bankReached('Wise', undefined)).toBe(false)
    expect(bankReached('Wise', null)).toBe(false)
    expect(bankReached('Swedbank', false)).toBe(false)
    expect(bankReached('Swedbank', undefined)).toBe(true)
  })
})

describe('enableBankingWayOn', () => {
  it('sends an Enable Banking connection to the switch where the campaign applies and the new provider reaches the bank', () => {
    expect(enableBankingWayOn('Swedbank', true)).toBe('switch')
    expect(enableBankingWayOn('Svea Bank', true)).toBe('switch')
  })

  it('sends it to the bank file import where the new provider does not reach the bank', () => {
    expect(enableBankingWayOn('Wise', true)).toBe('import')
    expect(enableBankingWayOn('Nordea First Card', true)).toBe('import')
  })

  it('sends it to the bank file import where the campaign does not apply to the company, whatever the bank', () => {
    expect(enableBankingWayOn('Swedbank', false)).toBe('import')
    expect(enableBankingWayOn('Wise', false)).toBe('import')
  })
})
