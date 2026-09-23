import { describe, it, expect, vi } from 'vitest'
import { markEntriesNoDocRequired } from '@/lib/bookkeeping/no-doc-required'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeMock() {
  const upsert = vi.fn().mockResolvedValue({ error: null })
  const from = vi.fn().mockReturnValue({ upsert })
  return { supabase: { from } as unknown as SupabaseClient, upsert, from }
}

describe('markEntriesNoDocRequired', () => {
  it('writes nothing and returns 0 for an empty list', async () => {
    const { supabase, from } = makeMock()
    const n = await markEntriesNoDocRequired(supabase, 'c1', 'u1', [], null)
    expect(n).toBe(0)
    expect(from).not.toHaveBeenCalled()
  })

  it('inserts one chunk with the right rows, reason and conflict options', async () => {
    const { supabase, upsert, from } = makeMock()
    const n = await markEntriesNoDocRequired(supabase, 'c1', 'u1', ['a', 'b'], 'Importerad')
    expect(n).toBe(2)
    expect(from).toHaveBeenCalledWith('journal_entry_no_doc_required')
    expect(upsert).toHaveBeenCalledTimes(1)
    const [rows, opts] = upsert.mock.calls[0]
    expect(rows).toEqual([
      { journal_entry_id: 'a', company_id: 'c1', user_id: 'u1', reason: 'Importerad' },
      { journal_entry_id: 'b', company_id: 'c1', user_id: 'u1', reason: 'Importerad' },
    ])
    expect(opts).toEqual({ onConflict: 'journal_entry_id', ignoreDuplicates: true })
  })

  it('de-dupes ids and defaults reason to null', async () => {
    const { supabase, upsert } = makeMock()
    const n = await markEntriesNoDocRequired(supabase, 'c1', 'u1', ['a', 'a', 'b'], null)
    expect(n).toBe(2)
    const [rows] = upsert.mock.calls[0]
    expect(rows.map((r: { journal_entry_id: string }) => r.journal_entry_id)).toEqual(['a', 'b'])
    expect(rows[0].reason).toBeNull()
  })

  it('chunks large id lists into batches of 500', async () => {
    const { supabase, upsert } = makeMock()
    const ids = Array.from({ length: 1200 }, (_, i) => `id-${i}`)
    const n = await markEntriesNoDocRequired(supabase, 'c1', 'u1', ids, null)
    expect(n).toBe(1200)
    expect(upsert).toHaveBeenCalledTimes(3) // 500 + 500 + 200
    expect(upsert.mock.calls[0][0]).toHaveLength(500)
    expect(upsert.mock.calls[1][0]).toHaveLength(500)
    expect(upsert.mock.calls[2][0]).toHaveLength(200)
  })

  it('throws when an upsert errors', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    const supabase = { from: vi.fn().mockReturnValue({ upsert }) } as unknown as SupabaseClient
    await expect(
      markEntriesNoDocRequired(supabase, 'c1', 'u1', ['a'], null),
    ).rejects.toThrow('boom')
  })
})
