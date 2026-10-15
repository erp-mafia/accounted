import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeTransaction, makeInvoice, makeCustomer, makeFiscalPeriod } from '@/tests/helpers'

// Mock the service client
const mockInsert = vi.fn().mockResolvedValue({ error: null })
const mockUpsert = vi.fn().mockResolvedValue({ error: null })
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({
    from: () => ({
      insert: mockInsert,
      upsert: mockUpsert,
    }),
  }),
}))

/** Every row written to event_log, by insert or by idempotent upsert. */
function writtenRows(): Array<Record<string, unknown>> {
  return [...mockInsert.mock.calls, ...mockUpsert.mock.calls].flatMap(([rows]) =>
    Array.isArray(rows) ? rows : [rows],
  )
}

// Mock the logger so warn-vs-error level can be asserted (the real logger
// suppresses warn in the test environment). Hoisted: bus.ts calls
// createLogger at import time, before top-level consts initialize.
const { logWarn, logError } = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: logWarn,
    error: logError,
    child: vi.fn(),
  }),
}))

// Import after mocks
import { PERSISTED_EVENT_TYPES, registerEventLogHandler } from '../event-log-handler'
import { PUBLIC_WEBHOOK_EVENTS } from '@/lib/webhooks/public-events'
import { makeJournalEntry } from '@/tests/helpers'

