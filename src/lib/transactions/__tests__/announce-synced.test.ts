import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: (...a: unknown[]) => mocks.emit(...a) } }))

import { createTableMockSupabase } from '@/tests/helpers'
import { announceSyncedTransactions, SYNCED_ROWS_READ_CHUNK } from '../announce-synced'

/** The stored rows a read asks for by id, as PostgREST answers an .in() filter. */
function storedRows(rows: { id: string }[]) {
  return (chainCalls: { method: string; args: unknown[] }[]) => {
    const ids = chainCalls.find((c) => c.method === 'in')?.args[1] as string[] | undefined
    return { data: rows.filter((row) => ids?.includes(row.id)) }
  }
}

const log = { error: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.emit.mockResolvedValue(undefined)
})

describe('announceSyncedTransactions', () => {
  it('reads a first import of thousands of rows in chunks and announces it once', async () => {
    const many = Array.from({ length: 3450 }, (_, i) => ({ id: `tx-${i}` }))
    const { supabase, findCalls } = createTableMockSupabase({ transactions: storedRows(many) })

    const announced = await announceSyncedTransactions(supabase as never, {
      companyId: 'co-1', userId: 'user-1', transactionIds: many.map((row) => row.id), log,
    })

    expect(SYNCED_ROWS_READ_CHUNK).toBe(200)
    const reads = findCalls('transactions', 'in').map((args) => (args[1] as string[]).length)
    expect(reads.every((size) => size <= SYNCED_ROWS_READ_CHUNK)).toBe(true)
    expect(reads.reduce((sum, size) => sum + size, 0)).toBe(3450)
    expect(findCalls('transactions', 'eq')).toContainEqual(['company_id', 'co-1'])
    expect(announced).toBe(3450)
    expect(mocks.emit).toHaveBeenCalledTimes(1)
    expect(mocks.emit).toHaveBeenCalledWith({ type: 'transaction.synced', payload: { transactions: many, userId: 'user-1', companyId: 'co-1' } })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('announces a small sync with one read', async () => {
    const rows = [{ id: 'tx-1' }, { id: 'tx-2' }]
    const { supabase, findCalls } = createTableMockSupabase({ transactions: storedRows(rows) })

    expect(await announceSyncedTransactions(supabase as never, { companyId: 'co-1', userId: 'user-1', transactionIds: ['tx-1', 'tx-2'], log })).toBe(2)
    expect(findCalls('transactions', 'in')).toEqual([['id', ['tx-1', 'tx-2']]])
    expect(mocks.emit).toHaveBeenCalledTimes(1)
  })

  it('logs a failed read as an error with its context, announces nothing and does not throw', async () => {
    const { supabase } = createTableMockSupabase({ transactions: { data: null, error: { message: 'URI too long' } } })

    const announced = await announceSyncedTransactions(supabase as never, {
      companyId: 'co-1', userId: 'user-1', transactionIds: ['tx-1'], log, context: { connectionId: 'conn-1' },
    })

    expect(announced).toBe(0)
    expect(mocks.emit).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('not announced'),
      expect.objectContaining({ connectionId: 'conn-1', companyId: 'co-1', rows: 1, message: 'URI too long' }),
    )
  })

  it('reads nothing and announces nothing for no ids, or when no row comes back', async () => {
    const empty = createTableMockSupabase({ transactions: { data: [] } })
    expect(await announceSyncedTransactions(empty.supabase as never, { companyId: 'co-1', userId: 'user-1', transactionIds: [], log })).toBe(0)
    expect(empty.findCalls('transactions', 'in')).toEqual([])
    expect(await announceSyncedTransactions(empty.supabase as never, { companyId: 'co-1', userId: 'user-1', transactionIds: ['tx-1'], log })).toBe(0)
    expect(mocks.emit).not.toHaveBeenCalled()
  })
})
