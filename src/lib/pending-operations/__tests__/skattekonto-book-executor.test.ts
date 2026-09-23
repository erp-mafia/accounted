/**
 * Unit tests for commitBookSkattekontoRows (op types book_skattekonto_row /
 * book_skattekonto_rows), driven through the public commitPendingOperation
 * dispatcher.
 *
 * The MCP staging tools never book; the approved op's executor resolves the
 * skatteverket extension's commitBookSkattekontoRows service via the registry
 * (core cannot import @/extensions) and translates its result into the op
 * lifecycle:
 *   - ok with >= 1 booked row  → committed (per-row results in result_data)
 *   - ok with 0 booked rows    → rejected (409, reasons in result_data)
 *   - recoverable failure      → released back to 'pending'
 *   - non-recoverable failure  → rejected
 *
 * A FAKE extension is registered so no real booking code runs: this isolates
 * the core wiring (registry resolution + lifecycle), same pattern as
 * skatteverket-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { extensionRegistry } from '@/lib/extensions/registry'
import type { Extension } from '@/lib/extensions/types'
import type { SkattekontoBookCommitResult } from '@/lib/pending-operations/skatteverket-commit'
import type { PendingOperation } from '@/types'
import { commitPendingOperation } from '../commit'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'book_skattekonto_rows',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-08-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

function registerFakeSkatteverket(
  services: Record<string, (...a: unknown[]) => Promise<SkattekontoBookCommitResult>>,
): void {
  extensionRegistry.register({
    id: 'skatteverket',
    name: 'fake-skatteverket',
    version: '0.0.0',
    services,
  } as unknown as Extension)
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})
afterEach(() => {
  extensionRegistry.clear()
})

describe('commitPendingOperation: book_skattekonto_row(s)', () => {
  it('happy batch path: committed with per-row results, actor userId passed through', async () => {
    const book = vi.fn().mockResolvedValue({
      ok: true,
      results: [
        { id: 'skv-1', ok: true, journal_entry_id: 'je-1', voucher_number: 41, voucher_series: 'A' },
        { id: 'skv-2', ok: true, journal_entry_id: 'je-2', voucher_number: 42, voucher_series: 'A' },
      ],
      summary: { total: 2, succeeded: 2, failed: 0 },
    })
    registerFakeSkatteverket({ commitBookSkattekontoRows: book })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // dispatcher commit update

    const op = makePendingOp({ params: { ids: ['skv-1', 'skv-2'] } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ summary: { total: 2, succeeded: 2, failed: 0 } })
    // The approving human is the actor: userId is threaded explicitly because
    // the service-role client nulls auth.uid().
    expect(book).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1', {
      ids: ['skv-1', 'skv-2'],
    })
  })

  it('single-row op shape { transaction_id } is normalised to an id list', async () => {
    const book = vi.fn().mockResolvedValue({
      ok: true,
      results: [{ id: 'skv-1', ok: true, journal_entry_id: 'je-1', voucher_number: 7, voucher_series: 'A' }],
      summary: { total: 1, succeeded: 1, failed: 0 },
    })
    registerFakeSkatteverket({ commitBookSkattekontoRows: book })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'book_skattekonto_row',
      params: { transaction_id: 'skv-1' },
    })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(book).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1', { ids: ['skv-1'] })
  })

  it('partial batch still commits, with the failed rows in result_data', async () => {
    const book = vi.fn().mockResolvedValue({
      ok: true,
      results: [
        { id: 'skv-1', ok: true, journal_entry_id: 'je-1', voucher_number: 41, voucher_series: 'A' },
        { id: 'skv-2', ok: false, error_code: 'PERIOD_LOCKED', error_message: 'låst period' },
      ],
      summary: { total: 2, succeeded: 1, failed: 1 },
    })
    registerFakeSkatteverket({ commitBookSkattekontoRows: book })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({ params: { ids: ['skv-1', 'skv-2'] } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ summary: { total: 2, succeeded: 1, failed: 1 } })
  })

  it('zero booked rows → rejected 409 with per-row reasons, never silently committed', async () => {
    const book = vi.fn().mockResolvedValue({
      ok: true,
      results: [
        { id: 'skv-1', ok: false, error_code: 'ALREADY_BOOKED', error_message: 'Transaktionen är redan bokförd.' },
      ],
      summary: { total: 1, succeeded: 0, failed: 1 },
    })
    registerFakeSkatteverket({ commitBookSkattekontoRows: book })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // reject update

    const op = makePendingOp({ params: { ids: ['skv-1'] } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/redan bokförd/)
  })

  it('no service registered → failed EXTENSION_DISABLED, op released to pending', async () => {
    // registry is empty (afterEach cleared it; nothing registered here)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })           // release-to-pending update

    const op = makePendingOp({ params: { ids: ['skv-1'] } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('EXTENSION_DISABLED')
    expect(result.http_status).toBe(503)
  })

  it('recoverable service result → released to pending with the structured code', async () => {
    const book = vi.fn().mockResolvedValue({
      ok: false, code: 'EXTENSION_DISABLED', http_status: 503, recoverable: true,
      error: 'Skatteverket-integrationen är inte aktiverad i denna miljö.',
    })
    registerFakeSkatteverket({ commitBookSkattekontoRows: book })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null })

    const op = makePendingOp({ params: { ids: ['skv-1'] } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.code).toBe('EXTENSION_DISABLED')
    expect(result.http_status).toBe(503)
  })

  it('non-recoverable service result → op rejected (consumed)', async () => {
    const book = vi.fn().mockResolvedValue({
      ok: false, code: 'SKATTEKONTO_BOOKING_FAILED', http_status: 500, recoverable: false,
      error: 'rule context load failed',
    })
    registerFakeSkatteverket({ commitBookSkattekontoRows: book })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // reject update

    const op = makePendingOp({ params: { ids: ['skv-1'] } })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    expect(result.error).toMatch(/rule context/)
  })

  it('missing ids → 400 without resolving the extension service', async () => {
    const book = vi.fn()
    registerFakeSkatteverket({ commitBookSkattekontoRows: book })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })
    enqueue({ data: null, error: null }) // reject update

    const op = makePendingOp({ params: {} })
    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(book).not.toHaveBeenCalled()
  })
})
