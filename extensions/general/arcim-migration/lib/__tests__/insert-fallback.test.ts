import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { insertWithPerRowFallback } from '../insert-fallback'

/**
 * The chunked migration inserts are one PostgREST statement per chunk, so a
 * single bad row used to reject the whole chunk and report every row as
 * failed ("300 misslyckades"). The fallback must keep the bulk fast path,
 * retry per row only after a bulk failure, and attribute results by index.
 */

type InsertResult = { data: Record<string, unknown>[] | null; error: { message: string } | null }

/** Minimal supabase stand-in: scripted responses per insert call, in order. */
function makeSupabase(script: InsertResult[]) {
  let call = 0
  const inserted: unknown[] = []
  const from = vi.fn(() => ({
    insert: (rows: unknown) => {
      inserted.push(rows)
      const result = script[Math.min(call, script.length - 1)]
      call++
      return { select: () => Promise.resolve(result) }
    },
  }))
  return { supabase: { from } as unknown as SupabaseClient, inserted, calls: () => call }
}

const row = (n: number) => ({ invoice_number: `F-${n}` })

describe('insertWithPerRowFallback', () => {
  it('bulk success: one statement, results paired by index', async () => {
    const { supabase, calls } = makeSupabase([
      { data: [{ id: 'a' }, { id: 'b' }], error: null },
    ])

    const outcome = await insertWithPerRowFallback(supabase, 'invoices', [row(1), row(2)], 'id')

    expect(calls()).toBe(1)
    expect(outcome.failedCount).toBe(0)
    expect(outcome.firstError).toBeNull()
    expect(outcome.returned).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('bulk failure: retries per row, healthy rows land, offender is counted with its message', async () => {
    const dup = 'duplicate key value violates unique constraint "idx_invoices_company_invoice_number"'
    const { supabase, calls } = makeSupabase([
      { data: null, error: { message: dup } },   // bulk statement
      { data: [{ id: 'a' }], error: null },      // row 0
      { data: null, error: { message: dup } },   // row 1 (the offender)
      { data: [{ id: 'c' }], error: null },      // row 2
    ])

    const outcome = await insertWithPerRowFallback(supabase, 'invoices', [row(1), row(2), row(3)], 'id')

    expect(calls()).toBe(4)
    expect(outcome.returned).toEqual([{ id: 'a' }, null, { id: 'c' }])
    expect(outcome.failedCount).toBe(1)
    expect(outcome.firstError).toBe(dup)
  })

  it('bulk success with short read-back: never retries (rows are already in the table)', async () => {
    const { supabase, calls } = makeSupabase([
      { data: [{ id: 'a' }], error: null },  // succeeded, but returned 1 of 2
    ])

    const outcome = await insertWithPerRowFallback(supabase, 'customers', [row(1), row(2)], 'id')

    expect(calls()).toBe(1)
    expect(outcome.returned).toEqual([{ id: 'a' }, null])
    expect(outcome.failedCount).toBe(1)
    expect(outcome.firstError).toMatch(/could not be paired/)
  })

  it('empty input: no statements at all', async () => {
    const { supabase, calls } = makeSupabase([{ data: [], error: null }])

    const outcome = await insertWithPerRowFallback(supabase, 'invoices', [], 'id')

    expect(calls()).toBe(0)
    expect(outcome).toEqual({ returned: [], failedCount: 0, firstError: null })
  })
})
