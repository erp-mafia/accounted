/**
 * Deliveries given up on for good: a warning per delivery, and per cycle a
 * report per webhook and reason that is an error when the webhook had no
 * other dead delivery in the 24 hours before (a streak starts) and a warning
 * while the streak goes on, so an endpoint that stays down is one error per
 * streak, not one per event. A cycle that disables a webhook (410, unsafe
 * URL) is always an error. A webhook is never disabled for dead deliveries
 * (that is the operators' decision); the HTTP 410 and unsafe-URL auto-disable
 * stays as it was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import type { PinnedFetchResult } from '../pinned-fetch'

const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: logWarn, error: logError, child: vi.fn() }),
}))

import { dispatchDueDeliveries, __TESTING__ } from '../dispatcher'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const WEBHOOK_A = '22222222-2222-4222-8222-222222222222'
const WEBHOOK_B = '44444444-4444-4444-8444-444444444444'
const LAST_ATTEMPT = __TESTING__.MAX_ATTEMPTS - 1

const respond = (status: number) => async (): Promise<PinnedFetchResult> => ({
  kind: 'ok',
  status,
  headers: { 'content-type': 'application/json' },
  body: '{}',
  bodyTruncated: false,
  pinnedAddress: '93.184.216.34',
})

const delivery = (id: string, webhookId: string, attempts: number) => ({
  id,
  webhook_id: webhookId,
  company_id: COMPANY_ID,
  event_type: 'invoice.paid',
  payload: { id: 'inv-1' },
  previous_attributes: null,
  api_version: '2026-05-12',
  attempts,
})

const webhook = (id: string, verified: boolean) => ({
  id,
  company_id: COMPANY_ID,
  webhook_url: `https://receiver.example.com/${id}`,
  secret: 'whsec_test',
  verified_at: verified ? '2026-05-15T12:00:00Z' : null,
  verification_grace_ends_at: null,
})

function setup(opts: {
  claimed: ReturnType<typeof delivery>[]
  webhooks?: ReturnType<typeof webhook>[]
  recovered?: Array<{ id: string; status: string; attempts: number }>
  /** Webhooks with another dead delivery in the last 24 hours. */
  deadInLastDay?: string[]
  /** The look-back read fails. */
  lookBackFails?: boolean
  /** What the read of the swept rows answers. */
  swept?: Array<{ id: string; webhook_id: string | null; company_id: string }>
}) {
  return createTableMockSupabase({
    'rpc:recover_stuck_webhook_deliveries': { data: opts.recovered ?? [] },
    'rpc:claim_due_webhook_deliveries': { data: opts.claimed },
    webhooks: (chain) => {
      if (chain.some((c) => c.method === 'update')) return { data: null }
      // The prior-state snapshot of the 410 auto-disable.
      if (chain.some((c) => c.method === 'maybeSingle')) {
        return { data: { company_id: COMPANY_ID, name: 'Receiver', active: true, disabled_at: null, disabled_reason: null } }
      }
      return { data: opts.webhooks ?? [webhook(WEBHOOK_A, true)] }
    },
    webhook_deliveries: (chain) => {
      // The 24-hour look-back of the report.
      if (chain.some((c) => c.method === 'gte')) {
        if (opts.lookBackFails) return { error: { code: '57014', message: 'statement timeout' } }
        const webhookId = chain.find((c) => c.method === 'eq' && c.args[0] === 'webhook_id')?.args[1] as string
        return { data: opts.deadInLastDay?.includes(webhookId) ? [{ id: 'earlier' }] : [] }
      }
      // The webhooks of the rows the stuck sweep took dead.
      if (!chain.some((c) => c.method === 'update') && chain.some((c) => c.method === 'in')) return { data: opts.swept ?? [] }
      // touchInFlight and the terminal writes: the claimed row is still ours.
      return { data: [{ id: 'still-ours' }] }
    },
    audit_log: { data: null },
  })
}

const NOW = new Date('2026-11-12T12:00:00Z')

const run = (mock: ReturnType<typeof setup>, status: number) =>
  dispatchDueDeliveries({ supabase: mock.supabase as unknown as SupabaseClient, pinnedFetchImpl: respond(status) as never, now: NOW })

