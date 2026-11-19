import { beforeEach, describe, expect, it, vi } from 'vitest'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => log }))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: vi.fn(async () => false) }))
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn(async () => true) }))

import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeTransaction } from '@/tests/helpers'
import { planAssistantReads } from '../read'

const NOW = new Date('2026-10-26T12:00:00Z')
const opts = { perRun: 10, perCompany: 5, windowDays: 45, now: NOW }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('planAssistantReads', () => {
  it('skips a company whose legal form or VAT status cannot be read, and plans the others as they are', async () => {
    const first = makeTransaction({ id: 'tx-1', company_id: 'co-1', amount: -100, date: '2026-10-20' })
    const second = makeTransaction({ id: 'tx-2', company_id: 'co-2', amount: -200, date: '2026-10-19' })
    const { supabase } = createTableMockSupabase({
      transactions: { data: [first, second] },
      transaction_assistant_reads: { data: [] },
      companies: [{ data: null, error: { message: 'canceling statement due to statement timeout' } }, { data: { entity_type: 'aktiebolag' } }],
      company_settings: [{ data: { vat_registered: true } }, { data: { vat_registered: true } }],
    })

    const planned = await planAssistantReads(supabase as unknown as SupabaseClient, opts)

    // Not guessed as an unregistered enskild firma: the company waits for the next run.
    expect(planned).toEqual([{ companyId: 'co-2', entityType: 'aktiebolag', vatRegistered: true, tx: second }])
    expect(log.error).toHaveBeenCalledWith(
      'assistant reads skipped a company: its legal form or VAT status could not be read',
      expect.objectContaining({ companyId: 'co-1' }),
    )
  })

  it('fails the run when the candidates cannot be read, instead of planning nothing', async () => {
    const { supabase } = createTableMockSupabase({
      transactions: { data: null, error: { message: 'canceling statement due to statement timeout' } },
    })
    await expect(planAssistantReads(supabase as unknown as SupabaseClient, opts)).rejects.toThrow('assistant read candidates failed')
  })

  it('fails the run when the freshness of earlier reads cannot be read, instead of reading everything again', async () => {
    const { supabase } = createTableMockSupabase({
      transactions: { data: [makeTransaction({ id: 'tx-1', company_id: 'co-1', amount: -100, date: '2026-10-20' })] },
      transaction_assistant_reads: { data: null, error: { message: 'boom' } },
    })
    await expect(planAssistantReads(supabase as unknown as SupabaseClient, opts)).rejects.toThrow('assistant read freshness failed')
  })
})
