import { describe, expect, it } from 'vitest'
import { bankReached, enableBankingOffers } from '../bank-coverage'

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
    // The banks its "not reached" line sends to this list stay in it: Svea
    // until a Svea consent through Open Payments reads transactions (crm#1424).
    for (const name of ['Wise', 'PayPal', 'Bank Norwegian', 'Nordea First Card', 'Juni', 'Svea Bank']) {
      expect(offered({ name })).toBe(true)
    }
  })
})

describe('bankReached', () => {
  it("takes the server's answer for the company when the list carried one, else the coverage list", () => {
    // A pilot company may go on with Svea; the list alone holds it back.
    expect(bankReached('Svea Bank', true)).toBe(true)
    expect(bankReached('Svea Bank', undefined)).toBe(false)
    expect(bankReached('Svea Bank', null)).toBe(false)
    expect(bankReached('Swedbank', false)).toBe(false)
    expect(bankReached('Swedbank', undefined)).toBe(true)
  })
})
