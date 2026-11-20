/**
 * commitRetagLineDimensions: executor tests (dimensions PR6).
 *
 * The executor is private to lib/pending-operations/commit.ts and reached
 * through commitPendingOperation, same pattern as
 * dimension-value-executor.test.ts. Staging-side coverage (the MCP tool's
 * filter matching + cap gates) lives in
 * extensions/general/mcp-server/__tests__/tag-journal-lines.test.ts. The RPC
 * itself (period/lock/registry/role enforcement) is covered by
 * tests/pg/dimension-retag.pg.test.ts; the lock check the executor asks
 * before the RPC by lib/dimensions/__tests__/retag-lock.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { commitPendingOperation } from '../commit'

const uuidAt = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'retag_line_dimensions',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-07-02T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-02T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

type Enqueue = ReturnType<typeof createQueuedMockSupabase>['enqueue']
type LineFixture = { id: string; entry?: string; account_number?: string; dimensions?: Record<string, string> }
type EntryFixture = { id: string; entry_date: string; fiscal_period_id: string }

const OPEN_ENTRY: EntryFixture = { id: 'entry-1', entry_date: '2024-03-01', fiscal_period_id: 'period-open' }
const OPEN_PERIOD = { id: 'period-open', is_closed: false, locked_at: null }

/**
 * The reads retagLines makes before its RPC loop, in order: the lines by id,
 * their verifikat among the company's, the company lock date and the lock
 * state of the verifikat's periods. Every line sits on OPEN_ENTRY unless it
 * names another entry.
 */
function enqueueLineReads(
  enqueue: Enqueue,
  lines: LineFixture[],
  state: { entries?: EntryFixture[]; lockThrough?: string | null; periods?: unknown[] } = {},
) {
  enqueue({
    data: lines.map((line) => ({
      id: line.id,
      journal_entry_id: line.entry ?? OPEN_ENTRY.id,
      account_number: line.account_number ?? '4010',
      dimensions: line.dimensions ?? {},
    })),
    error: null,
  }) // journal_entry_lines by id
  enqueue({ data: state.entries ?? [OPEN_ENTRY], error: null }) // the company's entries among them
  enqueue({ data: { bookkeeping_locked_through: state.lockThrough ?? null }, error: null }) // company_settings
  enqueue({ data: state.periods ?? [OPEN_PERIOD], error: null }) // fiscal_periods
}

