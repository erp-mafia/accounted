import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { completeTaxDeadline } from '../complete-tax-deadline'

/**
 * Chain mock that records every builder call and resolves to the given
 * result when awaited (the helper ends the chain with .select('id')).
 */
function makeSupabase(result: { data?: unknown; error?: unknown }) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const chain: Record<string, unknown> = {}
  for (const method of ['update', 'eq', 'in', 'select']) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    })
  }
  chain.then = (resolve: (v: unknown) => void) =>
    resolve({ data: result.data ?? null, error: result.error ?? null })

  const from = vi.fn(() => chain)
  return { supabase: { from } as unknown as SupabaseClient, from, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('completeTaxDeadline', () => {
  it('completes matching open deadlines and returns the count', async () => {
    const { supabase, from, calls } = makeSupabase({ data: [{ id: 'd1' }, { id: 'd2' }] })

    const result = await completeTaxDeadline(
      supabase, 'company-1', ['moms_monthly', 'moms_quarterly'], '2026-06', 'submitted',
    )

    expect(result).toEqual({ completed: 2 })
    expect(from).toHaveBeenCalledWith('deadlines')

    const updateCall = calls.find((c) => c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({
      is_completed: true,
      status: 'submitted',
    })
    expect((updateCall?.args[0] as Record<string, unknown>).completed_at).toBeTruthy()

    const eqArgs = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['company_id', 'company-1'])
    expect(eqArgs).toContainEqual(['tax_period', '2026-06'])
    expect(eqArgs).toContainEqual(['is_completed', false])

    const inCall = calls.find((c) => c.method === 'in')
    expect(inCall?.args).toEqual(['tax_deadline_type', ['moms_monthly', 'moms_quarterly']])
  })

  it('quarterly period string matches the generator format', async () => {
    const { supabase, calls } = makeSupabase({ data: [{ id: 'd1' }] })

    await completeTaxDeadline(supabase, 'company-1', ['moms_quarterly'], '2026-Q2', 'confirmed')

    const eqArgs = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqArgs).toContainEqual(['tax_period', '2026-Q2'])
    const updateCall = calls.find((c) => c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({ status: 'confirmed' })
  })

  it('is a no-op returning 0 when nothing matches', async () => {
    const { supabase } = makeSupabase({ data: [] })
    const result = await completeTaxDeadline(
      supabase, 'company-1', ['arbetsgivardeklaration'], '2026-01', 'submitted',
    )
    expect(result).toEqual({ completed: 0 })
  })

  it('swallows DB errors: logs and returns 0, never throws', async () => {
    const { supabase } = makeSupabase({ error: { message: 'permission denied' } })
    await expect(
      completeTaxDeadline(supabase, 'company-1', ['moms_monthly'], '2026-06', 'submitted'),
    ).resolves.toEqual({ completed: 0 })
  })
})
