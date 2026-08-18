import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ensureWebshopPrefillAccounts } from '../ensure-accounts'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'

/**
 * Minimal chart_of_accounts double: records what the helper selected,
 * updated and upserted so each assertion can check the exact call shape.
 */
function makeSupabase(options: {
  existing?: Array<{ id: string; account_number: string; is_active: boolean }>
  selectError?: { message: string }
  upsertError?: { message: string }
  updateError?: { message: string }
} = {}) {
  const calls = {
    selectedIn: [] as string[][],
    upserted: [] as Array<Record<string, unknown>>,
    upsertOptions: [] as unknown[],
    reactivatedIds: [] as string[][],
  }

  const from = vi.fn((table: string) => {
    expect(table).toBe('chart_of_accounts')
    return {
      select: () => ({
        eq: () => ({
          in: (_col: string, values: string[]) => {
            calls.selectedIn.push(values)
            return Promise.resolve({
              data: options.selectError ? null : (options.existing ?? []),
              error: options.selectError ?? null,
            })
          },
        }),
      }),
      update: (_patch: Record<string, unknown>) => ({
        in: (_col: string, ids: string[]) => {
          calls.reactivatedIds.push(ids)
          return {
            eq: () => Promise.resolve({ error: options.updateError ?? null }),
          }
        },
      }),
      upsert: (row: Record<string, unknown>, opts: unknown) => {
        calls.upserted.push(row)
        calls.upsertOptions.push(opts)
        return Promise.resolve({ error: options.upsertError ?? null })
      },
    }
  })

  return { supabase: { from } as unknown as SupabaseClient, calls, from }
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => log),
} as unknown as Logger

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ensureWebshopPrefillAccounts', () => {
  it('creates the prefill accounts that a seeded chart is missing', async () => {
    const { supabase, calls } = makeSupabase({ existing: [] })

    await ensureWebshopPrefillAccounts(supabase, 'company-1', 'user-1', ['1686', '3740'], log)

    // One literal-payload insert per account, so the phantom-column guard can
    // actually verify the columns.
    expect(calls.upserted).toHaveLength(2)
    expect(calls.upserted.map((r) => r.account_number).sort()).toEqual(['1686', '3740'])
    // BAS metadata comes from the reference, never invented.
    const clearing = calls.upserted.find((r) => r.account_number === '1686')!
    expect(clearing.account_name).toBe('Fordringar för kontokort och kuponger')
    expect(clearing.account_class).toBe(1)
    expect(clearing.account_type).toBe('asset')
    expect(clearing.normal_balance).toBe('debit')
    expect(clearing.company_id).toBe('company-1')
    expect(clearing.user_id).toBe('user-1')
    expect(clearing.is_active).toBe(true)
    // Concurrent bookings must not 23505 each other.
    expect(calls.upsertOptions[0]).toMatchObject({
      onConflict: 'company_id,account_number',
      ignoreDuplicates: true,
    })
  })

  it('never creates an account outside the closed prefill set', async () => {
    const { supabase, calls } = makeSupabase({ existing: [] })

    // 1930 and 4010 are legitimate accounts a user may have picked, and 9999
    // is a typo. None of them are ours to create.
    await ensureWebshopPrefillAccounts(
      supabase,
      'company-1',
      'user-1',
      ['1930', '4010', '9999'],
      log,
    )

    expect(calls.selectedIn).toHaveLength(0)
    expect(calls.upserted).toHaveLength(0)
  })

  it('does nothing when every prefill account is already active', async () => {
    const { supabase, calls } = makeSupabase({
      existing: [
        { id: 'a', account_number: '1686', is_active: true },
        { id: 'b', account_number: '3001', is_active: true },
      ],
    })

    await ensureWebshopPrefillAccounts(supabase, 'company-1', 'user-1', ['1686', '3001'], log)

    expect(calls.upserted).toHaveLength(0)
    expect(calls.reactivatedIds).toHaveLength(0)
  })

  it('reactivates a deactivated account instead of inserting a duplicate', async () => {
    // The engine treats is_active = false exactly like missing, so a user who
    // once hid 3740 would otherwise be stuck with an unbookable order.
    const { supabase, calls } = makeSupabase({
      existing: [{ id: 'row-3740', account_number: '3740', is_active: false }],
    })

    await ensureWebshopPrefillAccounts(supabase, 'company-1', 'user-1', ['3740'], log)

    expect(calls.reactivatedIds).toEqual([['row-3740']])
    expect(calls.upserted).toHaveLength(0)
  })

  it('deduplicates repeated account numbers from the submitted lines', async () => {
    const { supabase, calls } = makeSupabase({ existing: [] })

    await ensureWebshopPrefillAccounts(
      supabase,
      'company-1',
      'user-1',
      ['3001', '3001', '2611'],
      log,
    )

    expect(calls.selectedIn[0].sort()).toEqual(['2611', '3001'])
  })

  it('is a no-op for an empty line set', async () => {
    const { supabase, from } = makeSupabase()
    await ensureWebshopPrefillAccounts(supabase, 'company-1', 'user-1', [], log)
    expect(from).not.toHaveBeenCalled()
  })

  it('swallows a lookup failure so booking still reaches the engine', async () => {
    const { supabase, calls } = makeSupabase({ selectError: { message: 'rls denied' } })

    await expect(
      ensureWebshopPrefillAccounts(supabase, 'company-1', 'user-1', ['1686'], log),
    ).resolves.toBeUndefined()

    expect(calls.upserted).toHaveLength(0)
    expect(log.warn).toHaveBeenCalled()
  })

  it('swallows an insert failure so booking still reaches the engine', async () => {
    const { supabase } = makeSupabase({ existing: [], upsertError: { message: 'boom' } })

    await expect(
      ensureWebshopPrefillAccounts(supabase, 'company-1', 'user-1', ['1686'], log),
    ).resolves.toBeUndefined()

    expect(log.warn).toHaveBeenCalled()
  })
})
