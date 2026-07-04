/**
 * commitRetagLineDimensions: executor tests (dimensions PR6).
 *
 * The executor is private to lib/pending-operations/commit.ts and reached
 * through commitPendingOperation, same pattern as
 * dimension-value-executor.test.ts. Staging-side coverage (the MCP tool's
 * filter matching + cap gates) lives in
 * extensions/general/mcp-server/__tests__/tag-journal-lines.test.ts. The RPC
 * itself (period/lock/registry/role enforcement) is covered by
 * tests/pg/dimension-retag.pg.test.ts.
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
      retagged: 1,
      unchanged: 1,
      failed_count: 0,
      failed: [],
      dimensions: { '1': 'KS01', '6': 'P01' },
      filter_summary: 'konto 4010, datum 2024-01-01 till 2024-12-31',
    })

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

  it('partial failure: continues past a failing line and reports it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { changed: true, log_id: 'log-1' }, error: null }) // line 1 ok
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
    expect(result.data).toMatchObject({ retagged: 2, unchanged: 0, failed_count: 1 })
    expect(result.data?.failed).toEqual([
      { line_id: uuidAt(2), error: 'Perioden är låst: använd rättelseverifikat (storno).' },
    ])
    expect(supabase.rpc).toHaveBeenCalledTimes(3)
  })

  it('caps the echoed failures at 20 but counts them all', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { changed: true, log_id: 'log-1' }, error: null }) // line 1 ok
    for (let i = 0; i < 22; i++) {
      enqueue({ data: null, error: { message: `fel ${i}` } })
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
  })

  it('fails the operation when EVERY line fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: { message: 'Verifikationsraden hittades inte.' } })
    enqueue({ data: null, error: { message: 'Verifikationsraden hittades inte.' } })
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
    expect(result.error).toMatch(/Ingen rad kunde taggas om \(2 rader misslyckades\)/)
    expect(result.error).toMatch(/Verifikationsraden hittades inte/)
  })
})
