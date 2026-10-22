import { describe, expect, it } from 'vitest'
import { enableBankingOffers } from '../bank-coverage'

describe('enableBankingOffers', () => {
  it('offers every bank while Open Payments is closed to the company', () => {
    expect(enableBankingOffers(false)).toBeUndefined()
  })

  it('offers only the banks Open Payments does not reach once it is open (crm#1363)', () => {
    const offered = enableBankingOffers(true)!
    // A Swedbank customer on Open Payments connects through Koppla bank, never the earlier provider's list.
    for (const name of ['Swedbank', 'Handelsbanken', 'Nordea', 'SEB', 'Danske Bank', 'Svea Bank']) {
      expect(offered({ name })).toBe(false)
    }
    // The banks its "not reached" line sends to this list stay in it.
    for (const name of ['Wise', 'PayPal', 'Bank Norwegian', 'Nordea First Card', 'Juni']) {
      expect(offered({ name })).toBe(true)
    }
  })
})
