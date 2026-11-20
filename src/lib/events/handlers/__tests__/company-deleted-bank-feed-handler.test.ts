import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const mock = createQueuedMockSupabase()

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => mock.supabase) }))
vi.mock('@/lib/bank-feed/service', () => ({ disconnectBankFeedConnection: vi.fn() }))

import { disconnectBankFeedConnection } from '@/lib/bank-feed/service'
import { EVENT_CONSUMERS } from '@/lib/composition/event-consumers'
import { eventBus } from '@/lib/events/bus'
import { subscribeEventConsumers } from '@/lib/events/consumers'
import { endBankFeedsOfDeletedCompany } from '../company-deleted-bank-feed-handler'

const disconnect = vi.mocked(disconnectBankFeedConnection)
const payload = { companyId: 'co-1', userId: 'owner-1', archivedAt: '2026-11-13T10:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mock.reset()
  disconnect.mockImplementation(async (_ctx, connectionId) => ({ ok: true, data: { connection_id: connectionId } }))
})

describe('company.deleted: the bank feeds of the deleted company', () => {
  it('disconnects each Open Payments connection still holding a consent, as the owner who deleted, on the service client', async () => {
    mock.enqueue({ data: { archived_at: payload.archivedAt } })
    mock.enqueue({ data: [{ id: 'conn-1' }, { id: 'conn-2' }] })

    await endBankFeedsOfDeletedCompany(payload)

    expect(disconnect.mock.calls.map(([, id]) => id)).toEqual(['conn-1', 'conn-2'])
    expect(disconnect.mock.calls[0][0]).toMatchObject({ supabase: mock.supabase, companyId: 'co-1', userId: 'owner-1' })
    expect(mock.findCalls('bank_connections', 'eq')).toEqual([['company_id', 'co-1'], ['aggregator', 'open_payments']])
    expect(mock.findCall('bank_connections', 'neq')).toEqual(['status', 'revoked'])
  })

  it('reads only Open Payments rows, so an Enable Banking connection is never disconnected here', async () => {
    mock.enqueue({ data: { archived_at: payload.archivedAt } })
    mock.enqueue({ data: [] })

    await endBankFeedsOfDeletedCompany(payload)

    expect(mock.findCalls('bank_connections', 'eq')).toContainEqual(['aggregator', 'open_payments'])
    expect(mock.findCalls('bank_connections', 'eq')).not.toContainEqual(['aggregator', 'enable_banking'])
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('does nothing for a company without bank connections', async () => {
    mock.enqueue({ data: { archived_at: payload.archivedAt } })
    mock.enqueue({ data: null })

    await expect(endBankFeedsOfDeletedCompany(payload)).resolves.toBeUndefined()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('leaves a company that is not archived alone', async () => {
    mock.enqueue({ data: { archived_at: null } })

    await endBankFeedsOfDeletedCompany(payload)

    expect(mock.findCalls('bank_connections', 'select')).toEqual([])
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('logs a read failure and does not throw', async () => {
    mock.enqueue({ data: { archived_at: payload.archivedAt } })
    mock.enqueue({ error: { message: 'connection reset' } })

    await expect(endBankFeedsOfDeletedCompany(payload)).resolves.toBeUndefined()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('asks once more after a failed disconnect, then goes on to the next connection, and never throws', async () => {
    mock.enqueue({ data: { archived_at: payload.archivedAt } })
    mock.enqueue({ data: [{ id: 'conn-1' }, { id: 'conn-2' }, { id: 'conn-3' }] })
    disconnect
      // conn-1: refused once (a sync changed the configuration in between), then disconnected.
      .mockResolvedValueOnce({ ok: false, code: 'BANK_CONFIGURATION_CHANGED' })
      .mockResolvedValueOnce({ ok: true, data: { connection_id: 'conn-1' } })
      // conn-2: throws both times; logged, and conn-3 still runs.
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockRejectedValueOnce(new Error('connection reset'))

    await expect(endBankFeedsOfDeletedCompany(payload)).resolves.toBeUndefined()
    expect(disconnect.mock.calls.map(([, id]) => id)).toEqual(['conn-1', 'conn-1', 'conn-2', 'conn-2', 'conn-3'])
  })

  it('does not ask again for a connection that is already gone', async () => {
    mock.enqueue({ data: { archived_at: payload.archivedAt } })
    mock.enqueue({ data: [{ id: 'conn-1' }] })
    disconnect.mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND' })

    await endBankFeedsOfDeletedCompany(payload)

    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('runs when the delete route emits company.deleted, as the bank feed\'s consumer', async () => {
    const consumers = EVENT_CONSUMERS.filter((c) => c.eventTypes.includes('company.deleted'))
    expect(consumers.map((c) => ({ id: c.id, owner: c.owner }))).toEqual([{ id: 'deleted-company-bank-feeds', owner: 'bank-feed' }])
    subscribeEventConsumers(consumers)
    mock.enqueue({ data: { archived_at: payload.archivedAt } })
    mock.enqueue({ data: [{ id: 'conn-1' }] })

    await eventBus.emit({ type: 'company.deleted', payload })

    expect(disconnect.mock.calls.map(([, id]) => id)).toEqual(['conn-1'])
  })
})
