import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const fetchAllRowsMock = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...args: unknown[]) => fetchAllRowsMock(...args),
}))

import { countAccountsNeedingVatReview } from '../categories'

const supabase = {} as SupabaseClient

function account(account_number: string, account_name: string, default_vat_treatment: string | null = null) {
  return {
    account_number,
    account_name,
    account_class: Number(account_number.charAt(0)),
    default_vat_rate: null,
    default_vat_treatment,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('countAccountsNeedingVatReview', () => {
  it('counts only the accounts the shared predicate flags', async () => {
    fetchAllRowsMock.mockResolvedValueOnce([
      account('3001', 'Försäljning inom Sverige, 25 % moms'),
      account('3045', 'Försäljning tjänster EU'),
      account('3046', 'Försäljning tjänster EU', 'reverse_charge_eu_services'),
      account('3047', 'Försäljning varor EU', 'standard_25'),
      account('5010', 'Lokalhyra'),
    ])
    expect(await countAccountsNeedingVatReview(supabase, 'company-1')).toBe(2)
  })

  it('soft-fails to 0 when the chart cannot be read', async () => {
    fetchAllRowsMock.mockRejectedValueOnce(new Error('boom'))
    expect(await countAccountsNeedingVatReview(supabase, 'company-1')).toBe(0)
  })
})
