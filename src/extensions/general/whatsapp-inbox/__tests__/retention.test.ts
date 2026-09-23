import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BATCH,
  LINK_CODE_GRACE_HOURS,
  RATE_COUNTER_RETENTION_DAYS,
  REVOKED_LINK_SHRED_DAYS,
  TRANSCRIPT_RETENTION_DAYS,
  UNKNOWN_SENDER_RETENTION_DAYS,
  runRetention,
} from '@/extensions/general/whatsapp-inbox/lib/retention'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString()
}

/** The recorded cutoff must sit within a minute of `now - expectedMs`. */
function expectCutoffAt(cutoffIso: unknown, expectedMs: number) {
  expect(typeof cutoffIso).toBe('string')
  const drift = Math.abs(Date.now() - expectedMs - new Date(cutoffIso as string).getTime())
  expect(drift).toBeLessThan(60 * 1000)
}

/**
 * Enqueue one full no-op pass in execution order:
 * unknown-sender delete, transcript select (empty ends the loop),
 * link codes, rate counters, revoked-link shred.
 */
function enqueueEmptyRun(
  enqueue: (r: { data?: unknown; error?: unknown; count?: number | null }) => void,
  overrides: Partial<
    Record<'unknown' | 'select' | 'codes' | 'counters' | 'shred', {
      data?: unknown
      error?: unknown
      count?: number | null
    }>
  > = {},
) {
  enqueue(overrides.unknown ?? { data: null, count: 0 })
  enqueue(overrides.select ?? { data: [] })
  enqueue(overrides.codes ?? { data: null, count: 0 })
  enqueue(overrides.counters ?? { data: null, count: 0 })
  enqueue(overrides.shred ?? { data: null, count: 0 })
}

