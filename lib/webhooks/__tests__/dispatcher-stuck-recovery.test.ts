/**
 * Stuck-in_flight recovery and per-row re-stamping (#1257).
 *
 * Two defects are pinned here:
 *
 * 1. the sweep window used to be a fixed 2x REQUEST_TIMEOUT_MS (20 s), which
 *    is shorter than a single serial cycle, so cycle N recovered rows cycle
 *    N-1 was still working through;
 * 2. recovery reset rows to 'failed' without charging an attempt, so
 *    MAX_ATTEMPTS stopped being a real cap.
 *
 * The window is now derived from the bounded cycle and the cap is enforced
 * server-side by recover_stuck_webhook_deliveries, so the assertions here are
 * about what the dispatcher hands the RPC and about the per-row re-stamp that
 * makes a row's in_flight age measure its own attempt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PinnedFetchResult } from '../pinned-fetch'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
}))

// Import after mocks
import { dispatchDueDeliveries, __TESTING__ } from '../dispatcher'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const WEBHOOK_ID = '22222222-2222-4222-8222-222222222222'
const DELIVERY_IDS = [
  'aaaaaaaa-0001-4000-8000-000000000001',
  'aaaaaaaa-0002-4000-8000-000000000002',
  'aaaaaaaa-0003-4000-8000-000000000003',
]

/** Fixed clock so the derived window is exactly assertable. */
const NOW = new Date('2026-07-30T10:00:00.000Z')

interface RecordedUpdate {
  payload: Record<string, unknown>
  filters: Record<string, unknown>
}

interface Recorded {
  rpcCalls: { fn: string; args: Record<string, unknown> }[]
  deliveryUpdates: RecordedUpdate[]
}

/**
 * Ordered-log Supabase stub in the same house style as
 * dispatcher-auto-disable.test.ts. Every write against webhook_deliveries is
 * appended to `deliveryUpdates` in the order it resolves, so the interleaving
 * of touch writes and terminal writes is directly assertable.
 *
 * `lostOwnership` makes a specific delivery's touch resolve to zero rows,
 * which is how the real table reports "another cycle owns this row now".
 */
function makeSupabase(opts: {
  deliveryCount?: number
  attempts?: number
  lostOwnership?: Set<string>
} = {}): { client: SupabaseClient; recorded: Recorded } {
  const recorded: Recorded = { rpcCalls: [], deliveryUpdates: [] }
  const count = opts.deliveryCount ?? 1

  const client = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      recorded.rpcCalls.push({ fn, args })
      if (fn === 'claim_due_webhook_deliveries') {
        return {
          data: DELIVERY_IDS.slice(0, count).map((id) => ({
            id,
            webhook_id: WEBHOOK_ID,
            company_id: COMPANY_ID,
            event_type: 'invoice.paid',
            payload: { id: 'inv-1' },
            previous_attributes: null,
            api_version: '2026-05-12',
            attempts: opts.attempts ?? 0,
          })),
          error: null,
        }
      }
      // recover_stuck_webhook_deliveries: nothing stuck in these cases.
      return { data: [], error: null }
    }),
    from: vi.fn((table: string) => {
      if (table === 'webhook_deliveries') {
        return {
          update: (payload: Record<string, unknown>) => {
            const filters: Record<string, unknown> = {}
            const rec: RecordedUpdate = { payload, filters }
            const chain: Record<string, unknown> = {
              eq: (col: string, val: unknown) => {
                filters[col] = val
                return chain
              },
              in: (col: string, val: unknown) => {
                filters[col] = val
                return chain
              },
              // touchInFlight terminates with .select('id')
              select: async () => {
                recorded.deliveryUpdates.push(rec)
                const id = filters.id as string
                const lost = opts.lostOwnership?.has(id) ?? false
                return { data: lost ? [] : [{ id }], error: null }
              },
              // markDelivered / markDead / markFailedForRetry await the chain
              then: (resolve: (v: { error: null }) => unknown) => {
                recorded.deliveryUpdates.push(rec)
                return resolve({ error: null })
              },
            }
            return chain
          },
        }
      }

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
                },
              ],
              error: null,
            }),
          }),
        }
      }

      throw new Error(`unexpected table: ${table}`)
    }),
  } as unknown as SupabaseClient

  return { client, recorded }
}

