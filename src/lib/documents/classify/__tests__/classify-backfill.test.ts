import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateStructured = vi.fn()
vi.mock('@/lib/arkiv/graph/snapshot', () => ({ markCompanyGraphStale: vi.fn() }))
vi.mock('@/lib/ai', () => ({
  getAiService: () => ({ generateStructured }),
  getAiStatus: vi.fn(() => ({ configured: true })),
}))

import { classifyUnclassifiedDocuments } from '../classify'

/**
 * The backfill never asks the model twice about one document. A document it
 * already classified stays untyped only when its row refuses the update (a
 * locked period), so asking again only spends a call: prod 2026-09-24, 29
 * such documents were classified about 300 times each in one day.
 */
function makeSupabase(untyped: string[], alreadyAsked: string[]) {
  const tables: string[] = []
  const nulls: string[] = []
  const from = (table: string) => {
    tables.push(table)
    const api: Record<string, unknown> = {}
    const chain = () => api
    Object.assign(api, { select: chain, eq: chain, not: chain, gt: chain, order: chain })
    api.is = (k: string) => { nulls.push(k); return api }
    api.limit = (n: number) => Promise.resolve({ data: untyped.slice(0, n).map((id) => ({ id })), error: null })
    api.in = (_k: string, ids: string[]) => Promise.resolve({ data: alreadyAsked.filter((id) => ids.includes(id)).map((document_id) => ({ document_id })), error: null })
    // Whatever else classifyDocument reads finds nothing: the document is skipped, and counted as processed.
    api.maybeSingle = () => Promise.resolve({ data: null, error: null })
    return api
  }
  return { supabase: { from } as never, tables, nulls }
}

beforeEach(() => vi.clearAllMocks())

describe('classifyUnclassifiedDocuments', () => {
  it('asks nothing when the model already classified every untyped document', async () => {
    const { supabase, tables } = makeSupabase(['a', 'b'], ['a', 'b'])
    expect(await classifyUnclassifiedDocuments(supabase, 'co-1', 10)).toEqual({ processed: 0, classified: 0, held: 0, skipped: 0, errors: 0 })
    expect(generateStructured).not.toHaveBeenCalled()
    expect(tables).not.toContain('companies')
  })

  it('takes only the documents never asked, up to the limit', async () => {
    const { supabase } = makeSupabase(['a', 'b', 'c', 'd'], ['a', 'c'])
    expect((await classifyUnclassifiedDocuments(supabase, 'co-1', 10)).processed).toBe(2)
    expect((await classifyUnclassifiedDocuments(makeSupabase(['a', 'b', 'c', 'd'], []).supabase, 'co-1', 3)).processed).toBe(3)
  })

  it('never types a booked document in the background: it is typed when someone opens it', async () => {
    const { supabase, nulls } = makeSupabase(['a'], [])
    await classifyUnclassifiedDocuments(supabase, 'co-1', 10)
    expect(nulls).toEqual(expect.arrayContaining(['journal_entry_id', 'journal_entry_line_id']))
  })
})
