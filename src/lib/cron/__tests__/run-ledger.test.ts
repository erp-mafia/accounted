import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { finishCronRun, LEDGER_START_WAIT_MS, MAX_SUMMARY_BYTES, startCronRun, storableError, storableSummary } from '../run-ledger'

let db: ReturnType<typeof createTableMockSupabase>
const client = () => db.supabase as unknown as SupabaseClient
const START = { path: '/api/payments/orders/status/cron', operation: 'cron.payment_order_status', limitMs: 300_000, requestId: 'cron_1' }

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  vi.useRealTimers()
  db = createTableMockSupabase({ cron_runs: { data: null } })
})

describe('startCronRun', () => {
  it('opens a row under an id made here, with the path, operation, limit and request id, and returns the run', async () => {
    const run = await startCronRun(START, client())

    expect(run?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(run?.start).toEqual(START)
    expect(db.payloads('cron_runs', 'insert')).toEqual([
      { id: run!.id, path: '/api/payments/orders/status/cron', operation: 'cron.payment_order_status', limit_ms: 300_000, request_id: 'cron_1' },
    ])
  })

  it('never fails the job: no client, a refused write and a throwing client all answer null', async () => {
    expect(await startCronRun(START, null)).toBeNull()
    db.setTable('cron_runs', { data: null, error: { message: 'permission denied for table cron_runs' } })
    expect(await startCronRun(START, client())).toBeNull()
    const broken = { from: () => { throw new Error('socket hang up') } } as unknown as SupabaseClient
    expect(await startCronRun(START, broken)).toBeNull()
  })

  it('waits two seconds at most, and keeps the run when the write has not answered: the row may still land', async () => {
    vi.useFakeTimers()
    const hanging = { from: () => ({ insert: () => new Promise(() => {}) }) } as unknown as SupabaseClient
    const started = startCronRun(START, hanging)
    await vi.advanceTimersByTimeAsync(LEDGER_START_WAIT_MS)
    expect((await started)?.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('is off in unit tests unless a client is passed in', async () => {
    expect(await startCronRun(START)).toBeNull()
  })
})

describe('finishCronRun', () => {
  const RUN = { id: 'run-1', start: START }
  const OK = { status: 'ok' as const, httpStatus: 200, durationMs: 61_234.6, summary: { checked: 23, deferred: 0 } }

  it('closes the row with what the run answered, while it is open or was called timed out: a run that answers was not killed', async () => {
    db.setTable('cron_runs', { data: [{ id: 'run-1' }] })

    await finishCronRun(RUN, OK, client())

    const [patch] = db.payloads('cron_runs', 'update') as Array<Record<string, unknown>>
    expect(patch).toMatchObject({ status: 'ok', http_status: 200, duration_ms: 61_235, summary: { checked: 23, deferred: 0 }, error: null })
    expect(patch.finished_at).toEqual(expect.any(String))
    expect(db.findCalls('cron_runs', 'eq')).toEqual([['id', 'run-1']])
    expect(db.findCalls('cron_runs', 'in')).toEqual([['status', ['running', 'timed_out']]])
    expect(db.findCalls('cron_runs', 'update')).toHaveLength(1)
    expect(db.findCalls('cron_runs', 'insert')).toHaveLength(0)
  })

  it('writes the finished run itself when its start has not landed, so a start that lands late cannot leave an open row read as a killed run', async () => {
    db.setTable('cron_runs', [{ data: [] }, { data: null }])

    await finishCronRun(RUN, OK, client())

    const [row] = db.payloads('cron_runs', 'insert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({ id: 'run-1', path: START.path, operation: START.operation, limit_ms: 300_000, request_id: 'cron_1', status: 'ok', http_status: 200, duration_ms: 61_235 })
    // Started when the run started, not when it ended.
    expect(Date.parse(String(row.finished_at)) - Date.parse(String(row.started_at))).toBe(61_235)
  })

  it('closes the open row after all when the start landed between the close and the insert', async () => {
    db.setTable('cron_runs', [{ data: [] }, { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "cron_runs_pkey"' } }, { data: [{ id: 'run-1' }] }])

    await finishCronRun(RUN, OK, client())

    expect(db.findCalls('cron_runs', 'update')).toHaveLength(2)
    expect(db.findCalls('cron_runs', 'insert')).toHaveLength(1)
  })

  it('tries a refused close once more, and does not repeat one that has not answered: it is in flight and usually lands', async () => {
    db.setTable('cron_runs', [{ data: null, error: { message: 'connection reset' } }, { data: [{ id: 'run-1' }] }])
    await finishCronRun(RUN, OK, client())
    expect(db.findCalls('cron_runs', 'update')).toHaveLength(2)

    vi.useFakeTimers()
    let updates = 0
    const hanging = { from: () => ({ update: () => { updates += 1; return { eq: () => ({ in: () => ({ select: () => new Promise(() => {}) }) }) } } }) } as unknown as SupabaseClient
    const finished = finishCronRun(RUN, OK, hanging, 4_000)
    await vi.advanceTimersByTimeAsync(4_000)
    await finished
    expect(updates).toBe(1)
  })

  it('waits no longer than it is given: the time the route has left is the caller\'s to say', async () => {
    vi.useFakeTimers()
    const hanging = { from: () => ({ update: () => ({ eq: () => ({ in: () => ({ select: () => new Promise(() => {}) }) }) }) }) } as unknown as SupabaseClient
    let done = false
    const finished = finishCronRun(RUN, OK, hanging, 1_000).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await finished
    expect(done).toBe(true)
  })

  it('writes nothing for a run that has no row', async () => {
    await finishCronRun(null, { status: 'failed', httpStatus: 500, durationMs: 10 }, client())
    expect(db.tables()).toEqual([])
  })

  it('never throws', async () => {
    const broken = { from: () => { throw new Error('socket hang up') } } as unknown as SupabaseClient
    await expect(finishCronRun(RUN, { status: 'failed', httpStatus: 500, durationMs: 10 }, broken)).resolves.toBeUndefined()
  })
})

describe('what the ledger keeps', () => {
  it('keeps a small JSON summary and drops one that is too large or not JSON', () => {
    expect(storableSummary({ checked: 3 })).toEqual({ checked: 3 })
    expect(storableSummary(undefined)).toBeNull()
    expect(storableSummary({ rows: 'x'.repeat(MAX_SUMMARY_BYTES) })).toBeNull()
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(storableSummary(loop)).toBeNull()
  })

  it('redacts a personnummer in the summary and in the error text, like every log line', () => {
    expect(JSON.stringify(storableSummary({ failures: [{ error: 'customer 19800101-9879 not found' }] }))).not.toContain('9879')
    expect(storableError(new Error('customer 19800101-9879 not found'))).not.toContain('9879')
  })

  it('keeps an error short and names its type', () => {
    expect(storableError(new TypeError('x is not a function'))).toBe('TypeError: x is not a function')
    expect(storableError('y'.repeat(2_000))).toHaveLength(500)
    expect(storableError(null)).toBeNull()
  })
})
