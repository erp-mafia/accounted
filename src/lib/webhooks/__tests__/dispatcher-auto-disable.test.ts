import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PinnedFetchResult } from '../pinned-fetch'

// Mock the logger so the warn-vs-error level can be asserted: the real logger
// suppresses warn in the test environment, and the point of this suite is that
// a dropped audit row surfaces at error level (which always forwards to the
// observability sink) rather than being swallowed.
const { logWarn, logError } = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: logWarn,
    error: logError,
    child: vi.fn(),
  }),
}))

// Import after mocks
import { dispatchDueDeliveries } from '../dispatcher'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const WEBHOOK_ID = '22222222-2222-4222-8222-222222222222'
const DELIVERY_ID = '33333333-3333-4333-8333-333333333333'

interface Recorded {
  auditInserts: Record<string, unknown>[]
  webhookUpdates: Record<string, unknown>[]
  webhookSelects: string[]
}

/**
 * Minimal Supabase stub shaped to the exact call chains the dispatcher uses.
 * `webhooksSelectResult` lets a test simulate the PostgREST 42703 that a
 * phantom column would produce, so the audit row's company scope can be
 * proven independent of the prior-state snapshot.
 */
function makeSupabase(opts: {
  auditInsertError?: { message: string; code: string } | null
  priorSnapshotError?: { message: string; code: string } | null
} = {}): { client: SupabaseClient; recorded: Recorded } {
  const recorded: Recorded = { auditInserts: [], webhookUpdates: [], webhookSelects: [] }

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
              attempts: 0,
            },
          ],
          error: null,
        }
      }
      return { data: null, error: null }
    }),
    from: vi.fn((table: string) => {
      if (table === 'audit_log') {
        return {
          insert: vi.fn(async (row: Record<string, unknown>) => {
            recorded.auditInserts.push(row)
            return { error: opts.auditInsertError ?? null }
          }),
        }
      }

      if (table === 'webhook_deliveries') {
        // update(...).eq(...)                                -> markDead / markDelivered
        // update(...).eq('id').eq('status').select('id')     -> touchInFlight
        //
        // The touch must resolve to a NON-empty row set: an empty result means
        // "this delivery is no longer ours" and the dispatcher skips the
        // attempt, which would take the 410 auto-disable path out of reach.
        // The stuck sweep no longer runs through this chain at all; it goes
        // through rpc('recover_stuck_webhook_deliveries').
        const thenable = {
          eq: () => thenable,
          select: async () => ({ data: [{ id: DELIVERY_ID }], error: null }),
          then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
        }
        return { update: () => thenable }
      }

      if (table === 'webhooks') {
        return {
          select: (cols: string) => {
            recorded.webhookSelects.push(cols)
            return {
              // loadWebhooksByIds
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
              // disableWebhook prior-state snapshot
              eq: () => ({
                maybeSingle: async () =>
                  opts.priorSnapshotError
                    ? { data: null, error: opts.priorSnapshotError }
                    : {
                        data: {
                          company_id: COMPANY_ID,
                          name: 'Payments receiver',
                          active: true,
                          disabled_at: null,
                          disabled_reason: null,
                        },
                        error: null,
                      },
              }),
            }
          },
          update: (row: Record<string, unknown>) => {
            recorded.webhookUpdates.push(row)
            return { eq: async () => ({ error: null }) }
          },
        }
      }

      throw new Error(`unexpected table: ${table}`)
    }),
  } as unknown as SupabaseClient

  return { client, recorded }
}

/** Receiver responds 410 Gone: the auto-disable path. */
const gone410 = async (): Promise<PinnedFetchResult> => ({
  kind: 'ok',
  status: 410,
  headers: { 'content-type': 'application/json' },
  body: '{}',
  bodyTruncated: false,
  pinnedAddress: '93.184.216.34',
})

describe('dispatcher auto-disable audit row', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes a company-scoped SECURITY_EVENT row attributed to the system dispatcher', async () => {
    const { client, recorded } = makeSupabase()

    const summary = await dispatchDueDeliveries({
      supabase: client,
      pinnedFetchImpl: gone410 as never,
    })

    expect(summary.dead).toBe(1)
    expect(recorded.webhookUpdates[0]).toMatchObject({ active: false, disabled_reason: 'http_410_gone' })

    expect(recorded.auditInserts).toHaveLength(1)
    const audit = recorded.auditInserts[0]
    expect(audit).toMatchObject({
      company_id: COMPANY_ID,
      action: 'SECURITY_EVENT',
      table_name: 'webhooks',
      record_id: WEBHOOK_ID,
      user_id: null,
      actor_id: null,
      actor_type: 'system',
      actor_label: 'webhook-dispatcher',
    })
    expect(audit.description).toContain('http_410_gone')
    expect(audit.old_state).toMatchObject({ active: true })
  })

  it('never selects a user_id column from webhooks (no such column exists)', async () => {
    const { client, recorded } = makeSupabase()

    await dispatchDueDeliveries({ supabase: client, pinnedFetchImpl: gone410 as never })

    expect(recorded.webhookSelects.length).toBeGreaterThan(0)
    for (const cols of recorded.webhookSelects) {
      expect(cols).not.toContain('user_id')
    }
  })

  it('keeps the audit row company-scoped when the prior-state snapshot read fails', async () => {
    const { client, recorded } = makeSupabase({
      priorSnapshotError: { message: 'column webhooks.x does not exist', code: '42703' },
    })

    await dispatchDueDeliveries({ supabase: client, pinnedFetchImpl: gone410 as never })

    expect(recorded.auditInserts).toHaveLength(1)
    const audit = recorded.auditInserts[0]
    expect(audit.company_id).toBe(COMPANY_ID)
    expect(audit.actor_type).toBe('system')
    expect(audit.old_state).toBeNull()
    expect(audit.description).toContain('prior snapshot unavailable')
  })

  it('surfaces a failed audit insert at error level rather than swallowing it', async () => {
    const { client } = makeSupabase({
      auditInsertError: { message: 'insert denied', code: '42501' },
    })

    await dispatchDueDeliveries({ supabase: client, pinnedFetchImpl: gone410 as never })

    expect(logError).toHaveBeenCalledWith(
      'audit_log insert failed for webhook auto-disable',
      expect.any(Error),
      expect.objectContaining({ webhookId: WEBHOOK_ID, companyId: COMPANY_ID, reason: 'http_410_gone' }),
    )
    // Must not degrade to warn: warn is suppressed in test and never reaches
    // the observability sink, which is what made the gap silent.
    expect(logWarn).not.toHaveBeenCalledWith(
      'audit_log insert failed for webhook auto-disable',
      expect.anything(),
    )
  })
})
