import { describe, it, expect } from 'vitest'
import { isSendOrderSetupEnabled, sendOrderRollout } from '@/lib/invoices/send-order-rollout'

describe('send-order setup rollout', () => {
  it('is nobody when the list is unset or empty', () => {
    expect(sendOrderRollout({})).toEqual([])
    expect(sendOrderRollout({ INVOICE_SEND_ORDER_USER_IDS: '  ' })).toEqual([])
    expect(isSendOrderSetupEnabled('user-1', {})).toBe(false)
    expect(isSendOrderSetupEnabled('user-1', { INVOICE_SEND_ORDER_USER_IDS: '' })).toBe(false)
  })

  it('is everyone for *', () => {
    expect(isSendOrderSetupEnabled('user-1', { INVOICE_SEND_ORDER_USER_IDS: '*' })).toBe(true)
  })

  it('is the listed users only', () => {
    const env = { INVOICE_SEND_ORDER_USER_IDS: 'User-1, user-2,,user-1' }
    expect(sendOrderRollout(env)).toEqual(['user-1', 'user-2'])
    expect(isSendOrderSetupEnabled('USER-2', env)).toBe(true)
    expect(isSendOrderSetupEnabled('user-3', env)).toBe(false)
  })

  it('is nobody without a user', () => {
    expect(isSendOrderSetupEnabled(null, { INVOICE_SEND_ORDER_USER_IDS: '*' })).toBe(false)
    expect(isSendOrderSetupEnabled(undefined, { INVOICE_SEND_ORDER_USER_IDS: '*' })).toBe(false)
  })
})
