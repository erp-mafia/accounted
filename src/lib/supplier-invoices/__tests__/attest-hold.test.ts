import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const mockWarn = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', async (importOriginal) => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn(), child: vi.fn() }
  logger.child.mockReturnValue(logger)
  return { ...(await importOriginal<typeof import('@/lib/logger')>()), createLogger: () => logger }
})

import { readAttestHold } from '../attest-hold'

const invoice = (over: Record<string, unknown> = {}) => ({
  user_id: 'alex',
  approved_at: null,
  is_credit_note: false,
  currency: 'SEK',
  total: 50_000,
  total_sek: 50_000,
  exchange_rate: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('readAttestHold', () => {
  it('holds an unattested invoice at or above the threshold, and lets one below it or attested through', async () => {
    const mock = createTableMockSupabase()
    mock.setTable('company_attest_policies', {
      data: { company_id: 'c1', enabled: true, threshold_amount: 10_000, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null },
    })
    mock.setTable('company_settings', { data: { accounting_method: 'accrual' } })

    const holds = await readAttestHold(mock.supabase as unknown as SupabaseClient, 'c1')

    expect(holds(invoice())).toBe(true)
    expect(holds(invoice({ total: 2_000, total_sek: 2_000 }))).toBe(false)
    expect(holds(invoice({ approved_at: '2026-11-01T10:00:00Z' }))).toBe(false)
  })

  it('holds nothing under kontantmetoden or without a policy', async () => {
    const cash = createTableMockSupabase()
    cash.setTable('company_attest_policies', {
      data: { company_id: 'c1', enabled: true, threshold_amount: null, mode: 'any', attesters: ['kim'], preparer_may_attest: false, updated_by: null, updated_at: null },
    })
    cash.setTable('company_settings', { data: { accounting_method: 'cash' } })
    expect((await readAttestHold(cash.supabase as unknown as SupabaseClient, 'c1'))(invoice())).toBe(false)

    const none = createTableMockSupabase()
    none.setTable('company_attest_policies', { data: null })
    none.setTable('company_settings', { data: { accounting_method: 'accrual' } })
    expect((await readAttestHold(none.supabase as unknown as SupabaseClient, 'c1'))(invoice())).toBe(false)
  })

  it('answers "not held" when it cannot read the policy, and logs it: the payment paths ask again and refuse', async () => {
    const mock = createTableMockSupabase()
    mock.setTable('company_attest_policies', { data: null, error: { message: 'statement timeout' } })
    mock.setTable('company_settings', { data: { accounting_method: 'accrual' } })

    const holds = await readAttestHold(mock.supabase as unknown as SupabaseClient, 'c1')

    expect(holds(invoice())).toBe(false)
    expect(mockWarn).toHaveBeenCalledWith('attest policy read for a supplier invoice list failed', expect.objectContaining({ companyId: 'c1' }))
  })

  it('throws when strict: a door whose answer is the population fails instead of calling a held invoice payable', async () => {
    const mock = createTableMockSupabase()
    mock.setTable('company_attest_policies', { data: null, error: { message: 'statement timeout' } })
    mock.setTable('company_settings', { data: { accounting_method: 'accrual' } })

    await expect(readAttestHold(mock.supabase as unknown as SupabaseClient, 'c1', { strict: true })).rejects.toMatchObject({
      message: 'statement timeout',
    })
    expect(mockWarn).not.toHaveBeenCalled()
  })
})
