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
      { consumerId: 'suggestion-detectors', inline: 'not_subscribed' },
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
      { consumerId: 'suggestion-detectors', inline: 'not_subscribed' },
    ])
  })

  it('enqueues nothing for an event whose only consumer is event-log', async () => {
    const handler = consumer('event-log', () => undefined)
    eventBus.on('bank_connection.revoked', handler)
    await eventBus.emit({
      type: 'bank_connection.revoked',
      payload: { connectionId: 'bc1', bankName: null, userId: 'u1', companyId: 'c1' },
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
      consumers: ['supplier-invoice-retro-match', 'attest-notify', 'webhooks', 'suggestion-detectors'],
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

/**
 * Step E3: EVENT_DELIVERY_WEBHOOKS. outbox, with the outbox mode shadow and a
 * writer installed: the bus does not run the webhooks consumer, it enqueues
 * the delivery as 'deferred' for the dispatcher. Anything else: webhooks run
 * inline exactly as before.
 */
describe('EVENT_DELIVERY_WEBHOOKS', () => {
  const invoiceSent: CoreEvent = {
    type: 'invoice.sent',
    payload: { invoice: { id: 'inv-1' }, userId: 'u1', companyId: '00000000-0000-4000-8000-000000000001' },
  } as unknown as CoreEvent

  function subscribeInvoiceSent() {
    const eventLog = consumer('event-log', () => undefined)
    const webhooks = consumer('webhooks', () => undefined)
    eventBus.on('invoice.sent', eventLog)
    eventBus.on('invoice.sent', webhooks)
    return { eventLog, webhooks }
  }

  it('outbox with the mode shadow: webhooks are not run inline but enqueued as deferred', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', 'outbox')
    const { eventLog, webhooks } = subscribeInvoiceSent()

    await eventBus.emit(invoiceSent)

    expect(eventLog).toHaveBeenCalledTimes(1)
    expect(webhooks).not.toHaveBeenCalled()
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith(invoiceSent, [{ consumerId: 'webhooks', inline: 'deferred' }])
    expect(logMock.warn).not.toHaveBeenCalled()
  })

  it('defers only the switched consumer: the others of the same event still run inline and are recorded as such', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', ' Outbox ')
    const attest = consumer('attest-notify', () => undefined)
    const webhooks = consumer('webhooks', () => undefined)
    eventBus.on('supplier_invoice.registered', attest)
    eventBus.on('supplier_invoice.registered', webhooks)

    await eventBus.emit(registered)

    expect(attest).toHaveBeenCalledTimes(1)
    expect(webhooks).not.toHaveBeenCalled()
    const inline: Record<string, string> = { 'attest-notify': 'ok', webhooks: 'deferred' }
    expect(writer).toHaveBeenCalledWith(
      registered,
      indexSpies.outboxConsumerIds(registered.type).map((consumerId: string) => ({
        consumerId,
        inline: inline[consumerId] ?? 'not_subscribed',
      })),
    )
    expect(writer.mock.calls[0]![1]).toEqual(
      expect.arrayContaining([
        { consumerId: 'attest-notify', inline: 'ok' },
        { consumerId: 'webhooks', inline: 'deferred' },
      ]),
    )
  })

  it.each([undefined, '', 'inline', 'async', 'true'])('runs webhooks inline as before when the switch is %s', async (value) => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', value)
    const { webhooks } = subscribeInvoiceSent()

    await eventBus.emit(invoiceSent)

    expect(webhooks).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith(invoiceSent, [{ consumerId: 'webhooks', inline: 'ok' }])
  })

  it('decides per emit: flipping the switch back runs the next event inline', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', 'outbox')
    const { webhooks } = subscribeInvoiceSent()

    await eventBus.emit(invoiceSent)
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', 'inline')
    await eventBus.emit(invoiceSent)

    expect(webhooks).toHaveBeenCalledTimes(1)
    expect(writer.mock.calls.map(([, deliveries]) => deliveries)).toEqual([
      [{ consumerId: 'webhooks', inline: 'deferred' }],
      [{ consumerId: 'webhooks', inline: 'ok' }],
    ])
  })

  it('outbox with the mode off: webhooks stay inline, nothing is enqueued, and that is logged once', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'off')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', 'outbox')
    const { webhooks } = subscribeInvoiceSent()

    await eventBus.emit(invoiceSent)
    await eventBus.emit(invoiceSent)

    expect(webhooks).toHaveBeenCalledTimes(2)
    expect(writer).not.toHaveBeenCalled()
    expect(indexSpies.outboxConsumerIds).not.toHaveBeenCalled()
    expect(logMock.warn).toHaveBeenCalledTimes(1)
    expect(logMock.warn).toHaveBeenCalledWith(
      'event delivery switch ignored: EVENT_OUTBOX_MODE is off, the consumers stay inline',
      { consumers: ['webhooks'] },
    )
  })

  it('runs the deferred consumer inline after all when the enqueue fails: never lost', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', 'outbox')
    const order: string[] = []
    eventBus.on('invoice.sent', consumer('event-log', () => void order.push('event-log')))
    const webhooks = consumer('webhooks', () => void order.push('webhooks'))
    eventBus.on('invoice.sent', webhooks)
    writer.mockImplementation(async () => {
      order.push('enqueue')
      throw new Error('event outbox enqueue failed: canceling statement due to statement timeout (57014)')
    })

    await expect(eventBus.emit(invoiceSent)).resolves.toBeUndefined()

    expect(webhooks).toHaveBeenCalledTimes(1)
    expect(webhooks).toHaveBeenCalledWith(invoiceSent.payload)
    expect(order).toEqual(['event-log', 'enqueue', 'webhooks'])
    expect(logMock.warn).toHaveBeenCalledWith('event outbox enqueue failed: deferred consumers ran inline', {
      eventType: 'invoice.sent',
      consumers: ['webhooks'],
    })
  })

  it('logs a failing fallback run like any handler failure, never throwing at the emitter', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', 'outbox')
    writer.mockRejectedValue(new Error('down'))
    eventBus.on(
      'invoice.sent',
      consumer('webhooks', async () => {
        throw new Error('fan-out failed')
      }),
    )

    await expect(eventBus.emit(invoiceSent)).resolves.toBeUndefined()
    expect(logMock.error).toHaveBeenCalledWith('handler failed', expect.any(Error), expect.objectContaining({ handler: 'webhooks' }))
  })

  it('defers nothing without an installed writer: webhooks run inline', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', 'outbox')
    eventBus.setOutboxWriter(null)
    const { webhooks } = subscribeInvoiceSent()

    await eventBus.emit(invoiceSent)

    expect(webhooks).toHaveBeenCalledTimes(1)
  })

  it('defers nothing for an event type webhooks do not consume', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', 'outbox')
    const relay = consumer('agent-feedback-relay', () => undefined)
    eventBus.on('agent.feedback', relay)

    await eventBus.emit({ type: 'agent.feedback', payload: { companyId: 'c1', userId: 'u1' } } as unknown as CoreEvent)

    expect(relay).toHaveBeenCalledTimes(1)
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent.feedback' }), [
      { consumerId: 'agent-feedback-relay', inline: 'ok' },
    ])
  })

  it('enqueues the deferred delivery even when nothing on the bus subscribes webhooks (the dispatcher runs it)', async () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', 'shadow')
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', 'outbox')

    await eventBus.emit(invoiceSent)

    expect(writer).toHaveBeenCalledWith(invoiceSent, [{ consumerId: 'webhooks', inline: 'deferred' }])
  })
})
