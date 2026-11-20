import { describe, expect, it } from 'vitest'
import { mapFortnoxToCustomer, mapFortnoxToSupplier } from '../mapper'

/**
 * TermsOfPayment holds a code from the company's terms register. Fortnox's own
 * codes are the day count ("0", "10", "30"); any other code is not a number of
 * days and must not reach the importer as NaN.
 */
describe('Fortnox TermsOfPayment', () => {
  const customer = (terms: unknown) => mapFortnoxToCustomer({ CustomerNumber: '1', Name: 'Kund AB', TermsOfPayment: terms })
  const supplier = (terms: unknown) => mapFortnoxToSupplier({ SupplierNumber: '1', Name: 'Lev AB', TermsOfPayment: terms })

  it.each([['10', 10], ['30', 30], ['0', 0], [' 15 ', 15], [20, 20]])('reads the code %j as %i days', (code, days) => {
    expect(customer(code).defaultPaymentTermsDays).toBe(days)
    expect(supplier(code).defaultPaymentTermsDays).toBe(days)
  })

  it.each([['K'], ['30D'], [''], [null], [undefined], ['999'], ['-5'], ['1.5']])('leaves the code %j unknown', (code) => {
    expect(customer(code).defaultPaymentTermsDays).toBeUndefined()
    expect(supplier(code).defaultPaymentTermsDays).toBeUndefined()
  })
})