describe('commitPendingOperation: retag_line_dimensions, schema validation', () => {
  it('rejects a non-UUID line id at the commit boundary (tampered params)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const op = makePendingOp({
      params: { line_ids: ['not-a-uuid'], dimensions: { '6': 'P01' }, reason: 'Rätt projekt' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid line_ids/)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects more than 500 line_ids', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const op = makePendingOp({
      params: {
        line_ids: Array.from({ length: 501 }, (_, i) => uuidAt(i)),
        dimensions: { '6': 'P01' },
        reason: 'Rätt projekt',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid line_ids.*capped at 500/)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects a missing reason', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const op = makePendingOp({
      params: { line_ids: [uuidAt(1)], dimensions: { '6': 'P01' } },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid reason/)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('rejects an empty dimensions bag (retag never bulk-clears)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const op = makePendingOp({
      params: { line_ids: [uuidAt(1)], dimensions: {}, reason: 'Rensa allt' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/Invalid dimensions/)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('commitPendingOperation: retag_line_dimensions, execution', () => {
  it('happy path: one RPC call per line, aggregates changed/unchanged', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [], error: null }) // account_dimension_rules: a replace may remove a dimension, none is required
    enqueueLineReads(enqueue, [{ id: uuidAt(1) }, { id: uuidAt(2) }])
    enqueue({ data: { changed: true, log_id: 'log-1' }, error: null }) // line 1 rpc
    enqueue({ data: { changed: false, log_id: null }, error: null }) // line 2 rpc (already tagged)
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: {
        line_ids: [uuidAt(1), uuidAt(2)],
        dimensions: { '1': 'KS01', '6': 'P01' },
        reason: 'Retro-taggning av projektet',
        filter_summary: 'konto 4010, datum 2024-01-01 till 2024-12-31',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      outcome: 'complete',
      retagged: 1,
      unchanged: 1,
      failed_count: 0,
      failed_by_reason: [],
      failed: [],
      dimensions: { '1': 'KS01', '6': 'P01' },
      filter_summary: 'konto 4010, datum 2024-01-01 till 2024-12-31',
    })
    // Every line tagged: nothing to warn about.
    expect(result.data).not.toHaveProperty('warning')

    const rpc = supabase.rpc as ReturnType<typeof vi.fn>
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls[0][0]).toBe('retag_line_dimensions')
    expect(rpc.mock.calls[0][1]).toEqual({
      p_company_id: 'company-1',
      p_line_id: uuidAt(1),
      p_dimensions: { '1': 'KS01', '6': 'P01' },
      p_reason: 'Retro-taggning av projektet',
      p_user_id: 'user-1',
    })
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_line_id: uuidAt(2) })
  })

  it('a row staged before the mode existed commits as the replace its approver was shown', async () => {
    // The staged preview of such a row said "replace the dimensions bag on
    // every matched line": the executor must not start merging it.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [], error: null }) // account_dimension_rules: a replace may remove a dimension, none is required
    enqueueLineReads(enqueue, [{ id: uuidAt(1), dimensions: { '1': 'KS01' } }])
    enqueue({ data: { changed: true, log_id: 'log-1' }, error: null }) // line 1 rpc
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: { line_ids: [uuidAt(1)], dimensions: { '6': 'P01' }, reason: 'Retro-taggning' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ retagged: 1, mode: 'replace' })
    // A replace sends exactly the staged bag: the line's own kostnadsställe is not kept.
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
      p_company_id: 'company-1',
      p_line_id: uuidAt(1),
      p_dimensions: { '6': 'P01' },
      p_reason: 'Retro-taggning',
      p_user_id: 'user-1',
    })
  })

  it('merge reads the lines at approval, keeps their other dimensions and never replaces a line it cannot read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueueLineReads(enqueue, [
      { id: uuidAt(1), dimensions: { '1': 'KS01', '6': 'P00' } },
      { id: uuidAt(2) },
      // A line of another company: its entry is not among the company's.
      { id: uuidAt(3), entry: 'entry-foreign', dimensions: { '1': 'X' } },
    ])
    enqueue({ data: { changed: true, log_id: 'log-1' }, error: null }) // line 1 rpc
    enqueue({ data: { changed: true, log_id: 'log-2' }, error: null }) // line 2 rpc
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: {
        line_ids: [uuidAt(1), uuidAt(2), uuidAt(3)],
        dimensions: { '6': 'P01' },
        mode: 'merge',
        reason: 'Projektet rättas',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ outcome: 'partial', retagged: 2, unchanged: 0, failed_count: 1, mode: 'merge' })
    expect(result.data?.failed).toEqual([
      { line_id: uuidAt(3), error: 'Verifikationsraden hittades inte.', reason: 'line_not_found' },
    ])

    const rpc = supabase.rpc as ReturnType<typeof vi.fn>
    expect(rpc).toHaveBeenCalledTimes(2)
    // Line 1 keeps its kostnadsställe; only projekt changes.
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_line_id: uuidAt(1), p_dimensions: { '1': 'KS01', '6': 'P01' } })
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_line_id: uuidAt(2), p_dimensions: { '6': 'P01' } })
  })

  it('an empty code removes that dimension at approval and keeps the line\'s others (crm#1313)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [], error: null }) // account_dimension_rules: none required
    enqueueLineReads(enqueue, [{ id: uuidAt(1), account_number: '1930', dimensions: { '1': 'KS01', '6': 'P01' } }])
    enqueue({ data: { changed: true, log_id: 'log-1' }, error: null }) // line 1 rpc
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: { line_ids: [uuidAt(1)], dimensions: { '6': '' }, mode: 'merge', reason: 'Projekt hör inte till bankraden' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ retagged: 1, failed_count: 0, mode: 'merge' })
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      p_line_id: uuidAt(1),
      p_dimensions: { '1': 'KS01' },
    })
  })

  it('rejects a mode that is neither merge nor replace at the commit boundary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher reject update

    const op = makePendingOp({
      params: { line_ids: [uuidAt(1)], dimensions: { '6': 'P01' }, mode: 'append', reason: 'Retro-taggning' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/Invalid mode/)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('partial failure: continues past a failing line and reports it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [], error: null }) // account_dimension_rules: a replace may remove a dimension, none is required
    enqueueLineReads(enqueue, [{ id: uuidAt(1) }, { id: uuidAt(2) }, { id: uuidAt(3) }])
    enqueue({ data: { changed: true, log_id: 'log-1' }, error: null }) // line 1 ok
    // The period was locked after the lock check: the RPC is the gate.
    enqueue({ data: null, error: { message: 'Perioden är låst: använd rättelseverifikat (storno).' } }) // line 2 fails
    enqueue({ data: { changed: true, log_id: 'log-3' }, error: null }) // line 3 ok
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: {
        line_ids: [uuidAt(1), uuidAt(2), uuidAt(3)],
        dimensions: { '6': 'P01' },
        reason: 'Retro-taggning',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ outcome: 'partial', retagged: 2, unchanged: 0, failed_count: 1 })
    expect(result.data?.failed).toEqual([
      {
        line_id: uuidAt(2),
        error: 'Perioden är låst: använd rättelseverifikat (storno).',
        reason: 'refused',
        entry_date: '2024-03-01',
      },
    ])
    expect(supabase.rpc).toHaveBeenCalledTimes(3)
  })

  it('leaves the lines of a closed year untagged, tags the rest and says so (crm#1908)', async () => {
    // The report: a filter matched lines on both sides of a year end. The
    // approval tagged the open year and answered a plain 'committed'.
    const closed: EntryFixture = { id: 'entry-closed', entry_date: '2023-12-20', fiscal_period_id: 'period-closed' }
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueueLineReads(
      enqueue,
      [
        { id: uuidAt(1), entry: closed.id },
        { id: uuidAt(2), entry: closed.id },
        { id: uuidAt(3) },
      ],
      {
        entries: [closed, OPEN_ENTRY],
        periods: [{ id: 'period-closed', is_closed: true, locked_at: '2024-02-01T00:00:00Z' }, OPEN_PERIOD],
      },
    )
    enqueue({ data: { changed: true, log_id: 'log-3' }, error: null }) // line 3 rpc, the only one called
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: {
        line_ids: [uuidAt(1), uuidAt(2), uuidAt(3)],
        dimensions: { '6': 'P01' },
        mode: 'merge',
        reason: 'Projektet saknades',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // The operation is consumed and line 3 is tagged, so it is committed:
    // but never as a bare success.
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ outcome: 'partial', retagged: 1, unchanged: 0, failed_count: 2 })
    expect(result.data?.failed_by_reason).toEqual([
      {
        reason: 'period_closed',
        lines: 2,
        message: 'Perioden är stängd: använd rättelseverifikat (storno) för att ändra dimensioner.',
        date_from: '2023-12-20',
        date_to: '2023-12-20',
      },
    ])
    expect(result.data?.warning).toMatch(/^PARTIAL: 2 of 3 lines were NOT tagged \(2 period_closed, 2023-12-20\)/)
    // A line behind a lock never reaches the RPC.
    const rpc = supabase.rpc as ReturnType<typeof vi.fn>
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_line_id: uuidAt(3) })
  })

  it('refuses a line on or before the company lock date, with the date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueueLineReads(enqueue, [{ id: uuidAt(1) }, { id: uuidAt(2), entry: 'entry-late' }], {
      entries: [OPEN_ENTRY, { id: 'entry-late', entry_date: '2024-04-02', fiscal_period_id: 'period-open' }],
      lockThrough: '2024-03-31',
    })
    enqueue({ data: { changed: true, log_id: 'log-2' }, error: null }) // line 2 rpc
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: { line_ids: [uuidAt(1), uuidAt(2)], dimensions: { '6': 'P01' }, mode: 'merge', reason: 'Projektet saknades' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ outcome: 'partial', retagged: 1, failed_count: 1 })
    expect(result.data?.failed).toEqual([
      {
        line_id: uuidAt(1),
        error: 'Bokföringen är låst t.o.m. 2024-03-31: använd rättelseverifikat (storno).',
        reason: 'company_lock_date',
        entry_date: '2024-03-01',
      },
    ])
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the period locks cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [{ id: uuidAt(1), journal_entry_id: 'entry-1', account_number: '4010', dimensions: {} }], error: null })
    enqueue({ data: [OPEN_ENTRY], error: null })
    enqueue({ data: null, error: { message: 'connection reset', code: '08006' } }) // company_settings
    enqueue({ data: null, error: null }) // the claim is released

    const op = makePendingOp({
      params: { line_ids: [uuidAt(1)], dimensions: { '6': 'P01' }, mode: 'merge', reason: 'Projektet saknades' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // A lock state that could not be read is never taken for open, and a
    // failed read is not a verdict on the proposal: it waits for an approval
    // that can read.
    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(503)
    expect(result.operation_status).toBe('pending')
    expect(result.error).toMatch(/kunde inte läsas/)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('caps the echoed failures at 20 but counts them all', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [], error: null }) // account_dimension_rules: a replace may remove a dimension, none is required
    enqueueLineReads(enqueue, Array.from({ length: 23 }, (_, i) => ({ id: uuidAt(i) })))
    enqueue({ data: { changed: true, log_id: 'log-1' }, error: null }) // line 1 ok
    for (let i = 0; i < 22; i++) {
      enqueue({ data: null, error: { message: 'Värdet finns inte som aktivt värde.' } })
    }
    enqueue({ data: null, error: null }) // finalize update

    const op = makePendingOp({
      params: {
        line_ids: Array.from({ length: 23 }, (_, i) => uuidAt(i)),
        dimensions: { '6': 'P01' },
        reason: 'Retro-taggning',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ retagged: 1, failed_count: 22 })
    expect((result.data?.failed as unknown[]).length).toBe(20)
    // The count per reason covers every failed line, past the 20 echoed.
    expect(result.data?.failed_by_reason).toMatchObject([{ reason: 'refused', lines: 22 }])
  })

  it('fails the operation when EVERY line fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: [], error: null }) // account_dimension_rules: a replace may remove a dimension, none is required
    enqueue({ data: [], error: null }) // journal_entry_lines by id: none is the company's
    enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
    enqueue({ data: null, error: null }) // dispatcher reject update

    const op = makePendingOp({
      params: {
        line_ids: [uuidAt(1), uuidAt(2)],
        dimensions: { '6': 'P01' },
        reason: 'Retro-taggning',
      },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.code).toBe('DIMENSION_RETAG_FAILED')
    expect(result.error).toMatch(/Ingen rad kunde taggas om \(2 rader misslyckades\)/)
    expect(result.error).toMatch(/Verifikationsraden hittades inte/)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