/** Receiver answers 200 and records which delivery ids were actually POSTed. */
function makeOkFetch(postedIds: string[]) {
  return async (
    _url: string,
    init: { headers: Record<string, string> },
  ): Promise<PinnedFetchResult> => {
    postedIds.push(init.headers['X-Gnubok-Delivery'])
    return {
      kind: 'ok',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      bodyTruncated: false,
      pinnedAddress: '93.184.216.34',
    }
  }
}

function recoverArgs(recorded: Recorded): Record<string, unknown> {
  const call = recorded.rpcCalls.find((c) => c.fn === 'recover_stuck_webhook_deliveries')
  if (!call) throw new Error('recover_stuck_webhook_deliveries was never called')
  return call.args
}

describe('dispatcher stuck-in_flight recovery window', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('derives a window wider than one bounded cycle, so a mid-cycle row cannot be swept', async () => {
    const { client, recorded } = makeSupabase()

    await dispatchDueDeliveries({
      supabase: client,
      now: NOW,
      pinnedFetchImpl: makeOkFetch([]) as never,
    })

    const args = recoverArgs(recorded)
    const windowMs = NOW.getTime() - Date.parse(args.p_stuck_before as string)

    // 50 rows x 10 s = 500 s, clamped to the 120 s cycle budget, + one request
    // timeout + 30 s slack.
    expect(windowMs).toBe(160_000)

    // The old threshold. A concurrent tick must no longer be able to re-arm a
    // row that a live cycle claimed only a couple of attempts ago.
    expect(windowMs).toBeGreaterThan(__TESTING__.REQUEST_TIMEOUT_MS * 2)
    // And it must cover the whole bounded cycle, not just part of it.
    expect(windowMs).toBeGreaterThanOrEqual(__TESTING__.CYCLE_BUDGET_MS)

    expect(args.p_now).toBe(NOW.toISOString())
  })

  it('floors the window at the cron batch, so the 5-row kick cannot re-arm the cron rows', async () => {
    const { client, recorded } = makeSupabase()

    await dispatchDueDeliveries({
      supabase: client,
      batchSize: 5,
      now: NOW,
      pinnedFetchImpl: makeOkFetch([]) as never,
    })

    const windowMs = NOW.getTime() - Date.parse(recoverArgs(recorded).p_stuck_before as string)
    // Identical to the cron's window: the sweep is tenant-global, so a small
    // batch must not shrink it.
    expect(windowMs).toBe(160_000)
    expect(__TESTING__.stuckInFlightAfterMs(5)).toBe(
      __TESTING__.stuckInFlightAfterMs(__TESTING__.DEFAULT_BATCH_SIZE),
    )
  })

  it('hands the attempts cap to the RPC so recovery can charge the stall', async () => {
    const { client, recorded } = makeSupabase()

    await dispatchDueDeliveries({
      supabase: client,
      now: NOW,
      pinnedFetchImpl: makeOkFetch([]) as never,
    })

    // The cap stays single-sourced in TS; the increment happens in SQL, which
    // is the only place `attempts = attempts + 1` can be expressed atomically.
    expect(recoverArgs(recorded).p_max_attempts).toBe(__TESTING__.MAX_ATTEMPTS)
    expect(__TESTING__.MAX_ATTEMPTS).toBe(8)
  })
})

