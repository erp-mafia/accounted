import { describe, it, expect, vi } from 'vitest'
import { backfillStandardBASAccounts } from '../account-backfill'

/**
 * Flexible supabase mock: every chain method returns the chain; awaiting it
 * resolves the queued result for that table+operation. Inserts are captured.
 */
function createMockSupabase(opts: {
  existingRows?: { account_number: string }[]
  insertError?: { code?: string; message: string } | null
}) {
  const inserts: unknown[] = []
  const makeChain = (result: { data?: unknown; error?: unknown }) => {
    const chain: Record<string, unknown> = {}
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: result.data ?? null, error: result.error ?? null })
        }
        return (..._args: unknown[]) => new Proxy(chain, handler)
      },
    }
    return new Proxy(chain, handler)
  }

  const supabase = {
    from: vi.fn().mockImplementation(() => {
      const base: Record<string, unknown> = {
        select: () => makeChain({ data: opts.existingRows ?? [] }),
        insert: (rows: unknown) => {
          inserts.push(rows)
          return makeChain({ error: opts.insertError ?? null })
        },
      }
      return base
    }),
  }
  return { supabase, inserts }
}

describe('backfillStandardBASAccounts', () => {
  it('seeds a standard BAS account with full reference metadata', async () => {
    const { supabase, inserts } = createMockSupabase({ existingRows: [] })

    const result = await backfillStandardBASAccounts(
      supabase as never, 'company-1', 'user-1', ['3740'],
    )

    expect(result).toEqual(['3740'])
    expect(inserts).toHaveLength(1)
    const rows = inserts[0] as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      company_id: 'company-1',
      user_id: 'user-1',
      account_number: '3740',
      account_name: 'Öres- och kronutjämning',
      account_class: 3,
      account_group: '37',
      is_active: true,
      is_system_account: false,
      plan_type: 'full_bas',
    })
  })

  it('skips numbers that are not standard BAS accounts', async () => {
    const { supabase, inserts } = createMockSupabase({ existingRows: [] })

    const result = await backfillStandardBASAccounts(
      supabase as never, 'company-1', 'user-1', ['9999'],
    )

    expect(result).toEqual([])
    expect(inserts).toHaveLength(0)
  })

  it('never resurrects an existing (deactivated) account', async () => {
    // The caller saw 3740 as missing because it is INACTIVE: deactivation is
    // a deliberate user choice, so the backfill must not touch the row.
    const { supabase, inserts } = createMockSupabase({
      existingRows: [{ account_number: '3740' }],
    })

    const result = await backfillStandardBASAccounts(
      supabase as never, 'company-1', 'user-1', ['3740'],
    )

    expect(result).toEqual([])
    expect(inserts).toHaveLength(0)
  })

  it('treats a concurrent duplicate insert (23505) as success', async () => {
    const { supabase } = createMockSupabase({
      existingRows: [],
      insertError: { code: '23505', message: 'duplicate key value' },
    })

    const result = await backfillStandardBASAccounts(
      supabase as never, 'company-1', 'user-1', ['3740'],
    )

    expect(result).toEqual(['3740'])
  })

  it('returns [] on a non-duplicate insert error', async () => {
    const { supabase } = createMockSupabase({
      existingRows: [],
      insertError: { code: '42501', message: 'permission denied' },
    })

    const result = await backfillStandardBASAccounts(
      supabase as never, 'company-1', 'user-1', ['3740'],
    )

    expect(result).toEqual([])
  })

  it('seeds only the missing standard accounts from a mixed list', async () => {
    const { supabase, inserts } = createMockSupabase({
      existingRows: [{ account_number: '6580' }],
    })

    const result = await backfillStandardBASAccounts(
      supabase as never, 'company-1', 'user-1', ['3740', '6580', 'XYZ1'],
    )

    expect(result).toEqual(['3740'])
    const rows = inserts[0] as Record<string, unknown>[]
    expect(rows.map((r) => r.account_number)).toEqual(['3740'])
  })
})