describe('dispatcher: deliveries given up on for good', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs each dead delivery as a warning and a webhook\'s first in 24 hours once as an error, with the counts per reason', async () => {
    const mock = setup({ claimed: [delivery('d1', WEBHOOK_A, LAST_ATTEMPT), delivery('d2', WEBHOOK_A, LAST_ATTEMPT)] })

    const summary = await run(mock, 500)

    expect(summary.dead).toBe(2)
    expect(logWarn.mock.calls.filter(([message]) => message === 'delivery dead: attempts exhausted')).toHaveLength(2)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('webhook deliveries given up on', {
      dead: 2,
      webhooks: [{ webhookId: WEBHOOK_A, companyId: COMPANY_ID, dead: 2, reasons: { attempts_exhausted: 2 } }],
    })
    // The look-back covers the 24 hours before, and leaves out this cycle's own dead deliveries.
    expect(mock.findCalls('webhook_deliveries', 'gte')).toEqual([['updated_at', '2026-11-11T12:00:00.000Z']])
    expect(mock.findCalls('webhook_deliveries', 'not')).toEqual([['id', 'in', '(d1,d2)']])
  })

  it('reports a webhook with another dead delivery in the 24 hours before as a warning, so a streak is one error, not one per event', async () => {
    const mock = setup({
      claimed: [delivery('d1', WEBHOOK_A, LAST_ATTEMPT), delivery('d2', WEBHOOK_B, LAST_ATTEMPT)],
      webhooks: [webhook(WEBHOOK_A, true), webhook(WEBHOOK_B, true)],
      deadInLastDay: [WEBHOOK_A],
    })

    await run(mock, 500)

    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('webhook deliveries given up on', {
      dead: 1,
      webhooks: [{ webhookId: WEBHOOK_B, companyId: COMPANY_ID, dead: 1, reasons: { attempts_exhausted: 1 } }],
    })
    expect(logWarn).toHaveBeenCalledWith('webhook deliveries given up on: each webhook had another dead delivery in the 24 hours before', {
      dead: 1,
      webhooks: [{ webhookId: WEBHOOK_A, companyId: COMPANY_ID, dead: 1, reasons: { attempts_exhausted: 1 } }],
    })
  })

  it('reports an error when the look-back fails: never quiet on a guess', async () => {
    await run(setup({ claimed: [delivery('d1', WEBHOOK_A, LAST_ATTEMPT)], deadInLastDay: [WEBHOOK_A], lookBackFails: true }), 500)
    expect(logError).toHaveBeenCalledWith('webhook deliveries given up on', expect.objectContaining({ dead: 1 }))
  })

  it('never disables a webhook because its deliveries die', async () => {
    const mock = setup({ claimed: [delivery('d1', WEBHOOK_A, LAST_ATTEMPT)] })

    await run(mock, 500)

    expect(mock.payloads('webhooks', 'update')).toEqual([])
    expect(mock.payloads('audit_log', 'insert')).toEqual([])
  })

  it('names each webhook with its own reasons, and still auto-disables on HTTP 410 as before', async () => {
    const mock = setup({
      claimed: [delivery('d1', WEBHOOK_A, 0), delivery('d2', WEBHOOK_B, LAST_ATTEMPT)],
      webhooks: [webhook(WEBHOOK_A, true), webhook(WEBHOOK_B, false)],
    })

    await run(mock, 410)

    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('webhook deliveries given up on', {
      dead: 2,
      webhooks: [
        { webhookId: WEBHOOK_A, companyId: COMPANY_ID, dead: 1, reasons: { http_410_gone: 1 }, disabled: true },
        // Never sent: its endpoint is not verified.
        { webhookId: WEBHOOK_B, companyId: COMPANY_ID, dead: 1, reasons: { endpoint_unverified: 1 } },
      ],
    })
    expect(mock.payloads('webhooks', 'update')).toEqual([expect.objectContaining({ active: false, disabled_reason: 'http_410_gone' })])
  })

  it('always reports a cycle that disabled a webhook as an error, also inside a streak', async () => {
    const mock = setup({ claimed: [delivery('d1', WEBHOOK_A, 0)], deadInLastDay: [WEBHOOK_A] })

    await run(mock, 410)

    expect(logError).toHaveBeenCalledWith('webhook deliveries given up on', {
      dead: 1,
      webhooks: [{ webhookId: WEBHOOK_A, companyId: COMPANY_ID, dead: 1, reasons: { http_410_gone: 1 }, disabled: true }],
    })
    expect(logWarn).not.toHaveBeenCalledWith(expect.stringContaining('webhook deliveries given up on:'), expect.anything())
  })

  it('logs no error for a cycle that gave up on nothing', async () => {
    const mock = setup({ claimed: [delivery('d1', WEBHOOK_A, 2)] })

    const summary = await run(mock, 500)

    expect(summary).toMatchObject({ failed: 1, dead: 0 })
    expect(logError).not.toHaveBeenCalled()
  })

  it('reports the deliveries the stuck sweep took dead under their webhooks; rows it only re-armed stay a warning', async () => {
    await run(setup({ claimed: [], recovered: [{ id: 'r1', status: 'failed', attempts: 2 }] }), 500)
    expect(logError).not.toHaveBeenCalled()
    expect(logWarn).toHaveBeenCalledWith('recovered stuck in_flight rows', { count: 1, dead: 0, retrying: 1 })

    await run(
      setup({ claimed: [], recovered: [{ id: 'r2', status: 'dead', attempts: 8 }], swept: [{ id: 'r2', webhook_id: WEBHOOK_A, company_id: COMPANY_ID }] }),
      500,
    )
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('webhook deliveries given up on', {
      dead: 1,
      webhooks: [{ webhookId: WEBHOOK_A, companyId: COMPANY_ID, dead: 1, reasons: { stalled: 1 } }],
    })
  })

  it('names the swept dead rows it could not put under a webhook in the error', async () => {
    await run(setup({ claimed: [], recovered: [{ id: 'r3', status: 'dead', attempts: 8 }], swept: [] }), 500)
    expect(logError).toHaveBeenCalledWith('webhook deliveries given up on', { dead: 0, sweptDeadUnattributed: 1, webhooks: [] })
  })
})
