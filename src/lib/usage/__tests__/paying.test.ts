import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { readCompanyPays, subscriptionPays } from '../paying'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const ACTIVE = { isSandbox: false, status: 'active', customerId: 'cus_1', subscriptionId: 'sub_1' }

describe('subscriptionPays', () => {
  it('counts only an active subscription of its own, outside a sandbox', () => {
    expect(subscriptionPays(ACTIVE)).toBe(true)
    for (const status of ['trialing', 'past_due', 'canceled', null]) expect(subscriptionPays({ ...ACTIVE, status })).toBe(false)
    expect(subscriptionPays({ ...ACTIVE, subscriptionId: null })).toBe(false)
    expect(subscriptionPays({ ...ACTIVE, customerId: null })).toBe(false)
    expect(subscriptionPays({ ...ACTIVE, isSandbox: true })).toBe(false)
  })
})

describe('readCompanyPays', () => {
  it('reads the company\'s subscription and sandbox flag', async () => {
    const db = createTableMockSupabase({
      company_subscriptions: { data: { status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' } },
      company_settings: { data: { is_sandbox: false } },
    })
    expect(await readCompanyPays(db.supabase as unknown as SupabaseClient, COMPANY)).toBe(true)
    expect(db.findCall('company_subscriptions', 'eq')).toEqual(['company_id', COMPANY])
  })

  it('reads a company with no subscription row (a trial grant, a free period) as not paying', async () => {
    const db = createTableMockSupabase({ company_subscriptions: { data: null }, company_settings: { data: { is_sandbox: false } } })
    expect(await readCompanyPays(db.supabase as unknown as SupabaseClient, COMPANY)).toBe(false)
  })

  it('throws on a failed read instead of guessing', async () => {
    const db = createTableMockSupabase({ company_subscriptions: { data: null, error: { message: 'boom' } } })
    await expect(readCompanyPays(db.supabase as unknown as SupabaseClient, COMPANY)).rejects.toThrow(/company_subscriptions read failed/)
  })
})
