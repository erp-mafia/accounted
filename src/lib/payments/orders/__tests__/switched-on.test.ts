import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn() }))

import { hasCapability } from '@/lib/entitlements/has-capability'
import type { SupabaseClient } from '@supabase/supabase-js'
import { registerPaymentInitiationProvider, resetPaymentInitiationProviders } from '@/lib/payments/initiation/provider'
import { fakeProvider } from './fixtures'
import { openPaymentsDoor, paymentsPilot } from '../switched-on'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const supabase = {} as SupabaseClient
const entitled = vi.mocked(hasCapability)

beforeEach(() => {
  resetPaymentInitiationProviders()
  entitled.mockReset()
  vi.stubEnv('OPENPAYMENTS_COMPANY_IDS', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('paymentsPilot', () => {
  it('is no pilot when unset or empty, everyone with *, and exactly the listed companies otherwise', () => {
    expect(paymentsPilot({})).toBeNull()
    expect(paymentsPilot({ OPENPAYMENTS_COMPANY_IDS: '' })).toBeNull()
    expect(paymentsPilot({ OPENPAYMENTS_COMPANY_IDS: '  ' })).toBeNull()
    expect(paymentsPilot({ OPENPAYMENTS_COMPANY_IDS: ' , ' })).toBeNull()
    expect(paymentsPilot({ OPENPAYMENTS_COMPANY_IDS: '*' })).toBe('all')
    const listed = paymentsPilot({ OPENPAYMENTS_COMPANY_IDS: 'co-2, co-1 ,co-3' })
    expect(listed).toBeInstanceOf(Set)
    expect([...(listed as Set<string>)]).toEqual(['co-2', 'co-1', 'co-3'])
  })
})

describe('openPaymentsDoor', () => {
  it('is closed without a registered provider, whatever the plan', async () => {
    entitled.mockResolvedValue(true)
    expect(await openPaymentsDoor({ supabase, companyId: COMPANY })).toEqual({ ok: false, reason: 'no_provider' })
    expect(entitled).not.toHaveBeenCalled()
  })

  it('opens for a company on a paid plan (a paid bank_sync grant, never the seeded trial) and closes for one without', async () => {
    const provider = fakeProvider()
    registerPaymentInitiationProvider(provider)
    entitled.mockResolvedValueOnce(true)
    const open = await openPaymentsDoor({ supabase, companyId: COMPANY })
    expect(open.ok && open.provider).toBe(provider)
    // Paid grants only: the provider charges per payment, so a cardless trial does not pay through the bank.
    expect(entitled).toHaveBeenCalledWith(supabase, COMPANY, 'bank_sync', { excludeTrial: true })

    entitled.mockResolvedValueOnce(false)
    expect(await openPaymentsDoor({ supabase, companyId: COMPANY })).toEqual({ ok: false, reason: 'subscription' })
  })

  it('during a pilot, opens only for the listed companies and never asks the plan', async () => {
    registerPaymentInitiationProvider(fakeProvider())
    entitled.mockResolvedValue(true)
    vi.stubEnv('OPENPAYMENTS_COMPANY_IDS', `other, ${COMPANY}`)
    const open = await openPaymentsDoor({ supabase, companyId: COMPANY })
    expect(open.ok).toBe(true)
    const paidButNotListed = await openPaymentsDoor({ supabase, companyId: '22222222-2222-4222-8222-222222222222' })
    expect(paidButNotListed).toEqual({ ok: false, reason: 'not_in_pilot' })
    expect(entitled).not.toHaveBeenCalled()
  })

  it('with * opens for everyone without asking the plan', async () => {
    registerPaymentInitiationProvider(fakeProvider())
    vi.stubEnv('OPENPAYMENTS_COMPANY_IDS', '*')
    expect((await openPaymentsDoor({ supabase, companyId: COMPANY })).ok).toBe(true)
    expect(entitled).not.toHaveBeenCalled()
  })
})
