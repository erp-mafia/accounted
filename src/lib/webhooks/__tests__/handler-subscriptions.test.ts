/**
 * registerWebhookHandler() must subscribe to exactly the catalogue in
 * lib/webhooks/public-events.ts: an event an agent can subscribe to via the
 * API but that the handler never fans out would be silently undeliverable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ __client: true })),
}))
vi.mock('next/server', () => ({ after: vi.fn() }))

import { eventBus } from '@/lib/events/bus'
import { registerWebhookHandler } from '../handler'
import { PUBLIC_WEBHOOK_EVENTS } from '../public-events'

describe('registerWebhookHandler', () => {
  beforeEach(() => {
    eventBus.clear()
    vi.clearAllMocks()
  })

  it('subscribes to every catalogued event type and nothing else', () => {
    const on = vi.spyOn(eventBus, 'on')
    registerWebhookHandler()
    const subscribed = on.mock.calls.map(([eventType]) => eventType).sort()
    expect(subscribed).toEqual([...PUBLIC_WEBHOOK_EVENTS].sort())
  })
})
