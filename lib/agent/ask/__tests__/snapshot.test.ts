import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const getDeadlines = vi.fn()
vi.mock('@/lib/deadlines/status-engine', () => ({
  getDeadlinesNeedingAttention: (...a: unknown[]) => getDeadlines(...a),
}))

import { buildAssistantSnapshot } from '../snapshot'

function supabaseWith(settings: Record<string, unknown> | null): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: settings, error: null }),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
  getDeadlines.mockResolvedValue({ overdue: [], actionNeeded: [] })
})

describe('buildAssistantSnapshot', () => {
  it('summarises the company status line', async () => {
    const snap = await buildAssistantSnapshot(
      supabaseWith({
        vat_registered: true,
        moms_period: 'quarterly',
        accounting_method: 'accrual',
        pays_salaries: true,
      }),
      'c1',
    )
    expect(snap).toContain('momsregistrerad (momsperiod: quarterly)')
    expect(snap).toContain('bokföringsmetod: fakturametod')
    expect(snap).toContain('betalar löner')
  })

  it('handles a non-VAT, cash-method company', async () => {
    const snap = await buildAssistantSnapshot(
      supabaseWith({ vat_registered: false, accounting_method: 'cash', pays_salaries: false }),
      'c1',
    )
    expect(snap).toContain('ej momsregistrerad')
    expect(snap).toContain('bokföringsmetod: kontantmetod')
    expect(snap).toContain('betalar inte löner')
  })

  it('lists deadlines that need attention (overdue first, capped)', async () => {
    getDeadlines.mockResolvedValue({
      overdue: [{ id: '1', title: 'Momsdeklaration', due_date: '2026-08-12', tax_deadline_type: 'vat' }],
      actionNeeded: [{ id: '2', title: 'Arbetsgivardeklaration', due_date: '2026-08-17', tax_deadline_type: 'employer' }],
    })
    const snap = await buildAssistantSnapshot(supabaseWith(null), 'c1')
    expect(snap).toContain('Deadlines som behöver åtgärd:')
    expect(snap).toContain('Momsdeklaration (2026-08-12)')
    expect(snap).toContain('Arbetsgivardeklaration (2026-08-17)')
  })

  it('is best-effort: a failing settings query still yields the deadlines line', async () => {
    const throwing = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => { throw new Error('db down') } }) }),
      }),
    } as unknown as SupabaseClient
    getDeadlines.mockResolvedValue({
      overdue: [],
      actionNeeded: [{ id: '2', title: 'Moms', due_date: '2026-09-12', tax_deadline_type: 'vat' }],
    })
    const snap = await buildAssistantSnapshot(throwing, 'c1')
    expect(snap).toContain('Moms (2026-09-12)')
  })

  it('returns an empty string when there is nothing to say', async () => {
    const snap = await buildAssistantSnapshot(supabaseWith(null), 'c1')
    expect(snap).toBe('')
  })
})
