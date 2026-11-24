import { describe, expect, it } from 'vitest'
import { FEED_CONNECTOR_IMPORT_SOURCES } from '@/lib/bookkeeping/feed-row-coverage'
import { STRIPE_FEED_IMPORT_SOURCE } from '@/lib/receipt-hunt/agent-worklist'
import { STRIPE_IMPORT_SOURCE } from '../lib/transaction-sync'

describe('Stripe feed rows and the booking-time coverage guard (accounted#101)', () => {
  it("the core list of feed import sources names Stripe's", () => {
    expect(FEED_CONNECTOR_IMPORT_SOURCES).toContain(STRIPE_IMPORT_SOURCE)
  })
})

describe('Stripe feed rows in the receipt hunt worklist', () => {
  it("reads Stripe's rows by the feed's own import source", () => {
    expect(STRIPE_FEED_IMPORT_SOURCE).toBe(STRIPE_IMPORT_SOURCE)
  })
})
