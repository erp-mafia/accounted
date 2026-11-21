/**
 * loadMappings is the one reader of sie_account_mappings (product issue #58,
 * 1000-row cap). A company that imported a provider's full chart remembers
 * up to 3,515 mappings in production; an unpaged read returned an arbitrary
 * 1,000, so a remembered mapping past the cut fell back to a suggestion.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createPagedMockSupabase, manyRows, POSTGREST_MAX_ROWS } from '@/tests/helpers'
import { loadMappings } from '../sie-import'

const COMPANY_ID = 'company-1'

const mappingRow = (i: number) => ({
  id: `mapping-${i}`,
  user_id: 'user-1',
  company_id: COMPANY_ID,
  source_account: String(100000 + i),
  source_name: `Konto ${i}`,
  target_account: '4010',
  confidence: 1,
  match_type: 'manual',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
})

describe('loadMappings', () => {
  it('returns every remembered mapping past the 1,000-row page', async () => {
    const rows = manyRows(2500, mappingRow)
    const { supabase, findCalls } = createPagedMockSupabase({ sie_account_mappings: rows })

    const stored = await loadMappings(supabase as unknown as SupabaseClient, COMPANY_ID)

    expect(stored).toHaveLength(2500)
    expect(stored.map((m) => m.source_account)).toEqual(rows.map((r) => r.source_account))
    // Windows of one page each, never one unpaged read: two one by one,
    // then three at once (the two past the short page come back empty).
    expect(findCalls('sie_account_mappings', 'range')).toEqual([
      [0, POSTGREST_MAX_ROWS - 1],
      [POSTGREST_MAX_ROWS, 2 * POSTGREST_MAX_ROWS - 1],
      [2 * POSTGREST_MAX_ROWS, 3 * POSTGREST_MAX_ROWS - 1],
      [3 * POSTGREST_MAX_ROWS, 4 * POSTGREST_MAX_ROWS - 1],
      [4 * POSTGREST_MAX_ROWS, 5 * POSTGREST_MAX_ROWS - 1],
    ])
  })

  it('filters by company and orders by source_account, unique per company, so pages never overlap', async () => {
    const { supabase, findCalls } = createPagedMockSupabase({ sie_account_mappings: manyRows(3, mappingRow) })

    const stored = await loadMappings(supabase as unknown as SupabaseClient, COMPANY_ID)

    expect(stored).toHaveLength(3)
    expect(findCalls('sie_account_mappings', 'eq')).toEqual([['company_id', COMPANY_ID]])
    expect(findCalls('sie_account_mappings', 'order')).toEqual([['source_account']])
    expect(findCalls('sie_account_mappings', 'range')).toEqual([[0, POSTGREST_MAX_ROWS - 1]])
  })

  it('returns an empty list for a company without remembered mappings', async () => {
    const { supabase } = createPagedMockSupabase()

    expect(await loadMappings(supabase as unknown as SupabaseClient, COMPANY_ID)).toEqual([])
  })

  it('throws on a read error instead of answering as if nothing were remembered', async () => {
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {}
        for (const method of ['select', 'eq', 'order']) chain[method] = () => chain
        chain.range = () => Promise.resolve({ data: null, error: { message: 'boom', code: '57014' } })
        return chain
      },
    }

    await expect(loadMappings(failing as unknown as SupabaseClient, COMPANY_ID)).rejects.toMatchObject({ code: '57014' })
  })
})
