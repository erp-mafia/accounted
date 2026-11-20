import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { readByraAgreements, readCompanyPayer, readCompanyPays, subscriptionPays } from '../paying'

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

describe('readCompanyPayer', () => {
  const byra = {
    company_subscriptions: { data: null },
    company_settings: { data: { is_sandbox: false } },
    companies: { data: { team_id: 'team-1' } },
    teams: { data: { name: 'Byrån AB', kind: 'byra' } },
  }

  it('names its own subscription first', async () => {
    const db = createTableMockSupabase({
      company_subscriptions: { data: { status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' } },
      company_settings: { data: { is_sandbox: false } },
    })
    expect(await readCompanyPayer(db.supabase as unknown as SupabaseClient, COMPANY)).toEqual({ kind: 'subscription' })
  })

  it('names the byrå for a client its active agreement covers', async () => {
    const db = createTableMockSupabase({ ...byra, capability_grants: { data: [{ expires_at: null }] } })
    expect(await readCompanyPayer(db.supabase as unknown as SupabaseClient, COMPANY)).toEqual({ kind: 'byra', teamName: 'Byrån AB' })
  })

  it('has no payer for a byrå client whose agreement ended, nor for a sandbox', async () => {
    const ended = createTableMockSupabase({ ...byra, capability_grants: { data: [{ expires_at: '2026-01-01T00:00:00Z' }] } })
    expect(await readCompanyPayer(ended.supabase as unknown as SupabaseClient, COMPANY)).toBeNull()
    const sandbox = createTableMockSupabase({ ...byra, company_settings: { data: { is_sandbox: true } }, capability_grants: { data: [{ expires_at: null }] } })
    expect(await readCompanyPays(sandbox.supabase as unknown as SupabaseClient, COMPANY)).toBe(false)
  })
})

describe('readByraAgreements', () => {
  it('maps each covered client to its byrå, leaving personal teams and seat grants out', async () => {
    const db = createTableMockSupabase({
      companies: { data: [{ id: 'c1', team_id: 't1' }, { id: 'c2', team_id: 't2' }, { id: 'c3', team_id: null }] },
      teams: { data: [{ id: 't1', name: 'Byrån AB', kind: 'byra' }, { id: 't2', name: 'Eget', kind: 'personal' }] },
      capability_grants: { data: [{ team_id: 't1', expires_at: null }, { team_id: 't2', expires_at: null }] },
    })
    expect(await readByraAgreements(db.supabase as unknown as SupabaseClient, ['c1', 'c2', 'c3'])).toEqual(new Map([['c1', { teamId: 't1', teamName: 'Byrån AB' }]]))
    expect(db.findCalls('capability_grants', 'neq')).toContainEqual(['capability_key', 'multi_user'])
  })

  it('throws on a failed read rather than bill a byrå client to nobody', async () => {
    const db = createTableMockSupabase({ companies: { data: null, error: { message: 'boom' } } })
    await expect(readByraAgreements(db.supabase as unknown as SupabaseClient, ['c1'])).rejects.toThrow(/companies read failed/)
  })
})
