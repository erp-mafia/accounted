import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const getDeadlines = vi.fn()
vi.mock('@/lib/deadlines/status-engine', () => ({
  getDeadlinesNeedingAttention: (...a: unknown[]) => getDeadlines(...a),
}))

import { buildAssistantSnapshot } from '../snapshot'

/**
 * company_settings answers maybeSingle(); employees answers the awaited head
 * count (the builder chain is thenable, like the real PostgREST builder).
 */
function supabaseWith(
  settings: Record<string, unknown> | null,
  activeEmployees: number | null = null,
): SupabaseClient {
  return {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: table === 'company_settings' ? settings : null, error: null }),
        then: (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({ count: table === 'employees' ? activeEmployees : null, error: null }).then(
            onFulfilled,
          ),
      }
      return chain
    },
  } as unknown as SupabaseClient
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
  })

  describe('the salary fact', () => {
    // pays_salaries is NOT NULL DEFAULT false and only the Skatt settings form
    // writes it, so false is what every company that never opened that form
    // reads. Claiming "betalar inte löner" from it told a payroll-running
    // aktiebolag in every answer that it had no salaries.
    it('claims nothing when the flag is merely at its column default', async () => {
      const snap = await buildAssistantSnapshot(
        supabaseWith({ vat_registered: true, pays_salaries: false, employer_registered: null }, 0),
        'c1',
      )
      expect(snap).not.toContain('betalar inte löner')
      expect(snap).not.toContain('betalar löner')
      expect(snap).toContain('Status: momsregistrerad.')
    })

    it('derives it from active employees when the flag was never set', async () => {
      const snap = await buildAssistantSnapshot(
        supabaseWith({ vat_registered: true, pays_salaries: false, employer_registered: null }, 1),
        'c1',
      )
      expect(snap).toContain('betalar löner (1 anställd)')
    })

    it('pluralises the headcount', async () => {
      const snap = await buildAssistantSnapshot(
        supabaseWith({ vat_registered: true, pays_salaries: false }, 3),
        'c1',
      )
      expect(snap).toContain('betalar löner (3 anställda)')
    })

    it('accepts an attested employer registration as the positive fact', async () => {
      const snap = await buildAssistantSnapshot(
        supabaseWith({ vat_registered: true, pays_salaries: false, employer_registered: true }, 0),
        'c1',
      )
      expect(snap).toContain('betalar löner')
    })

    it('states the negative only from an attested employer_registered = false', async () => {
      const snap = await buildAssistantSnapshot(
        supabaseWith({ vat_registered: true, pays_salaries: false, employer_registered: false }, 0),
        'c1',
      )
      expect(snap).toContain('betalar inte löner')
    })
  })

  it('tells the model where the profile values are edited', async () => {
    const snap = await buildAssistantSnapshot(supabaseWith({ vat_registered: true }), 'c1')
    expect(snap).toContain('Inställningar > Skatt')
    expect(snap).toContain('Inställningar > Bokföring')
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
