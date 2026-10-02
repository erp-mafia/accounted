/**
 * The two places events could reach an endpoint that never proved ownership
 * (ADA CASA 7.1.2): fan-out (enqueue) and dispatch (send). A new or changed
 * URL gets nothing until verified; an endpoint from before verification keeps
 * receiving events inside its grace window and is paused after it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PinnedFetchResult } from '../pinned-fetch'

const { serviceClient, kick } = vi.hoisted(() => ({
  serviceClient: { current: null as unknown },
  kick: vi.fn(),
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }),
}))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => serviceClient.current,
}))
vi.mock('../dispatch-kick', () => ({ kickWebhookDispatch: kick }))

import { eventBus } from '@/lib/events/bus'
import { registerWebhookHandler } from '../handler'
import { dispatchDueDeliveries, __TESTING__ } from '../dispatcher'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const FUTURE = new Date(Date.now() + 10 * 86400_000).toISOString()
const PAST = new Date(Date.now() - 86400_000).toISOString()

describe('fan-out gate', () => {
  beforeEach(() => {
    eventBus.clear()
    kick.mockClear()
  })

  it('enqueues only for verified endpoints and legacy endpoints inside their grace window', async () => {
    const inserted: Array<Record<string, unknown>> = []
    serviceClient.current = {
      from: (table: string) => {
        if (table === 'webhooks') {
          const chain = {
            select: () => chain,
            eq: () => chain,
            is: () =>
              Promise.resolve({
                data: [
                  { id: 'verified', api_version_pinned: '2026-05-12', verified_at: PAST, verification_grace_ends_at: null },
                  { id: 'grace', api_version_pinned: '2026-05-12', verified_at: null, verification_grace_ends_at: FUTURE },
                  { id: 'pending', api_version_pinned: '2026-05-12', verified_at: null, verification_grace_ends_at: null },
                  { id: 'paused', api_version_pinned: '2026-05-12', verified_at: null, verification_grace_ends_at: PAST },
                ],
                error: null,
              }),
          }
          return chain
        }
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            inserted.push(...rows)
            return { error: null }
          },
        }
      },
    }

    registerWebhookHandler()
    await eventBus.emit({
      type: 'customer.created',
      payload: { customer: { id: 'c1' }, userId: 'u1', companyId: COMPANY_ID },
    } as unknown as Parameters<typeof eventBus.emit>[0])

    expect(inserted.map((r) => r.webhook_id).sort()).toEqual(['grace', 'verified'])
    expect(kick).toHaveBeenCalledTimes(1)
  })
})

// ──────────────────────────────────────────────────────────────────────

const WEBHOOK_ID = '22222222-2222-4222-8222-222222222222'
const DELIVERY_ID = '33333333-3333-4333-8333-333333333333'

function dispatchSupabase(webhookRow: Record<string, unknown>, attempts: number) {
  const updates: Array<Record<string, unknown>> = []
  const client = {
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'claim_due_webhook_deliveries') {
        return {
          data: [
            {
              id: DELIVERY_ID,
              webhook_id: WEBHOOK_ID,
              company_id: COMPANY_ID,
              event_type: 'invoice.paid',
              payload: { id: 'inv-1' },
              previous_attributes: null,
              api_version: '2026-05-12',
              attempts,
            },
          ],
          error: null,
        }
      }
      return { data: [], error: null }
    }),
    from: vi.fn((table: string) => {
      if (table === 'webhooks') {
        return {
          select: () => ({
            in: async () => ({
              data: [
                {
                  id: WEBHOOK_ID,
                  company_id: COMPANY_ID,
                  webhook_url: 'https://receiver.example.com/hook',
                  secret: 'whsec_test',
                  ...webhookRow,
                },
              ],
              error: null,
            }),
          }),
        }
      }
      // webhook_deliveries: touchInFlight (select) and the terminal/retry writes.
      return {
        update: (payload: Record<string, unknown>) => {
          updates.push(payload)
          const thenable = {
            eq: () => thenable,
            select: async () => ({ data: [{ id: DELIVERY_ID }], error: null }),
            then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
          }
          return thenable
        },
      }
    }),
  }
  return { client: client as unknown as SupabaseClient, updates }
}

const delivered = vi.fn(async (): Promise<PinnedFetchResult> => ({
  kind: 'ok',
  status: 200,
  headers: {},
  body: 'ok',
  bodyTruncated: false,
  pinnedAddress: '203.0.113.10',
}))

describe('dispatch gate', () => {
  beforeEach(() => {
    delivered.mockClear()
  })

  it('withholds a delivery to a pending endpoint: no request, retry scheduled, reason recorded', async () => {
    const { client, updates } = dispatchSupabase({ verified_at: null, verification_grace_ends_at: null }, 0)

    const summary = await dispatchDueDeliveries({ supabase: client, pinnedFetchImpl: delivered })

    expect(delivered).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ picked: 1, withheld: 1, delivered: 0, dead: 0 })
    const retry = updates.find((u) => u.status === 'failed')!
    expect(retry.attempts).toBe(1)
    expect(String(retry.error)).toMatch(/^endpoint_unverified/)
  })

  it('takes a withheld delivery terminal with reason endpoint_unverified when attempts run out', async () => {
    const { client, updates } = dispatchSupabase(
      { verified_at: null, verification_grace_ends_at: PAST },
      __TESTING__.MAX_ATTEMPTS - 1,
    )

    const summary = await dispatchDueDeliveries({ supabase: client, pinnedFetchImpl: delivered })

    expect(delivered).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ withheld: 1, dead: 1 })
    expect(updates.find((u) => u.status === 'dead')).toMatchObject({ error: 'endpoint_unverified' })
  })

  it('keeps delivering to a legacy endpoint inside its grace window', async () => {
    const { client } = dispatchSupabase({ verified_at: null, verification_grace_ends_at: FUTURE }, 0)

    const summary = await dispatchDueDeliveries({ supabase: client, pinnedFetchImpl: delivered })

    expect(delivered).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ delivered: 1, withheld: 0 })
  })

  it('pauses a legacy endpoint after its grace window closes', async () => {
    const { client } = dispatchSupabase({ verified_at: null, verification_grace_ends_at: PAST }, 0)

    const summary = await dispatchDueDeliveries({ supabase: client, pinnedFetchImpl: delivered })

    expect(delivered).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ withheld: 1, delivered: 0 })
  })
})
