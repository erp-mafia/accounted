import { describe, it, expect, vi } from 'vitest'
import { syncMappedAccounts } from '../account-sync'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import type { AccountMapping } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'

// --- Helpers ---

function mapping(
  partial: Partial<AccountMapping> & { sourceAccount: string; targetAccount: string }
): AccountMapping {
  return {
    sourceName: '',
    targetName: '',
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
    ...partial,
  }
}

/**
 * Hand-rolled capturing mock (same approach as the importVouchers tests):
 * we need to inspect the rows passed to .insert() and the payload/filters of
 * .update(), which createQueuedMockSupabase cannot do.
 */
function buildCapturingSupabase(opts?: {
  existingAccounts?: Array<{ account_number: string; account_name: string }>
  insertError?: { message: string } | null
  updateError?: { message: string } | null
  selectError?: { message: string } | null
}) {
  const existing = opts?.existingAccounts ?? []
  const inserts: Array<Record<string, unknown>> = []
  const updates: Array<{
    payload: Record<string, unknown>
    filters: Record<string, string>
  }> = []

  const supabase = {
    from: vi.fn((table: string) => {
      if (table !== 'chart_of_accounts') throw new Error(`Unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            // Mirrors the stable `.order('account_number')` the sync query now
            // chains before `.range()` for paging stability.
            order: () => ({
            range: (from: number, to: number) => ({
              then: (
                resolve: (v: {
                  data: Array<{ account_number: string; account_name: string }> | null
                  error: { message: string } | null
                }) => void
              ) => {
                if (opts?.selectError) {
                  resolve({ data: null, error: opts.selectError })
                  return
                }
                resolve({ data: existing.slice(from, to + 1), error: null })
              },
            }),
            }),
          }),
        }),
        insert: (rows: Array<Record<string, unknown>>) => {
          inserts.push(...rows)
          return Promise.resolve({ error: opts?.insertError ?? null })
        },
        update: (payload: Record<string, unknown>) => {
          const filters: Record<string, string> = {}
          const chain = {
            eq(col: string, val: string) {
              filters[col] = val
              return chain
            },
            then(resolve: (v: { error: { message: string } | null }) => void) {
              updates.push({ payload, filters })
              resolve({ error: opts?.updateError ?? null })
            },
          }
          return chain
        },
      }
    }),
  }

  return { supabase: supabase as unknown as SupabaseClient, inserts, updates }
}

function run(
  supabase: SupabaseClient,
  mappings: AccountMapping[],
  updateAccountNames = true
) {
  return syncMappedAccounts(supabase, COMPANY_ID, USER_ID, mappings, updateAccountNames)
}

// --- Tests ---

describe('syncMappedAccounts: create pass', () => {
  it('creates a missing BAS account with the BAS default name when the file has no custom name', async () => {
    const { supabase, inserts } = buildCapturingSupabase()

    const result = await run(supabase, [
      mapping({ sourceAccount: '1930', targetAccount: '1930', sourceName: '' }),
    ])

    expect(result.error).toBeNull()
    expect(result.created).toBe(1)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].account_name).toBe(getBASReference('1930')!.account_name)
  })

  it('creates a missing BAS account with the #KONTO name from the file (identity mapping)', async () => {
    const { supabase, inserts } = buildCapturingSupabase()
    const basRef = getBASReference('1930')!

    const result = await run(supabase, [
      mapping({
        sourceAccount: '1930',
        targetAccount: '1930',
        sourceName: 'Företagskonto Swedbank',
        targetName: basRef.account_name,
      }),
    ])

    expect(result.error).toBeNull()
    expect(inserts).toHaveLength(1)
    // The customized Fortnox name wins over the BAS default…
    expect(inserts[0].account_name).toBe('Företagskonto Swedbank')
    // …while the rest of the metadata still comes from the BAS reference.
    expect(inserts[0].account_class).toBe(basRef.account_class)
    expect(inserts[0].account_type).toBe(basRef.account_type)
    expect(inserts[0].description).toBe(basRef.description)
    expect(inserts[0].sort_order).toBe(1930)
    expect(inserts[0].is_system_account).toBe(false)
    expect(inserts[0].company_id).toBe(COMPANY_ID)
  })

  it('keeps the BAS default name for a remapped (non-identity) target', async () => {
    const { supabase, inserts } = buildCapturingSupabase()

    await run(supabase, [
      mapping({
        sourceAccount: '1910',
        targetAccount: '1930',
        sourceName: 'Kassa special',
      }),
    ])

    // The file name describes source 1910, not target 1930.
    expect(inserts).toHaveLength(1)
    expect(inserts[0].account_name).toBe(getBASReference('1930')!.account_name)
  })

  it('creates a non-BAS sub-account with the file name when flag is on', async () => {
    // Precondition: 1932 is not in the BAS reference (bank sub-account).
    expect(getBASReference('1932')).toBeUndefined()
    const { supabase, inserts } = buildCapturingSupabase()

    await run(supabase, [
      mapping({
        sourceAccount: '1932',
        targetAccount: '1932',
        sourceName: 'Sparkonto SBAB',
        targetName: 'Sparkonto SBAB',
        matchType: 'bas_range',
      }),
    ])

    expect(inserts).toHaveLength(1)
    expect(inserts[0].account_name).toBe('Sparkonto SBAB')
    expect(inserts[0].account_class).toBe(1)
    expect(inserts[0].account_group).toBe('19')
    expect(inserts[0].account_type).toBe('asset')
    expect(inserts[0].normal_balance).toBe('debit')
  })

  it('uses the legacy targetName-first fallback for non-BAS accounts when flag is off', async () => {
    const { supabase, inserts } = buildCapturingSupabase()

    await run(
      supabase,
      [
        mapping({
          sourceAccount: '1932',
          targetAccount: '1932',
          sourceName: 'Sparkonto (källa)',
          targetName: 'Sparkonto (mål)',
        }),
      ],
      false
    )

    expect(inserts).toHaveLength(1)
    expect(inserts[0].account_name).toBe('Sparkonto (mål)')
  })

  it('creates with BAS defaults when flag is off, even with a custom file name', async () => {
    const { supabase, inserts } = buildCapturingSupabase()

    const result = await run(
      supabase,
      [
        mapping({
          sourceAccount: '1930',
          targetAccount: '1930',
          sourceName: 'Företagskonto Swedbank',
        }),
      ],
      false
    )

    expect(inserts[0].account_name).toBe(getBASReference('1930')!.account_name)
    expect(result.renamed).toBe(0)
  })

  it('ignores empty/whitespace #KONTO names', async () => {
    const { supabase, inserts, updates } = buildCapturingSupabase({
      existingAccounts: [{ account_number: '1510', account_name: 'Kundfordringar' }],
    })

    const result = await run(supabase, [
      mapping({ sourceAccount: '1510', targetAccount: '1510', sourceName: '   ' }),
      mapping({ sourceAccount: '1930', targetAccount: '1930', sourceName: '  ' }),
    ])

    expect(inserts).toHaveLength(1)
    expect(inserts[0].account_name).toBe(getBASReference('1930')!.account_name)
    expect(updates).toHaveLength(0)
    expect(result.renamed).toBe(0)
  })

  it('falls back to "Konto {nr}" for non-BAS accounts without any name', async () => {
    const { supabase, inserts } = buildCapturingSupabase()

    await run(supabase, [
      mapping({ sourceAccount: '1932', targetAccount: '1932', sourceName: '', targetName: '' }),
    ])

    expect(inserts[0].account_name).toBe('Konto 1932')
  })

  it('swallows duplicate-key insert errors (concurrent import race)', async () => {
    const { supabase } = buildCapturingSupabase({
      insertError: { message: 'duplicate key value violates unique constraint' },
    })

    const result = await run(supabase, [
      mapping({ sourceAccount: '1930', targetAccount: '1930' }),
    ])

    expect(result.error).toBeNull()
  })

  it('returns a fatal error for non-duplicate insert failures', async () => {
    const { supabase, updates } = buildCapturingSupabase({
      insertError: { message: 'permission denied' },
    })

    const result = await run(supabase, [
      mapping({ sourceAccount: '1930', targetAccount: '1930', sourceName: 'Eget namn' }),
    ])

    expect(result.error).toBe('permission denied')
    // Rename pass never runs after a fatal create error.
    expect(updates).toHaveLength(0)
  })

  it('returns a fatal error when the chart cannot be loaded', async () => {
    const { supabase, inserts } = buildCapturingSupabase({
      selectError: { message: 'connection refused' },
    })

    const result = await run(supabase, [
      mapping({ sourceAccount: '1930', targetAccount: '1930' }),
    ])

    expect(result.error).toBe('connection refused')
    expect(inserts).toHaveLength(0)
  })

  it('does nothing when no mappings have a target account', async () => {
    const { supabase } = buildCapturingSupabase()

    const result = await run(supabase, [
      mapping({ sourceAccount: '1930', targetAccount: '' }),
    ])

    expect(result).toEqual({
      created: 0,
      renamed: 0,
      renamedAccounts: [],
      renameFailed: 0,
      error: null,
    })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('syncMappedAccounts: rename pass', () => {
  it('renames an existing account whose name differs from the file (K1-seeded default)', async () => {
    const basName = getBASReference('1930')!.account_name
    const { supabase, inserts, updates } = buildCapturingSupabase({
      existingAccounts: [{ account_number: '1930', account_name: basName }],
    })

    const result = await run(supabase, [
      mapping({
        sourceAccount: '1930',
        targetAccount: '1930',
        sourceName: 'Företagskonto Swedbank',
        targetName: basName,
      }),
    ])

    expect(inserts).toHaveLength(0)
    expect(updates).toHaveLength(1)
    // Only the name is touched: never is_system_account or anything else.
    expect(Object.keys(updates[0].payload)).toEqual(['account_name'])
    expect(updates[0].payload.account_name).toBe('Företagskonto Swedbank')
    expect(updates[0].filters).toEqual({
      company_id: COMPANY_ID,
      account_number: '1930',
    })
    expect(result.renamed).toBe(1)
    expect(result.renamedAccounts).toEqual([
      { accountNumber: '1930', from: basName, to: 'Företagskonto Swedbank' },
    ])
  })

  it('is a no-op when the existing name already matches (idempotent re-sync)', async () => {
    const { supabase, updates } = buildCapturingSupabase({
      existingAccounts: [{ account_number: '1930', account_name: 'Företagskonto Swedbank' }],
    })

    const result = await run(supabase, [
      mapping({
        sourceAccount: '1930',
        targetAccount: '1930',
        sourceName: 'Företagskonto Swedbank',
      }),
    ])

    expect(updates).toHaveLength(0)
    expect(result.renamed).toBe(0)
  })

  it('never renames when the flag is off', async () => {
    const { supabase, updates } = buildCapturingSupabase({
      existingAccounts: [{ account_number: '1930', account_name: 'Gammalt namn' }],
    })

    const result = await run(
      supabase,
      [
        mapping({
          sourceAccount: '1930',
          targetAccount: '1930',
          sourceName: 'Företagskonto Swedbank',
        }),
      ],
      false
    )

    expect(updates).toHaveLength(0)
    expect(result.renamed).toBe(0)
  })

  it('does not rename a target from a non-identity mapping', async () => {
    const { supabase, updates } = buildCapturingSupabase({
      existingAccounts: [{ account_number: '1930', account_name: 'Företagskonto' }],
    })

    const result = await run(supabase, [
      mapping({
        sourceAccount: '1910',
        targetAccount: '1930',
        sourceName: 'Kassa special',
      }),
    ])

    expect(updates).toHaveLength(0)
    expect(result.renamed).toBe(0)
  })

  it('last #KONTO wins on duplicate identity mappings', async () => {
    const { supabase, updates } = buildCapturingSupabase({
      existingAccounts: [{ account_number: '1930', account_name: 'Gammalt namn' }],
    })

    const result = await run(supabase, [
      mapping({ sourceAccount: '1930', targetAccount: '1930', sourceName: 'Första' }),
      mapping({ sourceAccount: '1930', targetAccount: '1930', sourceName: 'Andra' }),
    ])

    expect(updates).toHaveLength(1)
    expect(updates[0].payload.account_name).toBe('Andra')
    expect(result.renamed).toBe(1)
  })

  it('renames multiple accounts concurrently and aggregates per-account results', async () => {
    const { supabase, updates } = buildCapturingSupabase({
      existingAccounts: [
        { account_number: '1930', account_name: 'Gammalt bankkonto' },
        { account_number: '1510', account_name: 'Gamla kundfordringar' },
        { account_number: '2440', account_name: 'Leverantörsskulder' },
      ],
    })

    const result = await run(supabase, [
      mapping({ sourceAccount: '1930', targetAccount: '1930', sourceName: 'Företagskonto Swedbank' }),
      mapping({ sourceAccount: '1510', targetAccount: '1510', sourceName: 'Kundfordringar SEK' }),
      // Unchanged name: must not produce an UPDATE.
      mapping({ sourceAccount: '2440', targetAccount: '2440', sourceName: 'Leverantörsskulder' }),
    ])

    expect(updates).toHaveLength(2)
    expect(result.renamed).toBe(2)
    expect(result.renameFailed).toBe(0)
    expect(result.renamedAccounts.map((r) => r.accountNumber).sort()).toEqual(['1510', '1930'])
    expect(result.renamedAccounts.find((r) => r.accountNumber === '1930')).toEqual({
      accountNumber: '1930',
      from: 'Gammalt bankkonto',
      to: 'Företagskonto Swedbank',
    })
  })

  it('counts failed renames as non-fatal', async () => {
    const { supabase } = buildCapturingSupabase({
      existingAccounts: [{ account_number: '1930', account_name: 'Gammalt namn' }],
      updateError: { message: 'permission denied' },
    })

    const result = await run(supabase, [
      mapping({ sourceAccount: '1930', targetAccount: '1930', sourceName: 'Nytt namn' }),
    ])

    expect(result.error).toBeNull()
    expect(result.renamed).toBe(0)
    expect(result.renameFailed).toBe(1)
  })

  it('handles mixed create + rename in one call', async () => {
    const { supabase, inserts, updates } = buildCapturingSupabase({
      existingAccounts: [
        { account_number: '1930', account_name: getBASReference('1930')!.account_name },
        { account_number: '1510', account_name: getBASReference('1510')!.account_name },
      ],
    })

    const result = await run(supabase, [
      // Existing, renamed in Fortnox → rename.
      mapping({ sourceAccount: '1930', targetAccount: '1930', sourceName: 'Huvudkonto' }),
      // Existing, untouched name → no-op.
      mapping({
        sourceAccount: '1510',
        targetAccount: '1510',
        sourceName: getBASReference('1510')!.account_name,
      }),
      // Missing, custom name → created with the file name.
      mapping({ sourceAccount: '3010', targetAccount: '3010', sourceName: 'Konsultarvoden' }),
    ])

    expect(result.error).toBeNull()
    expect(result.created).toBe(1)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].account_number).toBe('3010')
    expect(inserts[0].account_name).toBe('Konsultarvoden')
    expect(updates).toHaveLength(1)
    expect(updates[0].filters.account_number).toBe('1930')
    expect(result.renamed).toBe(1)
  })
})
