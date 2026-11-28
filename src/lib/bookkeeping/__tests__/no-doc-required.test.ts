import { describe, it, expect, vi } from 'vitest'
import { filterSetNoDocumentRequired, markEntriesNoDocRequired } from '@/lib/bookkeeping/no-doc-required'
import { journalEntriesFilterNoDocumentRequired } from '@/lib/operations/journal-entries'
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

describe('filterSetNoDocumentRequired: the list\'s Markera alla for an agent', () => {
  function ctxWith(pages: Array<{ total_count: number; ids: string[] }>) {
    const rpc = vi.fn()
    for (const page of pages) rpc.mockResolvedValueOnce({ data: { ok: true, ...page }, error: null })
    const upsert = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ upsert })
    const supabase = { rpc, from } as unknown as SupabaseClient
    return { ctx: { supabase, companyId: 'c1', userId: 'u1' } as never, rpc, upsert, from }
  }

  it('dry run counts the set the list shows and writes nothing', async () => {
    const { ctx, rpc, from } = ctxWith([{ total_count: 2200, ids: ['a'] }])
    const outcome = await filterSetNoDocumentRequired(ctx, { series: 'C', dateFrom: '2023-01-01', dateTo: '2023-12-31' }, null, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { would_exempt: 2200, series: 'C', include_imported: false } })
    expect(rpc).toHaveBeenCalledWith('list_verifikat_missing_underlag', expect.objectContaining({
      p_company_id: 'c1', p_series: 'C', p_date_from: '2023-01-01', p_date_to: '2023-12-31', p_limit: 1, p_include_imported: false,
    }))
    expect(from).not.toHaveBeenCalled()
  })

  it('marks every page of the set in one call', async () => {
    const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => `id-${from + i}`)
    const { ctx, upsert } = ctxWith([{ total_count: 1200, ids: ids(0, 1000) }, { total_count: 1200, ids: ids(1000, 200) }])
    const outcome = await filterSetNoDocumentRequired(ctx, { periodId: 'p1' }, 'Bokslutsposter', {})
    expect(outcome).toEqual({ ok: true, data: { exempted: 1200 } })
    expect(upsert).toHaveBeenCalledTimes(3)
    expect(upsert.mock.calls[0][0][0]).toMatchObject({ company_id: 'c1', user_id: 'u1', reason: 'Bokslutsposter' })
  })

  it('takes imported verifikat only when asked for', async () => {
    const { ctx, rpc } = ctxWith([{ total_count: 0, ids: [] }])
    await filterSetNoDocumentRequired(ctx, { periodId: 'p1', includeImported: true }, null, {})
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_include_imported: true })
  })

  it('answers NO_DOC_REQUIRED_FAILED when the set cannot be read', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'timeout', code: '57014' } })
    const ctx = { supabase: { rpc, from: vi.fn() }, companyId: 'c1', userId: 'u1' } as never
    const outcome = await filterSetNoDocumentRequired(ctx, { periodId: 'p1' }, null, {})
    expect(outcome).toMatchObject({ ok: false, code: 'NO_DOC_REQUIRED_FAILED' })
  })
})

describe('journal-entries.filter-no-document-required: its input', () => {
  it('needs at least one of period, series or dates', () => {
    const input = journalEntriesFilterNoDocumentRequired.input
    expect(input.safeParse({}).success).toBe(false)
    expect(input.safeParse({ reason: 'x' }).success).toBe(false)
    expect(input.safeParse({ series: 'C' }).success).toBe(true)
    expect(input.safeParse({ date_from: '2023-01-01' }).success).toBe(true)
    expect(input.safeParse({ series: 'all' }).success).toBe(false)
  })
})
