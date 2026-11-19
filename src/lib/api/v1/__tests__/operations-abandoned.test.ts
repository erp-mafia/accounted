/**
 * failAbandonedOperation: a v1 operation whose request the platform killed
 * never reaches completeOperation or failOperation. On the poll, a row still
 * running after the longest a route may run is failed with
 * OPERATION_ABANDONED, and the error is logged by the one poll that moved it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import { failAbandonedOperation, OPERATION_ABANDONED_AFTER_MS, type OperationRow } from '../operations'

const NOW = Date.parse('2026-11-12T12:00:00Z')

function row(overrides: Partial<OperationRow> = {}): OperationRow {
  return {
    id: 'op-1',
    company_id: 'company-1',
    user_id: 'user-1',
    operation_type: 'imports.bank',
    status: 'running',
    started_at: new Date(NOW - OPERATION_ABANDONED_AFTER_MS - 1000).toISOString(),
    completed_at: null,
    params: {},
    progress: {},
    result: null,
    error: null,
    created_at: '2026-11-12T11:00:00Z',
    updated_at: '2026-11-12T11:00:00Z',
    ...overrides,
  }
}

function setup(update: TableMockResult, stored: OperationRow | null = null) {
  const mock = createTableMockSupabase({
    operations: (chain) => (chain.some((c) => c.method === 'update') ? update : { data: stored }),
  })
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  return { ...mock, log, run: (r: OperationRow) => failAbandonedOperation(mock.supabase as unknown as SupabaseClient, r, log as unknown as Logger, NOW) }
}

describe('failAbandonedOperation', () => {
  it('fails a row still running past the limit and logs it as an error', async () => {
    const { run, log, payloads, findCalls } = setup({ data: [{ id: 'op-1' }] })

    const out = await run(row())

    expect(out).toMatchObject({
      status: 'failed',
      completed_at: new Date(NOW).toISOString(),
      error: { code: 'OPERATION_ABANDONED' },
    })
    expect(payloads('operations', 'update')).toEqual([
      { status: 'failed', completed_at: new Date(NOW).toISOString(), error: expect.objectContaining({ code: 'OPERATION_ABANDONED' }) },
    ])
    expect(findCalls('operations', 'eq')).toEqual([['id', 'op-1'], ['status', 'running']])
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(
      'operation abandoned: still running after the route time limit, reported as failed',
      expect.objectContaining({ operationId: 'op-1', companyId: 'company-1', operationType: 'imports.bank' }),
    )
  })

  it('logs nothing when another poll moved the row first, and answers the row as stored', async () => {
    const stored = row({ status: 'failed', error: { code: 'OPERATION_ABANDONED' } })
    const { run, log } = setup({ data: [] }, stored)

    expect(await run(row())).toEqual(stored)
    expect(log.error).not.toHaveBeenCalled()
  })

  it.each([
    ['a row inside the limit', row({ started_at: new Date(NOW - OPERATION_ABANDONED_AFTER_MS + 1000).toISOString() })],
    ['a queued row', row({ status: 'queued', started_at: null })],
    ['a terminal row', row({ status: 'succeeded' })],
  ])('leaves %s untouched', async (_label, input) => {
    const { run, tables } = setup({ data: [] })
    expect(await run(input)).toBe(input)
    expect(tables()).toEqual([])
  })

  it('answers the row as stored and logs when the database refuses the write', async () => {
    const { run, log } = setup({ error: { code: '57014', message: 'statement timeout' } })
    const input = row()
    expect(await run(input)).toBe(input)
    expect(log.error).toHaveBeenCalledWith('abandoned operation not marked failed', { operationId: 'op-1', errorCode: '57014' })
  })
})
