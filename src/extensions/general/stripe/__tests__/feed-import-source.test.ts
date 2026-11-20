import { describe, expect, it } from 'vitest'
import { FEED_CONNECTOR_IMPORT_SOURCES } from '@/lib/bookkeeping/feed-row-coverage'
import { STRIPE_IMPORT_SOURCE } from '../lib/transaction-sync'

describe('Stripe feed rows and the booking-time coverage guard (accounted#101)', () => {
  it("the core list of feed import sources names Stripe's", () => {
    expect(FEED_CONNECTOR_IMPORT_SOURCES).toContain(STRIPE_IMPORT_SOURCE)
  })
})
