import { describe, it, expect } from 'vitest'
import { invoiceLacksCustomer } from '../invoice-customer'

describe('invoiceLacksCustomer', () => {
  it('is true when customer_id is null (the customer was deleted, crm#263)', () => {
    expect(invoiceLacksCustomer({ customer_id: null })).toBe(true)
  })

  it('is true when the customer join came back null', () => {
    expect(invoiceLacksCustomer({ customer_id: 'cust-1', customer: null })).toBe(true)
  })

  it('is false for an invoice with its customer', () => {
    expect(invoiceLacksCustomer({ customer_id: 'cust-1', customer: { id: 'cust-1' } })).toBe(false)
  })

  it('treats unselected fields as unknown, not missing', () => {
    expect(invoiceLacksCustomer({})).toBe(false)
    expect(invoiceLacksCustomer({ customer_id: 'cust-1' })).toBe(false)
  })
})
