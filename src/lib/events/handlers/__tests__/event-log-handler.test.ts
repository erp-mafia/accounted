import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeTransaction, makeInvoice, makeCustomer, makeFiscalPeriod } from '@/tests/helpers'

// Mock the service client
const mockInsert = vi.fn().mockResolvedValue({ error: null })
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({
    from: () => ({
      insert: mockInsert,
    }),
  }),
}))

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
import { registerEventLogHandler } from '../event-log-handler'

describe('event-log-handler', () => {
  let unsubscribers: (() => void)[]

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mockInsert.mockResolvedValue({ error: null })
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

  it('does NOT persist receipt.extracted (excluded noise event)', async () => {
    await eventBus.emit({
      type: 'receipt.extracted',
      payload: { receipt: {} as never, documentId: null, confidence: 0.9, userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('does NOT persist supplier_invoice.received (excluded noise event)', async () => {
    await eventBus.emit({
      type: 'supplier_invoice.received',
      payload: { inboxItem: {} as never, userId: 'user-1', companyId: 'company-1' },
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('does NOT persist supplier_invoice.extracted (excluded noise event)', async () => {
    await eventBus.emit({
      type: 'supplier_invoice.extracted',
      payload: { inboxItem: {} as never, confidence: 0.9, userId: 'user-1', companyId: 'company-1' },
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

  it('skips batch insert when companyId is missing from payload', async () => {
    await eventBus.emit({
      type: 'transaction.synced',
      payload: { transactions: [makeTransaction({ id: 'tx-1' })], userId: 'user-1' } as never,
    })

    expect(mockInsert).not.toHaveBeenCalled()
  })
})
