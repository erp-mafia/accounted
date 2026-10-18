/**
 * The consumer index (lib/events/consumer-index.ts) is kept by hand; these
 * tests keep it fresh against what lib/init really subscribes, and keep the
 * event bus's import graph down to it.
 *
 * - The index equals subscriptions.fixture.json (event type to consumers, in
 *   dispatch order), which subscriptions.test.ts pins to the subscriptions
 *   ensureInitialized() wires.
 * - It equals the declared consumers directly too: EVENT_CONSUMERS and one
 *   consumer per extension with handlers in this run's generated extension
 *   list (CI builds core with none).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventConsumer } from '@/lib/events/consumers'
import {
  ASYNC_CONSUMER_SWITCHES,
  EVENT_CONSUMER_INDEX,
  INLINE_ONLY_CONSUMERS,
  eventDelivery,
  eventOutboxMode,
  isIndexedConsumer,
  outboxConsumerIds,
  outboxSwitchedConsumerIds,
} from '@/lib/events/consumer-index'

type Table = Record<string, string[]>

const sorted = (table: Readonly<Record<string, readonly string[]>>): Table =>
  Object.fromEntries(Object.keys(table).sort().map((type) => [type, [...table[type]]]))

function fixture(): Table {
  return JSON.parse(readFileSync(join(__dirname, 'subscriptions.fixture.json'), 'utf8')) as Table
}

async function loadedExtensionConsumerIds(): Promise<Set<string>> {
  const { FIRST_PARTY_EXTENSIONS } = await import('@/lib/extensions/_generated/extension-list')
  return new Set(FIRST_PARTY_EXTENSIONS.map((extension) => `ext:${extension.id}`))
}

/** The index as this run should see it: an extension's consumer only when that extension is loaded. */
async function indexForThisRun(): Promise<Table> {
  const loaded = await loadedExtensionConsumerIds()
  const table: Table = {}
  for (const [type, ids] of Object.entries(EVENT_CONSUMER_INDEX)) {
    const kept = (ids ?? []).filter((id) => !id.startsWith('ext:') || loaded.has(id))
    if (kept.length > 0) table[type] = kept
  }
  return sorted(table)
}

describe('event consumer index', () => {
  it('equals the characterised subscriptions (subscriptions.fixture.json), consumers in dispatch order', () => {
    expect(
      sorted(EVENT_CONSUMER_INDEX as Record<string, readonly string[]>),
      'the consumer index drifted from the consumers lib/init subscribes: update lib/events/consumer-index.ts with the fixture',
    ).toEqual(sorted(fixture()))
  })

  it('equals the declared consumers: EVENT_CONSUMERS, then one per loaded extension with event handlers', async () => {
    const { EVENT_CONSUMERS } = await import('@/lib/composition/event-consumers')
    const { FIRST_PARTY_EXTENSIONS } = await import('@/lib/extensions/_generated/extension-list')
    const { extensionEventConsumer } = await import('@/lib/extensions/registry')
    const consumers: EventConsumer[] = [
      ...EVENT_CONSUMERS,
      ...FIRST_PARTY_EXTENSIONS.map(extensionEventConsumer).filter((c): c is EventConsumer => c !== null),
    ]
    const declared: Table = {}
    for (const consumer of consumers) {
      for (const type of consumer.eventTypes) (declared[type] ??= []).push(consumer.id)
    }
    expect(sorted(declared)).toEqual(await indexForThisRun())
  }, 60_000)

  it('keeps event-log inline: it is never an outbox consumer', () => {
    expect([...INLINE_ONLY_CONSUMERS]).toEqual(['event-log'])
    for (const type of Object.keys(EVENT_CONSUMER_INDEX)) {
      expect(outboxConsumerIds(type)).not.toContain('event-log')
    }
  })

  it('gives each event type its outbox consumers: the index without event-log and without extensions not enabled', async () => {
    const { ENABLED_EXTENSION_IDS } = await import('@/lib/extensions/_generated/enabled-extensions')
    for (const [type, ids] of Object.entries(EVENT_CONSUMER_INDEX)) {
      expect(outboxConsumerIds(type), type).toEqual(
        (ids ?? []).filter((id) => id !== 'event-log' && (!id.startsWith('ext:') || ENABLED_EXTENSION_IDS.has(id.slice(4)))),
      )
    }
    expect(outboxConsumerIds('supplier_invoice.registered')).toEqual([
      'supplier-invoice-retro-match',
      'attest-notify',
      'webhooks',
      'suggestion-detectors',
    ])
    expect(outboxConsumerIds('transaction.synced')).toEqual([])
    expect(outboxConsumerIds('journal_entry.drafted')).toEqual([])
  })

  it('answers whether a consumer is indexed for a type', () => {
    expect(isIndexedConsumer('supplier_invoice.registered', 'attest-notify')).toBe(true)
    expect(isIndexedConsumer('supplier_invoice.registered', 'event-log')).toBe(true)
    expect(isIndexedConsumer('invoice.created', 'attest-notify')).toBe(false)
    expect(isIndexedConsumer('journal_entry.drafted', 'event-log')).toBe(false)
  })
})

