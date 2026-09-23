import { describe, expect, it } from 'vitest'
import { buildSandboxCustomers } from '../customers'

describe('sandbox customer seed data', () => {
  it('sets the required VAT-validation state for every customer', () => {
    const customers = buildSandboxCustomers('user-1', 'company-1')

    expect(customers).toHaveLength(3)
    expect(customers.every((customer) => typeof customer.vat_number_validated === 'boolean')).toBe(
      true,
    )
    expect(customers.find((customer) => customer.customer_type === 'individual')).toMatchObject({
      name: 'Anna Lindström',
      vat_number_validated: false,
    })
  })
})
