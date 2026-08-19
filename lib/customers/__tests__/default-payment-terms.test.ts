import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveDefaultPaymentTerms } from '@/lib/customers/default-payment-terms'

function makeSettingsClient(result: { data: unknown; error?: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  return { client: { from } as unknown as SupabaseClient, from }
}

describe('resolveDefaultPaymentTerms', () => {
  it('returns the provided value without touching settings', async () => {
    const { client, from } = makeSettingsClient({ data: { invoice_default_days: 10 } })
    await expect(resolveDefaultPaymentTerms(client, 'company-1', 14)).resolves.toBe(14)
    expect(from).not.toHaveBeenCalled()
  })

  it('falls back to company_settings.invoice_default_days when nothing is provided', async () => {
    const { client } = makeSettingsClient({ data: { invoice_default_days: 10 } })
    await expect(resolveDefaultPaymentTerms(client, 'company-1', undefined)).resolves.toBe(10)
    await expect(resolveDefaultPaymentTerms(client, 'company-1', null)).resolves.toBe(10)
  })

  it('falls back to 30 when the company has no setting', async () => {
    const { client } = makeSettingsClient({ data: { invoice_default_days: null } })
    await expect(resolveDefaultPaymentTerms(client, 'company-1', undefined)).resolves.toBe(30)
  })

  it('falls back to 30 when the settings row is missing entirely', async () => {
    const { client } = makeSettingsClient({ data: null })
    await expect(resolveDefaultPaymentTerms(client, 'company-1', undefined)).resolves.toBe(30)
  })

  it('ignores a non-positive or non-integer stored setting', async () => {
    const zero = makeSettingsClient({ data: { invoice_default_days: 0 } })
    await expect(resolveDefaultPaymentTerms(zero.client, 'company-1', undefined)).resolves.toBe(30)
    const frac = makeSettingsClient({ data: { invoice_default_days: 12.5 } })
    await expect(resolveDefaultPaymentTerms(frac.client, 'company-1', undefined)).resolves.toBe(30)
  })
})