describe('dispatcher per-row in_flight re-stamp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('re-stamps each row immediately before its own attempt, not once at claim time', async () => {
    const { client, recorded } = makeSupabase({ deliveryCount: 3 })
    const posted: string[] = []

    const summary = await dispatchDueDeliveries({
      supabase: client,
      now: NOW,
      pinnedFetchImpl: makeOkFetch(posted) as never,
    })

    expect(summary.delivered).toBe(3)
    expect(posted).toEqual(DELIVERY_IDS)

    // touch, terminal, touch, terminal, touch, terminal. A single re-stamp at
    // claim time (the pre-fix behaviour) would leave only the three terminal
    // writes here, and rows 2 and 3 would carry the claim's updated_at into
    // the next cycle's sweep window.
    expect(recorded.deliveryUpdates).toHaveLength(6)
    for (let i = 0; i < 3; i++) {
      const touch = recorded.deliveryUpdates[i * 2]
      expect(touch.payload).toEqual({ status: 'in_flight' })
      expect(touch.filters).toEqual({ id: DELIVERY_IDS[i], status: 'in_flight' })

      const terminal = recorded.deliveryUpdates[i * 2 + 1]
      expect(terminal.payload).toMatchObject({ status: 'delivered' })
      expect(terminal.filters).toEqual({ id: DELIVERY_IDS[i] })
    }
  })

  it('drops the POST when the touch shows the row is no longer ours', async () => {
    const { client, recorded } = makeSupabase({
      deliveryCount: 3,
      lostOwnership: new Set([DELIVERY_IDS[1]]),
    })
    const posted: string[] = []

    const summary = await dispatchDueDeliveries({
      supabase: client,
      now: NOW,
      pinnedFetchImpl: makeOkFetch(posted) as never,
    })

    // The duplicate POST is what the issue calls avoidable load: the loser of
    // the race would have had its terminal write swallowed by the immutability
    // trigger anyway.
    expect(posted).toEqual([DELIVERY_IDS[0], DELIVERY_IDS[2]])
    expect(posted).not.toContain(DELIVERY_IDS[1])
    expect(summary.skipped).toBe(1)
    expect(summary.delivered).toBe(2)

    // No terminal write for the row we no longer own.
    const terminalForRow2 = recorded.deliveryUpdates.filter(
      (u) => u.filters.id === DELIVERY_IDS[1] && u.payload.status !== 'in_flight',
    )
    expect(terminalForRow2).toHaveLength(0)
  })

  it('reconciles the summary: picked === delivered + failed + dead + skipped + released', async () => {
    const { client } = makeSupabase({
      deliveryCount: 3,
      lostOwnership: new Set([DELIVERY_IDS[2]]),
    })

    const summary = await dispatchDueDeliveries({
      supabase: client,
      now: NOW,
      pinnedFetchImpl: makeOkFetch([]) as never,
    })

    expect(summary.picked).toBe(3)
    expect(
      summary.delivered + summary.failed + summary.dead + summary.skipped + summary.released,
    ).toBe(summary.picked)
  })
})

describe('dispatcher cycle budget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hands back unattempted claims instead of stranding them in in_flight', async () => {
    const { client, recorded } = makeSupabase({ deliveryCount: 3 })
    const posted: string[] = []

    // `Date.now` is the dispatcher's only real-clock read (the injected `now`
    // covers everything else), so driving it directly is enough to simulate a
    // receiver that ate the whole budget on the first row.
    let clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    const slowFetch = async (
      _url: string,
      init: { headers: Record<string, string> },
    ): Promise<PinnedFetchResult> => {
      posted.push(init.headers['X-Gnubok-Delivery'])
      clock += __TESTING__.CYCLE_BUDGET_MS
      return {
        kind: 'ok',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        bodyTruncated: false,
        pinnedAddress: '93.184.216.34',
      }
    }

    const summary = await dispatchDueDeliveries({
      supabase: client,
      now: NOW,
      pinnedFetchImpl: slowFetch as never,
    })

    // Row 1 fits, rows 2 and 3 do not: they are released, not POSTed.
    expect(posted).toEqual([DELIVERY_IDS[0]])
    expect(summary.delivered).toBe(1)
    expect(summary.released).toBe(2)
    expect(summary.picked).toBe(3)

    // Released rows go back to a re-claimable state immediately. Without this
    // they would sit in in_flight for the full 160 s window before any sweep
    // could re-arm them, and the sweep would then charge them an attempt they
    // never made.
    const release = recorded.deliveryUpdates.at(-1)
    expect(release?.payload).toEqual({
      status: 'failed',
      next_attempt_at: NOW.toISOString(),
    })
    expect(release?.filters).toEqual({
      id: [DELIVERY_IDS[1], DELIVERY_IDS[2]],
      status: 'in_flight',
    })
    // Not an attempt: `attempts` must not be bumped and the previous attempt's
    // diagnostic must survive.
    expect(release?.payload).not.toHaveProperty('attempts')
    expect(release?.payload).not.toHaveProperty('error')
  })
})