describe('event-log-handler', () => {
  let unsubscribers: (() => void)[]

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mockInsert.mockResolvedValue({ error: null })
    mockUpsert.mockResolvedValue({ error: null })
    unsubscribers = registerEventLogHandler()
  })

  afterEach(() => {
    unsubscribers.forEach(unsub => unsub())
  })

  it('persists invoice.created event with correct entity_id', async () => {
    const invoice = makeInvoice({ id: 'inv-123' })

    await eventBus.emit({
      type: 'invoice.created',
      payload: { invoice, userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        company_id: 'company-1',
        event_type: 'invoice.created',
        entity_id: 'inv-123',
      })
    )

    // Data should NOT contain userId (it's in its own column)
    const insertedData = mockInsert.mock.calls[0][0].data
    expect(insertedData).not.toHaveProperty('userId')
    expect(insertedData).toHaveProperty('invoice')
  })

  it('persists customer.created event', async () => {
    const customer = makeCustomer({ id: 'cust-456' })

    await eventBus.emit({
      type: 'customer.created',
      payload: { customer, userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        company_id: 'company-1',
        event_type: 'customer.created',
        entity_id: 'cust-456',
      })
    )
  })

  it('batch-inserts transaction.synced as individual rows', async () => {
    const tx1 = makeTransaction({ id: 'tx-1' })
    const tx2 = makeTransaction({ id: 'tx-2' })
    const tx3 = makeTransaction({ id: 'tx-3' })

    await eventBus.emit({
      type: 'transaction.synced',
      payload: { transactions: [tx1, tx2, tx3], userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).toHaveBeenCalledTimes(1)
    const rows = mockInsert.mock.calls[0][0]
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ event_type: 'transaction.synced', entity_id: 'tx-1', company_id: 'company-1' })
    expect(rows[1]).toMatchObject({ event_type: 'transaction.synced', entity_id: 'tx-2', company_id: 'company-1' })
    expect(rows[2]).toMatchObject({ event_type: 'transaction.synced', entity_id: 'tx-3', company_id: 'company-1' })
  })

  it('does NOT persist journal_entry.drafted (excluded noise event)', async () => {
    await eventBus.emit({
      type: 'journal_entry.drafted',
      payload: { entry: {} as never, userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('does not throw when persistence fails', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'DB down' } })

    // Should not throw
    await eventBus.emit({
      type: 'customer.created',
      payload: { customer: makeCustomer(), userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).toHaveBeenCalledTimes(1)
  })

  it('retries once when the insert fails with a network-class "fetch failed" error, then succeeds', async () => {
    vi.useFakeTimers()
    try {
      mockInsert
        .mockResolvedValueOnce({ error: { message: 'TypeError: fetch failed' } })
        .mockResolvedValueOnce({ error: null })

      const emitPromise = eventBus.emit({
        type: 'customer.created',
        payload: { customer: makeCustomer({ id: 'cust-retry' }), userId: 'user-1', companyId: 'company-1' },
      })
      await vi.advanceTimersByTimeAsync(250)
      await emitPromise

      expect(mockInsert).toHaveBeenCalledTimes(2)
      expect(mockInsert.mock.calls[1][0]).toMatchObject({
        event_type: 'customer.created',
        entity_id: 'cust-retry',
      })
      expect(logWarn).not.toHaveBeenCalled()
      expect(logError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry non-network insert errors', async () => {
    mockInsert.mockResolvedValue({
      error: { message: 'duplicate key value violates unique constraint "event_log_pkey"' },
    })

    await eventBus.emit({
      type: 'customer.created',
      payload: { customer: makeCustomer(), userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledTimes(1)
  })

  it('logs telemetry (mcp.*) persistence failure at warn level after the retry also fails', async () => {
    vi.useFakeTimers()
    try {
      mockInsert.mockResolvedValue({ error: { message: 'TypeError: fetch failed' } })

      const emitPromise = eventBus.emit({
        type: 'mcp.tool_called',
        payload: { tool: 'gnubok_list_accounts', userId: 'user-1', companyId: 'company-1' } as never,
      })
      await vi.advanceTimersByTimeAsync(250)
      await emitPromise

      expect(mockInsert).toHaveBeenCalledTimes(2)
      expect(logWarn).toHaveBeenCalledTimes(1)
      expect(logError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps business event persistence failure at error level after the retry also fails', async () => {
    vi.useFakeTimers()
    try {
      mockInsert.mockResolvedValue({ error: { message: 'TypeError: fetch failed' } })

      const emitPromise = eventBus.emit({
        type: 'invoice.created',
        payload: { invoice: makeInvoice({ id: 'inv-err' }), userId: 'user-1', companyId: 'company-1' },
      })
      await vi.advanceTimersByTimeAsync(250)
      await emitPromise

      expect(mockInsert).toHaveBeenCalledTimes(2)
      expect(logError).toHaveBeenCalledTimes(1)
      expect(logWarn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists period.locked with period entity_id', async () => {
    const period = makeFiscalPeriod({ id: 'period-1' })

    await eventBus.emit({
      type: 'period.locked',
      payload: { period, userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'period.locked',
        entity_id: 'period-1',
        company_id: 'company-1',
      })
    )
  })

  it('skips insert when companyId is missing from payload', async () => {
    await eventBus.emit({
      type: 'customer.created',
      // deliberate bypass of TS types to simulate a future caller forgetting companyId
      payload: { customer: makeCustomer(), userId: 'user-1' } as never,
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('records a payroll event under its salary run id', async () => {
    const salaryRunId = '4b8f1f9e-2c3d-4e5f-8a9b-0c1d2e3f4a5b'

    await eventBus.emit({
      type: 'salary_run.created',
      payload: { salaryRunId, periodYear: 2026, periodMonth: 10, userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'salary_run.created', entity_id: salaryRunId }),
    )
  })

  it('persists an event whose flat id is not a uuid, with a null entity_id', async () => {
    // entity_id is a uuid column: a non-uuid id would fail the whole insert.
    await eventBus.emit({
      type: 'reconciliation.matched',
      payload: {
        accountKey: 'bank:1930',
        externalId: 'skv-row-17',
        journalEntryId: 'je-1',
        method: 'manual',
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'reconciliation.matched', entity_id: null }),
    )
  })

  it('writes journal_entry.committed idempotently on its natural key', async () => {
    // commit_journal_entry already wrote this row in the posting transaction
    // (migration 20261016001100); the bus write must be a no-op then, and
    // still land for an entry posted another way (storno).
    const entry = makeJournalEntry({ id: 'je-42' })

    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry, userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockUpsert).toHaveBeenCalledTimes(1)
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'journal_entry.committed',
        entity_id: 'je-42',
        dedupe_key: 'journal_entry.committed:je-42',
      }),
      { onConflict: 'dedupe_key', ignoreDuplicates: true },
    )
  })

  it('retries the idempotent write once on a network-class failure', async () => {
    vi.useFakeTimers()
    try {
      mockUpsert
        .mockResolvedValueOnce({ error: { message: 'TypeError: fetch failed' } })
        .mockResolvedValueOnce({ error: null })

      const emitPromise = eventBus.emit({
        type: 'journal_entry.committed',
        payload: { entry: makeJournalEntry({ id: 'je-43' }), userId: 'user-1', companyId: 'company-1' },
      })
      await vi.advanceTimersByTimeAsync(250)
      await emitPromise

      expect(mockUpsert).toHaveBeenCalledTimes(2)
      expect(logError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes other journal events with a plain insert and no dedupe_key', async () => {
    await eventBus.emit({
      type: 'journal_entry.reversed',
      payload: {
        originalEntry: makeJournalEntry({ id: 'je-1' }),
        reversalEntry: makeJournalEntry({ id: 'je-2' }),
        userId: 'user-1',
        companyId: 'company-1',
      },
    })

    expect(mockUpsert).not.toHaveBeenCalled()
    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(mockInsert.mock.calls[0][0]).not.toHaveProperty('dedupe_key')
  })

  it('skips batch insert when companyId is missing from payload', async () => {
    await eventBus.emit({
      type: 'transaction.synced',
      payload: { transactions: [makeTransaction({ id: 'tx-1' })], userId: 'user-1' } as never,
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })
})

/**
 * GET /api/events is how a receiver that missed a webhook catches up, so every
 * event the public catalogue can push must also be pollable. Derived from the
 * catalogue: adding a public event without persisting it fails here.
 */
describe('event-log-handler: public catalogue coverage', () => {
  let unsubscribers: (() => void)[]

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mockInsert.mockResolvedValue({ error: null })
    mockUpsert.mockResolvedValue({ error: null })
    unsubscribers = registerEventLogHandler()
  })

  afterEach(() => {
    unsubscribers.forEach(unsub => unsub())
  })

  it('lists every public webhook event as persisted', () => {
    const missing = PUBLIC_WEBHOOK_EVENTS.filter((type) => !PERSISTED_EVENT_TYPES.includes(type))
    expect(missing).toEqual([])
  })

  it.each([...PUBLIC_WEBHOOK_EVENTS])('writes %s to event_log when it is emitted', async (eventType) => {
    // The minimal payload every variant shares; entity extraction tolerates
    // the missing entity object (entity_id is then null).
    await eventBus.emit({
      type: eventType,
      payload: { userId: 'user-1', companyId: 'company-1' },
    } as never)

    expect(writtenRows()).toContainEqual(
      expect.objectContaining({ event_type: eventType, company_id: 'company-1', user_id: 'user-1' }),
    )
  })
})