describe('outbox consumers of an extension that is not enabled', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/extensions/_generated/enabled-extensions')
    vi.resetModules()
  })

  it('leaves the extension consumer out', async () => {
    vi.resetModules()
    vi.doMock('@/lib/extensions/_generated/enabled-extensions', () => ({ ENABLED_EXTENSION_IDS: new Set<string>() }))
    const index = await import('@/lib/events/consumer-index')
    expect(index.outboxConsumerIds('credit_note.created')).toEqual(['webhooks'])
    expect(index.outboxConsumerIds('document.classified')).toEqual([])
  })
})

describe('eventOutboxMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is off unless EVENT_OUTBOX_MODE says shadow', () => {
    vi.stubEnv('EVENT_OUTBOX_MODE', undefined)
    expect(eventOutboxMode()).toBe('off')
    for (const value of ['', 'off', 'on', 'async', 'true', 'shadowing']) {
      vi.stubEnv('EVENT_OUTBOX_MODE', value)
      expect(eventOutboxMode(), value).toBe('off')
    }
    for (const value of ['shadow', ' Shadow ', 'SHADOW']) {
      vi.stubEnv('EVENT_OUTBOX_MODE', value)
      expect(eventOutboxMode(), value).toBe('shadow')
    }
  })
})

describe('per-consumer delivery switches (step E3)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('switches webhooks only, by EVENT_DELIVERY_WEBHOOKS', () => {
    expect(ASYNC_CONSUMER_SWITCHES).toEqual({ webhooks: 'EVENT_DELIVERY_WEBHOOKS' })
  })

  it('is inline unless the switch says outbox, and always inline for a consumer without a switch', () => {
    vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', undefined)
    expect(eventDelivery('webhooks')).toBe('inline')
    expect(outboxSwitchedConsumerIds()).toEqual([])
    for (const value of ['', 'inline', 'off', 'on', 'async', 'true', 'outboxes']) {
      vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', value)
      expect(eventDelivery('webhooks'), value).toBe('inline')
    }
    for (const value of ['outbox', ' Outbox ', 'OUTBOX']) {
      vi.stubEnv('EVENT_DELIVERY_WEBHOOKS', value)
      expect(eventDelivery('webhooks'), value).toBe('outbox')
    }
    expect(outboxSwitchedConsumerIds()).toEqual(['webhooks'])
    for (const consumerId of ['event-log', 'attest-notify', 'ext:stripe', 'toString', '__proto__']) {
      expect(eventDelivery(consumerId), consumerId).toBe('inline')
    }
  })

  it('switches exactly the consumers the dispatcher can run (ASYNC_EVENT_CONSUMERS), each an outbox consumer', async () => {
    const { ASYNC_EVENT_CONSUMERS } = await import('@/lib/composition/async-event-consumers')
    expect(ASYNC_EVENT_CONSUMERS.map((consumer) => consumer.id).sort()).toEqual(Object.keys(ASYNC_CONSUMER_SWITCHES).sort())
    for (const consumer of ASYNC_EVENT_CONSUMERS) {
      expect(INLINE_ONLY_CONSUMERS.has(consumer.id)).toBe(false)
      for (const type of consumer.eventTypes) expect(outboxConsumerIds(type), type).toContain(consumer.id)
    }
  }, 60_000)

  it('declares each async consumer once: EVENT_CONSUMERS lists the same object', async () => {
    const { ASYNC_EVENT_CONSUMERS } = await import('@/lib/composition/async-event-consumers')
    const { EVENT_CONSUMERS } = await import('@/lib/composition/event-consumers')
    for (const consumer of ASYNC_EVENT_CONSUMERS) {
      expect(EVENT_CONSUMERS.filter((c) => c.id === consumer.id)).toEqual([consumer])
      expect(EVENT_CONSUMERS.find((c) => c.id === consumer.id)).toBe(consumer)
    }
  }, 60_000)
})

describe('the event bus import graph', () => {
  /** The module specifiers a source file imports, statically or dynamically. */
  function importsOf(relativePath: string): string[] {
    const source = readFileSync(join(__dirname, '..', relativePath), 'utf8')
    return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]!).sort()
  }

  it('bus.ts imports the consumer index and its old leaves only: no composition, handler or init module', () => {
    expect(importsOf('bus.ts')).toEqual([
      './consumer-index',
      './types',
      '@/lib/global-singleton',
      '@/lib/initialized',
      '@/lib/logger',
    ])
  })

  it('the consumer index imports only types and the generated list of enabled extension ids', () => {
    expect(importsOf('consumer-index.ts')).toEqual(['./types', '@/lib/extensions/_generated/enabled-extensions'])
  })

  it('the outbox dispatcher reaches the async consumers only, never the full consumer list or lib/init', () => {
    const imports = importsOf('outbox-dispatcher.ts')
    expect(imports.filter((specifier) => specifier.startsWith('@/lib/composition/'))).toEqual([
      '@/lib/composition/async-event-consumers',
    ])
    expect(imports.some((specifier) => /lib\/init(ialized)?$|\/bus$|\/handlers\//.test(specifier))).toBe(false)
  })
})
