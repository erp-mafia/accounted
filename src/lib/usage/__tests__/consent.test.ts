import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { acceptUsageCharges, consentCovers, readOpenConsents, revokeUsageCharges, type UsageConsent } from '../consent'
import { USAGE_PRICES } from '../kinds'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const at = (unit_price_ore: number): UsageConsent => ({
  kind: 'bank_payment',
  unit_price_ore,
  included: 10,
  accepted_by: 'u1',
  accepted_at: '2026-11-02T08:00:00Z',
})

describe('consentCovers', () => {
  it('covers today\'s price and anything lower, never a raised one or an included kind', () => {
    const price = USAGE_PRICES.bank_payment.unitPriceOre!
    expect(consentCovers(at(price), 'bank_payment')).toBe(true)
    expect(consentCovers(at(price + 50), 'bank_payment')).toBe(true)
    expect(consentCovers(at(price - 1), 'bank_payment')).toBe(false)
    expect(consentCovers(undefined, 'bank_payment')).toBe(false)
    expect(consentCovers({ ...at(999), kind: 'billo_send' }, 'billo_send')).toBe(false)
  })
})

describe('readOpenConsents', () => {
  it('reads only open acceptances of the company, by kind', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ company_id: COMPANY, ...at(200) }, { company_id: COMPANY, ...at(100), kind: 'nonsense' }] })

    const open = await readOpenConsents(supabase as unknown as SupabaseClient, COMPANY)

    expect([...open.keys()]).toEqual(['bank_payment'])
    expect(findCalls('usage_consents', 'eq')).toEqual([['company_id', COMPANY]])
    expect(findCalls('usage_consents', 'is')).toEqual([['revoked_at', null]])
  })

  it('reads no acceptance while the table is not there yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { code: '42P01', message: 'relation does not exist' } })
    expect((await readOpenConsents(supabase as unknown as SupabaseClient, COMPANY)).size).toBe(0)
  })
})

describe('acceptUsageCharges', () => {
  it('records who accepted, at today\'s price and the included amount shown', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: at(200) })

    const consent = await acceptUsageCharges(supabase as unknown as SupabaseClient, { companyId: COMPANY, kind: 'bank_payment', userId: 'u1', included: 10 })

    expect(consent.unit_price_ore).toBe(200)
    expect(findCalls('usage_consents', 'insert')).toEqual([
      [{ company_id: COMPANY, kind: 'bank_payment', unit_price_ore: 200, included: 10, accepted_by: 'u1' }],
    ])
  })

  it('keeps an acceptance that already covers today\'s price', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ company_id: COMPANY, ...at(200) }] })

    await acceptUsageCharges(supabase as unknown as SupabaseClient, { companyId: COMPANY, kind: 'bank_payment', userId: 'u2', included: 10 })

    expect(findCalls('usage_consents', 'insert')).toEqual([])
  })

  it('closes one given at a lower price before recording the new one', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ company_id: COMPANY, ...at(150) }] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: at(200) })

    await acceptUsageCharges(supabase as unknown as SupabaseClient, { companyId: COMPANY, kind: 'bank_payment', userId: 'u2', included: 10 })

    expect(findCalls('usage_consents', 'update')).toEqual([[{ revoked_at: expect.any(String), revoked_by: 'u2' }]])
    expect(findCalls('usage_consents', 'insert')).toHaveLength(1)
  })

  it('refuses a kind without a price to accept', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      acceptUsageCharges(supabase as unknown as SupabaseClient, { companyId: COMPANY, kind: 'billo_send', userId: 'u1', included: 0 }),
    ).rejects.toThrow(/no price/)
  })
})

describe('revokeUsageCharges', () => {
  it('closes the open acceptance with who and when', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await revokeUsageCharges(supabase as unknown as SupabaseClient, { companyId: COMPANY, kind: 'peppol_send', userId: 'u1' })

    expect(findCalls('usage_consents', 'update')).toEqual([[{ revoked_at: expect.any(String), revoked_by: 'u1' }]])
    expect(findCalls('usage_consents', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['kind', 'peppol_send'],
    ])
    expect(findCalls('usage_consents', 'is')).toEqual([['revoked_at', null]])
  })
})
