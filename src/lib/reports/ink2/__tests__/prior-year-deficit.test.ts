import { describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { priorYearDeficit, priorYearDeficitWarning } from '../prior-year-deficit'

const CURRENT = { period_start: '2025-01-01', previous_period_id: null }

describe('priorYearDeficit (INK2S 4.14 a reminder)', () => {
  it("gives last year's 4.16 underskott, whole kronor, with the year's name", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'period-0', name: 'Räkenskapsår 2024', period_end: '2024-12-31' } })
    const declarationOf = vi.fn(async () => ({ ink2s: { '7770': 84_210.9 } }))

    const hint = await priorYearDeficit(supabase as never, 'company-1', CURRENT, declarationOf)

    expect(hint).toEqual({ fiscalPeriodName: 'Räkenskapsår 2024', deficit: 84_210 })
    expect(declarationOf).toHaveBeenCalledWith('period-0')
    expect(priorYearDeficitWarning(hint!)).toContain('underskott på 84210 kr')
    expect(priorYearDeficitWarning(hint!)).toContain('punkt 4.14a')
  })

  it('is quiet when last year ended in an överskott', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'period-0', name: '2024', period_end: '2024-12-31' } })

    expect(await priorYearDeficit(supabase as never, 'company-1', CURRENT, async () => ({ ink2s: { '7770': 0 } }))).toBeNull()
  })

  it('is quiet without a previous year next to this one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const declarationOf = vi.fn()

    expect(await priorYearDeficit(supabase as never, 'company-1', CURRENT, declarationOf)).toBeNull()
    expect(declarationOf).not.toHaveBeenCalled()
  })

  it('never fails the declaration when last year cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'period-0', name: '2024', period_end: '2024-12-31' } })

    expect(
      await priorYearDeficit(supabase as never, 'company-1', CURRENT, async () => {
        throw new Error('no books')
      }),
    ).toBeNull()
  })
})