describe('runRetention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('purges transcript content at the 90-day boundary: 89-day row untouched, 91-day row purged', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: null, count: 0 }) // unknown-sender delete
    // The DB filter (created_at < cutoff) returns only the 91-day row.
    enqueue({ data: [{ id: 'm-91d' }] }) // transcript select, batch 1
    enqueue({ data: null }) // transcript update, batch 1 (partial batch ends loop)
    enqueue({ data: null, count: 0 }) // link codes
    enqueue({ data: null, count: 0 }) // counters
    enqueue({ data: null, count: 0 }) // shred

    const summary = await runRetention(supabase as unknown as SupabaseClient)

    // Second lt() on whatsapp_messages belongs to the transcript select
    // (the first is the unknown-sender delete's 30-day cutoff).
    const ltCalls = findCalls('whatsapp_messages', 'lt')
    const [, cutoff] = ltCalls[1] as [string, string]
    expect(ltCalls[1][0]).toBe('created_at')
    expectCutoffAt(cutoff, TRANSCRIPT_RETENTION_DAYS * DAY_MS)
    // Predicate boundary: an 89-day row does NOT satisfy created_at < cutoff,
    // a 91-day row does.
    expect(daysAgo(89) < cutoff).toBe(false)
    expect(daysAgo(91) < cutoff).toBe(true)

    // Idempotency: only rows still carrying content are selected.
    const orCall = calls.find((c) => c.table === 'whatsapp_messages' && c.method === 'or')
    expect(orCall?.args[0]).toBe('body_text.not.is.null,raw_payload.not.is.null')

    // The purge NULLs content only; the row skeleton survives.
    const patch = findCalls('whatsapp_messages', 'update')[0][0] as Record<string, unknown>
    expect(patch).toEqual({ body_text: null, raw_payload: null })
    const inCall = calls.find((c) => c.table === 'whatsapp_messages' && c.method === 'in')
    expect(inCall?.args).toEqual(['id', ['m-91d']])

    expect(summary.purgedTranscripts).toBe(1)
  })

  it('loops the transcript purge in batches until a partial batch', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const fullBatch = Array.from({ length: BATCH }, (_, i) => ({ id: `m-${i}` }))
    enqueue({ data: null, count: 0 }) // unknown-sender delete
    enqueue({ data: fullBatch }) // select, batch 1 (full -> loop again)
    enqueue({ data: null }) // update, batch 1
    enqueue({ data: [{ id: 'm-last' }] }) // select, batch 2 (partial -> stop)
    enqueue({ data: null }) // update, batch 2
    enqueue({ data: null, count: 0 }) // link codes
    enqueue({ data: null, count: 0 }) // counters
    enqueue({ data: null, count: 0 }) // shred

    const summary = await runRetention(supabase as unknown as SupabaseClient)

    expect(findCalls('whatsapp_messages', 'update')).toHaveLength(2)
    expect(summary.purgedTranscripts).toBe(BATCH + 1)
  })

  it('deletes unknown-sender rows at the 30-day boundary, never linked rows', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueueEmptyRun(enqueue, { unknown: { data: null, count: 3 } })

    const summary = await runRetention(supabase as unknown as SupabaseClient)

    const isCall = calls.find((c) => c.table === 'whatsapp_messages' && c.method === 'is')
    expect(isCall?.args).toEqual(['phone_link_id', null])

    const [column, cutoff] = findCalls('whatsapp_messages', 'lt')[0] as [string, string]
    expect(column).toBe('created_at')
    expectCutoffAt(cutoff, UNKNOWN_SENDER_RETENTION_DAYS * DAY_MS)
    expect(daysAgo(29) < cutoff).toBe(false)
    expect(daysAgo(31) < cutoff).toBe(true)

    expect(summary.deletedUnknownSenderMessages).toBe(3)
  })

  it('deletes link codes 24h after expiry, used or not', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueEmptyRun(enqueue, { codes: { data: null, count: 2 } })

    const summary = await runRetention(supabase as unknown as SupabaseClient)

    expect(findCalls('whatsapp_link_codes', 'delete')).toHaveLength(1)
    const [column, cutoff] = findCalls('whatsapp_link_codes', 'lt')[0] as [string, string]
    expect(column).toBe('expires_at')
    expectCutoffAt(cutoff, LINK_CODE_GRACE_HOURS * HOUR_MS)
    // No used_at filter: used and unused codes go alike.
    expect(hoursAgo(23) < cutoff).toBe(false)
    expect(hoursAgo(25) < cutoff).toBe(true)

    expect(summary.deletedLinkCodes).toBe(2)
  })

  it('deletes rate counters idle for more than 2 days', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueEmptyRun(enqueue, { counters: { data: null, count: 5 } })

    const summary = await runRetention(supabase as unknown as SupabaseClient)

    expect(findCalls('whatsapp_sender_rate_counters', 'delete')).toHaveLength(1)
    const [column, cutoff] = findCalls('whatsapp_sender_rate_counters', 'lt')[0] as [
      string,
      string,
    ]
    expect(column).toBe('updated_at')
    expectCutoffAt(cutoff, RATE_COUNTER_RETENTION_DAYS * DAY_MS)

    expect(summary.deletedRateCounters).toBe(5)
  })

  it('crypto-shreds revoked links only after 90 days, only once, keeping hash and mask', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueueEmptyRun(enqueue, { shred: { data: null, count: 1 } })

    const summary = await runRetention(supabase as unknown as SupabaseClient)

    const [patch, options] = findCalls('whatsapp_phone_links', 'update')[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    // phone_enc is NOT NULL in the schema: '' is the cleared marker. The
    // patch must never touch phone_hash (uniqueness history) or phone_masked
    // (audit display).
    expect(patch).toEqual({ phone_enc: '' })
    expect(options).toEqual({ count: 'exact' })

    const [column, cutoff] = findCalls('whatsapp_phone_links', 'lt')[0] as [string, string]
    expect(column).toBe('revoked_at')
    expectCutoffAt(cutoff, REVOKED_LINK_SHRED_DAYS * DAY_MS)
    // Boundary: revoked 89 days ago stays readable, 91 days ago is shredded.
    expect(daysAgo(89) < cutoff).toBe(false)
    expect(daysAgo(91) < cutoff).toBe(true)
    // Only once: already-cleared rows are excluded by the neq guard, so a
    // re-run never re-touches (or re-counts) them.
    const neqCall = calls.find((c) => c.table === 'whatsapp_phone_links' && c.method === 'neq')
    expect(neqCall?.args).toEqual(['phone_enc', ''])

    expect(summary.shreddedRevokedLinks).toBe(1)
  })

  it('isolates failures: one failing action never blocks the others', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueEmptyRun(enqueue, {
      unknown: { error: { message: 'boom' } },
      codes: { data: null, count: 4 },
      shred: { data: null, count: 2 },
    })

    const summary = await runRetention(supabase as unknown as SupabaseClient)

    expect(summary.deletedUnknownSenderMessages).toBe(0)
    expect(summary.deletedLinkCodes).toBe(4)
    expect(summary.shreddedRevokedLinks).toBe(2)
  })
})
