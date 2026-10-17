/**
 * Characterisation of every event subscription lib/init wires: the core
 * consumers and the handlers of every extension in extensions.config.json
 * (the generated extension list). It runs the real ensureInitialized(),
 * records each eventBus.on() call as (event type, consumer) and compares the
 * result with subscriptions.fixture.json, per event type in the order the
 * bus dispatches (registration order).
 *
 * The fixture was recorded before the static consumer registry existed
 * (lib/composition/event-consumers.ts), attributing each subscription to the
 * module that called eventBus.on(); the registry reproduces it unchanged.
 * Each subscription is now named after its consumer (subscribeEventConsumers,
 * lib/events/consumers.ts), so a subscription that is not one of the declared
 * consumers, a hand-written eventBus.on() in init's graph, fails the test.
 *
 * The fixture changes only with a deliberate change to which handlers run on
 * which events. Regenerate it with:
 *   UPDATE_EVENT_SUBSCRIPTIONS=1 npx vitest run --project unit src/lib/events/__tests__/subscriptions.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resetGlobalSingletons } from '@/lib/global-singleton'
import type { EventConsumer } from '@/lib/events/consumers'
import { MODULE_IDS } from '@/lib/modules/manifest'

// tests/unit/setup.ts stubs lib/init for every unit test; this one runs it.
vi.mock('@/lib/init', async (importOriginal) => importOriginal())

const FIXTURE_PATH = join(__dirname, 'subscriptions.fixture.json')
const UPDATE_COMMAND =
  'UPDATE_EVENT_SUBSCRIPTIONS=1 npx vitest run --project unit src/lib/events/__tests__/subscriptions.test.ts'

/** Event type to the consumers subscribed to it, in dispatch order. */
type SubscriptionTable = Record<string, string[]>

function sortedByEventType(table: SubscriptionTable): SubscriptionTable {
  return Object.fromEntries(Object.keys(table).sort().map((type) => [type, table[type]]))
}

/** The core consumers, then one per configured extension with event handlers, in subscription order. */
async function declaredConsumers(): Promise<EventConsumer[]> {
  const { EVENT_CONSUMERS } = await import('@/lib/composition/event-consumers')
  const { FIRST_PARTY_EXTENSIONS } = await import('@/lib/extensions/_generated/extension-list')
  const { extensionEventConsumer } = await import('@/lib/extensions/registry')
  const extensionConsumers = FIRST_PARTY_EXTENSIONS.map(extensionEventConsumer).filter(
    (consumer): consumer is EventConsumer => consumer !== null,
  )
  return [...EVENT_CONSUMERS, ...extensionConsumers]
}

async function recordSubscriptions(): Promise<SubscriptionTable> {
  vi.resetModules()
  resetGlobalSingletons()
  // validateEnvironment() checks nothing when the Supabase URL is a build
  // placeholder; the subscriptions do not depend on the environment.
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '__placeholder__')

  const { eventBus } = await import('@/lib/events/bus')
  const declaredIds = new Set((await declaredConsumers()).map((consumer) => consumer.id))

  const table: SubscriptionTable = {}
  const unattributed: string[] = []
  const on = eventBus.on.bind(eventBus)
  vi.spyOn(eventBus, 'on').mockImplementation((eventType, handler) => {
    if (declaredIds.has(handler.name)) (table[eventType] ??= []).push(handler.name)
    else unattributed.push(`${eventType} (subscription named '${handler.name}')`)
    return on(eventType, handler)
  })

  const { ensureInitialized } = await import('@/lib/init')
  ensureInitialized()

  vi.unstubAllEnvs()
  expect(
    unattributed,
    'a subscription that is not a declared consumer: add it to EVENT_CONSUMERS (lib/composition/event-consumers.ts)',
  ).toEqual([])

  return sortedByEventType(table)
}

function readFixture(): SubscriptionTable {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as SubscriptionTable
}

/** The `ext:<id>` consumer ids of the extensions this run loaded (CI runs core with none). */
async function loadedExtensionConsumerIds(): Promise<Set<string>> {
  const { FIRST_PARTY_EXTENSIONS } = await import('@/lib/extensions/_generated/extension-list')
  return new Set(FIRST_PARTY_EXTENSIONS.map((extension) => `ext:${extension.id}`))
}

/**
 * The fixture as this run should see it: the core consumers always, and an
 * extension's consumer only when that extension is in the generated list.
 * The fixture itself is recorded with every extension in
 * extensions.config.json; CI builds core with an empty list.
 */
async function expectedSubscriptions(): Promise<SubscriptionTable> {
  const loaded = await loadedExtensionConsumerIds()
  const expected: SubscriptionTable = {}
  for (const [type, consumers] of Object.entries(readFixture())) {
    const kept = consumers.filter((id) => !id.startsWith('ext:') || loaded.has(id))
    if (kept.length > 0) expected[type] = kept
  }
  return sortedByEventType(expected)
}

/** True when every extension the fixture names is loaded, so the fixture may be re-recorded. */
async function fixtureExtensionsLoaded(): Promise<boolean> {
  const loaded = await loadedExtensionConsumerIds()
  return Object.values(readFixture()).flat().every((id) => !id.startsWith('ext:') || loaded.has(id))
}

describe('event subscriptions wired by lib/init', () => {
  it('match the characterised set: each event type, its consumers, in dispatch order', async () => {
    const actual = await recordSubscriptions()

    if (process.env.UPDATE_EVENT_SUBSCRIPTIONS === '1') {
      expect(
        await fixtureExtensionsLoaded(),
        'record the fixture with every extension in extensions.config.json loaded (npm run setup:extensions)',
      ).toBe(true)
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(actual, null, 2)}\n`)
      return
    }

    expect(
      actual,
      `the subscriptions lib/init wires changed. Only for a deliberate change to which handlers run on which events, record it: ${UPDATE_COMMAND}`,
    ).toEqual(await expectedSubscriptions())
  }, 60_000)

  it('are exactly the declared consumers: EVENT_CONSUMERS, then one per extension with event handlers', async () => {
    const table: SubscriptionTable = {}
    for (const consumer of await declaredConsumers()) {
      for (const type of consumer.eventTypes) (table[type] ??= []).push(consumer.id)
    }
    expect(sortedByEventType(table)).toEqual(await expectedSubscriptions())
  }, 60_000)

  it('declare each consumer once, owned by a module or by its extension', async () => {
    const consumers = await declaredConsumers()
    const ids = consumers.map((consumer) => consumer.id)
    expect(new Set(ids).size, 'consumer ids are unique').toBe(ids.length)
    for (const consumer of consumers) {
      expect(consumer.eventTypes.length, consumer.id).toBeGreaterThan(0)
      expect(new Set(consumer.eventTypes).size, `${consumer.id} lists an event type twice`).toBe(
        consumer.eventTypes.length,
      )
      if (consumer.id.startsWith('ext:')) expect(consumer.owner, consumer.id).toBe(consumer.id)
      else expect(MODULE_IDS as readonly string[], consumer.id).toContain(consumer.owner)
    }
  }, 60_000)
})
