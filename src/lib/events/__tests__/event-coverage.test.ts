/**
 * Every event type in CoreEvent (lib/events/types.ts) has a decision: it is
 * persisted (the event-log consumer writes it to event_log), consumed (some
 * other consumer subscribes to it), or listed in UNCONSUMED below. A new event
 * type without a decision fails here; so does an UNCONSUMED entry that has
 * since gained a consumer.
 *
 * Who subscribes to what comes from subscriptions.fixture.json, which
 * subscriptions.test.ts pins to what lib/init really wires.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CoreEventType } from '@/lib/events/types'

/**
 * Emitted, but neither persisted nor consumed today: nothing in core or in a
 * configured extension subscribes to them. Adding a consumer (or persisting
 * one) means taking it off this list.
 */
const UNCONSUMED: readonly CoreEventType[] = [
  // Draft lifecycle: drafted is always followed by journal_entry.committed;
  // cancelled and deleted concern entries without a voucher number.
  'journal_entry.drafted',
  'journal_entry.cancelled',
  'journal_entry.deleted',
  // Master data and company lifecycle.
  'account.deleted',
  'article.created',
  'article.updated',
  'company.deleted',
  // Annual report filing (Bolagsverket).
  'arsredovisning.forelagd',
  'arsredovisning.registered',
  'arsredovisning.status_changed',
  'arsredovisning.uploaded',
  // Collections (inkasso) case lifecycle.
  'collection.case_opened',
  'collection.case_updated',
  'collection.case_closed',
  // Invoicing and payroll.
  'recurring_invoice.executed',
  'salary_run.approval_reverted',
  // Skattekonto sync.
  'skattekonto.synced',
  'skattekonto.balance.changed',
  'skattekonto.transaction.upcoming',
  'skattekonto.connection.expired',
  // Connection lifecycle of Stripe and the sales channels (a till or webshop
  // connected wakes a suggestion detector; these wake nothing).
  'stripe.connected',
  'stripe.disconnected',
  'shopify.disconnected',
  'woocommerce.disconnected',
  'zettle.disconnected',
]

/** Every `type: '...'` of the CoreEvent union, read from its source. */
function coreEventTypes(): string[] {
  const source = readFileSync(join(__dirname, '..', 'types.ts'), 'utf8')
  const start = source.indexOf('export type CoreEvent =')
  const end = source.indexOf('export type CoreEventType')
  expect(start, 'CoreEvent union not found in lib/events/types.ts').toBeGreaterThan(-1)
  expect(end, 'CoreEventType not found in lib/events/types.ts').toBeGreaterThan(start)
  return [...source.slice(start, end).matchAll(/\btype: '([^']+)'/g)].map((m) => m[1])
}

const subscriptions = JSON.parse(
  readFileSync(join(__dirname, 'subscriptions.fixture.json'), 'utf8'),
) as Record<string, string[]>

describe('event type coverage', () => {
  const types = coreEventTypes()

  it('reads every event type of the CoreEvent union', () => {
    expect(types.length).toBeGreaterThan(0)
    expect(new Set(types).size, 'an event type is declared twice').toBe(types.length)
    const unknown = Object.keys(subscriptions).filter((type) => !types.includes(type))
    expect(unknown, 'subscribed event types missing from the parsed union').toEqual([])
  })

  it('gives every event type a decision: persisted, consumed, or UNCONSUMED', () => {
    const unconsumed = new Set<string>(UNCONSUMED)
    const undecided = types.filter((type) => !(subscriptions[type]?.length > 0) && !unconsumed.has(type))
    expect(
      undecided,
      'a new event type needs a decision: persist it (event-log), consume it, or list it in UNCONSUMED with a reason',
    ).toEqual([])
  })

  it('lists in UNCONSUMED only event types that exist and that nothing persists or consumes', () => {
    const stale = UNCONSUMED.filter((type) => !types.includes(type) || (subscriptions[type]?.length ?? 0) > 0)
    expect(stale, 'take these off UNCONSUMED: they are gone or have a consumer now').toEqual([])
    expect(new Set(UNCONSUMED).size).toBe(UNCONSUMED.length)
  })
})
