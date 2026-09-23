import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FISCAL_YEAR_INVENTORY_CAP,
  loadFiscalYearInventory,
  renderFiscalYearInventory,
} from '../fiscal-years'

function supabaseReturning(result: { data?: unknown; error?: unknown } | Error): {
  supabase: SupabaseClient
  calls: { method: string; args: unknown[] }[]
} {
  const calls: { method: string; args: unknown[] }[] = []
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order', 'limit']) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    }
  }
  chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(
      onFulfilled,
      onRejected,
    )
  return { supabase: { from: () => chain } as unknown as SupabaseClient, calls }
}

describe('loadFiscalYearInventory', () => {
  it('reads the company periods newest first, capped', async () => {
    const rows = [
      { id: 'a', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false },
    ]
    const { supabase, calls } = supabaseReturning({ data: rows, error: null })
    expect(await loadFiscalYearInventory(supabase, 'c1')).toEqual(rows)
    expect(calls).toContainEqual({ method: 'eq', args: ['company_id', 'c1'] })
    expect(calls).toContainEqual({ method: 'order', args: ['period_start', { ascending: false }] })
    expect(calls).toContainEqual({ method: 'limit', args: [FISCAL_YEAR_INVENTORY_CAP] })
  })

  it('is best-effort: a failing query yields an empty list', async () => {
    const { supabase } = supabaseReturning(new Error('db down'))
    expect(await loadFiscalYearInventory(supabase, 'c1')).toEqual([])
    const nulled = supabaseReturning({ data: null, error: { message: 'x' } })
    expect(await loadFiscalYearInventory(nulled.supabase, 'c1')).toEqual([])
  })
})

describe('renderFiscalYearInventory', () => {
  it('marks the newest and the closed years and carries the period_id', () => {
    expect(
      renderFiscalYearInventory([
        { id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false },
        { id: 'fp-2025', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true },
        { id: 'fp-2024', name: '2024', period_start: '2024-05-01', period_end: '2025-04-30', is_closed: false },
      ]),
    ).toBe(
      'Räkenskapsår (senaste först): 2026-01-01..2026-12-31 period_id=fp-2026 (senaste); ' +
        '2025-01-01..2025-12-31 period_id=fp-2025 (avslutat); ' +
        '2024-05-01..2025-04-30 period_id=fp-2024.',
    )
  })

  it('is null for a company without periods, so the caller drops the line', () => {
    expect(renderFiscalYearInventory([])).toBeNull()
  })
})
