/**
 * The event bus and the event outbox (step E2).
 *
 * EVENT_OUTBOX_MODE off (the default): emit() makes no call beyond the
 * handlers, exactly as before the outbox existed: no writer, not even a look
 * at the consumer index.
 *
 * shadow: after every handler settled, the event is handed to the outbox
 * writer once, for its consumers other than event-log, each with what it did
 * inline; a failing or missing writer never reaches the emitter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JournalEntry, SupplierInvoice } from '@/types'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

const indexSpies = vi.hoisted(() => ({ outboxConsumerIds: vi.fn(), isIndexedConsumer: vi.fn() }))
vi.mock('@/lib/events/consumer-index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/events/consumer-index')>()
  indexSpies.outboxConsumerIds.mockImplementation(actual.outboxConsumerIds)
  indexSpies.isIndexedConsumer.mockImplementation(actual.isIndexedConsumer)
  return { ...actual, outboxConsumerIds: indexSpies.outboxConsumerIds, isIndexedConsumer: indexSpies.isIndexedConsumer }
})

import { eventBus, type OutboxWriter } from '../bus'
import type { CoreEvent, EventPayload } from '../types'

const writer = vi.fn<OutboxWriter>()

const registered: CoreEvent = {
  type: 'supplier_invoice.registered',
  payload: {
    supplierInvoice: { id: 'si-1' } as SupplierInvoice,
    userId: 'u1',
    companyId: '00000000-0000-4000-8000-000000000001',
  },
}

/** A subscription named after a consumer, as subscribeEventConsumers names it. */
function consumer<T extends CoreEvent['type']>(id: string, run: (payload: EventPayload<T>) => Promise<void> | void) {
  const handler = vi.fn(run)
  Object.defineProperty(handler, 'name', { value: id })
  return handler
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  eventBus.setOutboxWriter(writer)
  writer.mockResolvedValue(undefined)
})

afterEach(() => {
  eventBus.setOutboxWriter(null)
  vi.unstubAllEnvs()
})

describe('EVENT_OUTBOX_MODE off', () => {
  it.each([undefined, '', 'off', 'async', 'on'])('makes no call beyond the handlers when the mode is %s', async (mode) => {
    vi.stubEnv('EVENT_OUTBOX_MODE', mode)
    const handler = consumer('attest-notify', () => undefined)
    eventBus.on('supplier_invoice.registered', handler)

    await eventBus.emit(registered)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(registered.payload)
    expect(writer).not.toHaveBeenCalled()
    expect(indexSpies.outboxConsumerIds).not.toHaveBeenCalled()
    expect(indexSpies.isIndexedConsumer).not.toHaveBeenCalled()
    expect(logMock.warn).not.toHaveBeenCalled()
  })

  it('makes no call at all for an event without handlers', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', undefined)
    await eventBus.emit(registered)
    expect(writer).not.toHaveBeenCalled()
    expect(indexSpies.outboxConsumerIds).not.toHaveBeenCalled()
  })
})

describe('EVENT_OUTBOX_MODE shadow', () => {
  beforeEach(() => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
  })

  it('enqueues once, after every handler settled, for the consumers other than event-log, with their inline results', async () => {
    const settled: string[] = []
    eventBus.on(
      'supplier_invoice.registered',
      consumer('attest-notify', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        settled.push('attest-notify')
        throw new Error('mail down')
      }),
    )
    eventBus.on('supplier_invoice.registered', consumer('event-log', () => void settled.push('event-log')))
    eventBus.on('supplier_invoice.registered', consumer('webhooks', () => void settled.push('webhooks')))
    writer.mockImplementation(async () => {
      expect(settled.sort()).toEqual(['attest-notify', 'event-log', 'webhooks'])
    })

    await eventBus.emit(registered)

    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith(registered, [
      // In the index, but nothing on the bus ran it.
      { consumerId: 'supplier-invoice-retro-match', inline: 'not_subscribed' },
      { consumerId: 'attest-notify', inline: 'failed' },
      { consumerId: 'webhooks', inline: 'ok' },
    ])
    // The handler failure is still logged as before.
    expect(logMock.error).toHaveBeenCalledWith('handler failed', expect.any(Error), expect.objectContaining({ handler: 'attest-notify' }))
  })

  it('enqueues with every consumer not subscribed when nothing on the bus handles the event', async () => {
    await eventBus.emit(registered)
    expect(writer).toHaveBeenCalledWith(registered, [
      { consumerId: 'supplier-invoice-retro-match', inline: 'not_subscribed' },
      { consumerId: 'attest-notify', inline: 'not_subscribed' },
      { consumerId: 'webhooks', inline: 'not_subscribed' },
    ])
  })

  it('enqueues nothing for an event whose only consumer is event-log', async () => {
    const handler = consumer('event-log', () => undefined)
    eventBus.on('transaction.synced', handler)
    await eventBus.emit({
      type: 'transaction.synced',
      payload: { transactions: [], userId: 'u1', companyId: 'c1' },
    } as unknown as CoreEvent)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(writer).not.toHaveBeenCalled()
  })

  it('logs and swallows a writer failure: the emitter never sees it', async () => {
    writer.mockRejectedValue(new Error('event outbox enqueue failed: relation does not exist (42P01)'))
    eventBus.on('supplier_invoice.registered', consumer('webhooks', () => undefined))

    await expect(eventBus.emit(registered)).resolves.toBeUndefined()

    expect(logMock.warn).toHaveBeenCalledWith('event outbox shadow enqueue failed', {
      eventType: 'supplier_invoice.registered',
      consumers: ['supplier-invoice-retro-match', 'attest-notify', 'webhooks'],
      error: 'event outbox enqueue failed: relation does not exist (42P01)',
    })
  })

  it('does nothing more without an installed writer', async () => {
    eventBus.setOutboxWriter(null)
    const handler = consumer('webhooks', () => undefined)
    eventBus.on('supplier_invoice.registered', handler)
    await expect(eventBus.emit(registered)).resolves.toBeUndefined()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('logs a consumer that ran inline outside the consumer index: it would get no delivery', async () => {
    eventBus.on('journal_entry.committed', consumer('attest-notify', () => undefined))
    await eventBus.emit({
      type: 'journal_entry.committed',
      payload: { entry: { id: 'e1' } as JournalEntry, userId: 'u1', companyId: 'c1' },
    })
    expect(logMock.warn).toHaveBeenCalledWith('event consumer ran inline outside the consumer index', {
      eventType: 'journal_entry.committed',
      consumerId: 'attest-notify',
    })
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ type: 'journal_entry.committed' }), [
      { consumerId: 'webhooks', inline: 'not_subscribed' },
    ])
  })
})
