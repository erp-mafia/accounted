import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FALLBACK_CUSTOMER_PAYMENT_TERMS,
  resolveDefaultCustomerPaymentTerms,
} from '@/lib/customers/payment-terms'

function settingsClient(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const eq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ select }))
  return {
    client: { from } as unknown as Pick<SupabaseClient, 'from'>,
    from,
  }
}

describe('resolveDefaultCustomerPaymentTerms', () => {
  it('uses an explicit customer value without reading settings', async () => {
    const { client, from } = settingsClient({ data: null, error: null })

    await expect(resolveDefaultCustomerPaymentTerms(client, 'company-1', 14)).resolves.toBe(14)
    expect(from).not.toHaveBeenCalled()
  })

  it('inherits invoice_default_days from company settings', async () => {
    const { client } = settingsClient({ data: { invoice_default_days: 10 }, error: null })

    await expect(resolveDefaultCustomerPaymentTerms(client, 'company-1')).resolves.toBe(10)
  })

  it('uses the fallback only when the settings row is missing', async () => {
    const { client } = settingsClient({ data: null, error: null })

    await expect(resolveDefaultCustomerPaymentTerms(client, 'company-1')).resolves.toBe(
      FALLBACK_CUSTOMER_PAYMENT_TERMS,
    )
  })

  it('does not hide settings query failures behind the fallback', async () => {
    const queryError = new Error('settings unavailable')
    const { client } = settingsClient({ data: null, error: queryError })

    await expect(resolveDefaultCustomerPaymentTerms(client, 'company-1')).rejects.toBe(queryError)
  })
})
