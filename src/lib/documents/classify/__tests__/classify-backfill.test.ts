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
type JobRow = { document_id: string; status: string; result: string | null; attempts: number; max_attempts: number; run_after: string | null; locked_at: string | null }
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()
const jobRow = (document_id: string, status: string, over: Partial<JobRow> = {}): JobRow => ({ document_id, status, result: null, attempts: status === 'queued' ? 0 : 1, max_attempts: 5, run_after: minutesAgo(1), locked_at: status === 'running' ? minutesAgo(1) : null, ...over })

function makeSupabase(untyped: string[], alreadyAsked: string[], schemaMissed: string[] = [], jobs: JobRow[] = []) {
  const tables: string[] = []
  const nulls: string[] = []
  const jobFilters: Record<string, unknown> = {}
  const from = (table: string) => {
    tables.push(table)
    const api: Record<string, unknown> = {}
    const chain = () => api
    Object.assign(api, { select: chain, not: chain, gt: chain, order: chain })
    api.eq = (k: string, v: unknown) => { if (table === 'document_jobs') jobFilters[k] = v; return api }
    api.is = (k: string) => { nulls.push(k); return api }
    api.limit = (n: number) => Promise.resolve({ data: untyped.slice(0, n).map((id) => ({ id })), error: null })
    // The documents' classify jobs answer the jobs read (a schema miss is one the queue settled); earlier verdicts the classifications read.
    const jobRows = [...schemaMissed.map((document_id) => jobRow(document_id, 'done', { result: 'skipped: schema_mismatch' })), ...jobs]
    api.in = (_k: string, ids: string[]) =>
      Promise.resolve({ data: table === 'document_jobs' ? jobRows.filter((j) => ids.includes(j.document_id)) : alreadyAsked.filter((id) => ids.includes(id)).map((document_id) => ({ document_id })), error: null })
    // Whatever else classifyDocument reads finds nothing: the document is skipped, and counted as processed.
    api.maybeSingle = () => Promise.resolve({ data: null, error: null })
    return api
  }
  return { supabase: { from } as never, tables, nulls, jobFilters }
}

beforeEach(() => vi.clearAllMocks())

describe('classifyUnclassifiedDocuments', () => {
  it('asks nothing when the model already classified every untyped document', async () => {
    const { supabase, tables } = makeSupabase(['a', 'b'], ['a', 'b'])
    expect(await classifyUnclassifiedDocuments(supabase, 'co-1', 10)).toEqual({ processed: 0, classified: 0, held: 0, skipped: 0, errors: 0, deferred: 0 })
    expect(generateStructured).not.toHaveBeenCalled()
    expect(tables).not.toContain('companies')
  })

  it('takes only the documents never asked, up to the limit', async () => {
    const { supabase } = makeSupabase(['a', 'b', 'c', 'd'], ['a', 'c'])
    expect((await classifyUnclassifiedDocuments(supabase, 'co-1', 10)).processed).toBe(2)
    expect((await classifyUnclassifiedDocuments(makeSupabase(['a', 'b', 'c', 'd'], []).supabase, 'co-1', 3)).processed).toBe(3)
  })

  it('does not ask again about a document whose answer the queue settled as a schema miss', async () => {
    // The same prompt gets the same answer: every five minutes would be 288 paid calls a day for one document.
    const { supabase, jobFilters } = makeSupabase(['a', 'b', 'c'], ['a'], ['b'])
    expect((await classifyUnclassifiedDocuments(supabase, 'co-1', 10)).processed).toBe(1)
    expect(jobFilters).toEqual({ kind: 'classify' })
    expect(await classifyUnclassifiedDocuments(makeSupabase(['b'], [], ['b']).supabase, 'co-1', 10)).toEqual({ processed: 0, classified: 0, held: 0, skipped: 0, errors: 0, deferred: 0 })
  })

  it('leaves a document to the queue while the queue will still classify it: both asked the model at minute :02', async () => {
    const jobs = [
      jobRow('a', 'queued'),
      jobRow('b', 'running'),
      // Failed with attempts left: the worker retries it after its backoff (up to four hours out), so the backfill
      // typing it meanwhile is the same call made twice.
      jobRow('c', 'failed', { attempts: 2, run_after: new Date(Date.now() + 30 * 60_000).toISOString() }),
      // A job that ended (typed nothing, or gave up) no longer holds the document: the backfill is what is left.
      jobRow('d', 'done', { result: 'skipped: no_pages' }),
      jobRow('e', 'failed', { attempts: 5 }),
    ]
    const { supabase } = makeSupabase(['a', 'b', 'c', 'd', 'e', 'f'], [], [], jobs)
    expect((await classifyUnclassifiedDocuments(supabase, 'co-1', 10)).processed).toBe(3)
  })

  it('stops waiting for a queue that is not draining: a job due or locked more than an hour ago holds nothing', async () => {
    const jobs = [
      jobRow('a', 'queued', { run_after: minutesAgo(61) }),
      jobRow('b', 'running', { locked_at: minutesAgo(61) }),
      jobRow('c', 'failed', { attempts: 1, run_after: minutesAgo(61) }),
      // Still inside the hour: held.
      jobRow('d', 'queued', { run_after: minutesAgo(59) }),
    ]
    const { supabase } = makeSupabase(['a', 'b', 'c', 'd'], [], [], jobs)
    expect((await classifyUnclassifiedDocuments(supabase, 'co-1', 10)).processed).toBe(3)
  })

  it('starts no document at or after the deadline and counts the ones it left for the next run', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    // Every document takes 40 s (classifyDocument's first read is where the time passes here).
    const { supabase } = makeSupabase(['a', 'b', 'c', 'd'], [])
    const slow = supabase as unknown as { from: (table: string) => Record<string, unknown> }
    const from = slow.from
    slow.from = (table: string) => {
      const api = from(table)
      if (table === 'document_attachments') {
        const maybeSingle = api.maybeSingle as () => Promise<unknown>
        api.maybeSingle = () => { now += 40_000; return maybeSingle() }
      }
      return api
    }
    try {
      // Deadline at 100 s: documents start at 0, 40 and 80 s; the fourth would start at 120 s.
      expect(await classifyUnclassifiedDocuments(supabase, 'co-1', 10, { deadlineAt: 101_000 })).toEqual({ processed: 3, classified: 0, held: 0, skipped: 3, errors: 0, deferred: 1 })
      now = 1_000
      // Without a deadline every document is taken, as before.
      expect((await classifyUnclassifiedDocuments(supabase, 'co-1', 10)).processed).toBe(4)
    } finally {
      clock.mockRestore()
    }
  })

  it('never types a booked document in the background: it is typed when someone opens it', async () => {
    const { supabase, nulls } = makeSupabase(['a'], [])
    await classifyUnclassifiedDocuments(supabase, 'co-1', 10)
    expect(nulls).toEqual(expect.arrayContaining(['journal_entry_id', 'journal_entry_line_id']))
  })
})
