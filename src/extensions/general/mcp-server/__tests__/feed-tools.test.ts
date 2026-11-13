import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})
vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/feed-sync/connector-routes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feed-sync/connector-routes')>()
  return { ...actual, runFeedBackfill: vi.fn() }
})

import { createQueuedMockSupabase } from '@/tests/helpers'
import { CAPABILITY_BLOCKED_MESSAGE_SV, hasCapability } from '@/lib/entitlements/has-capability'
import { toToolError } from '../tool-result'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { runFeedBackfill } from '@/lib/feed-sync/connector-routes'
import { stripeFeed } from '@/extensions/general/stripe/index'
import { tools } from '../server'
import { createFeedTools } from '../feed-tools'
import type { McpTool, McpToolAnnotations } from '../server'

const ANNOTATIONS = {} as McpToolAnnotations
const feedTools = createFeedTools({ readOnly: ANNOTATIONS, writeOpenWorld: ANNOTATIONS })
const byName = (name: string): McpTool => feedTools.find((t) => t.name === name)!
const backfill = byName('gnubok_backfill_feed')
const list = byName('gnubok_list_feed_connections')

const OK = {
  ok: true as const,
  connectionId: 'conn-1',
  from: '2026-10-17T22:00:00.000Z',
  bookedThrough: null,
  // deadlineReached keeps it a FeedSyncSummary (whose fields are all optional).
  summary: { fetched: 1, imported: 2, duplicates: 0, errors: 0, deadlineReached: false },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(hasCapability).mockResolvedValue(true)
  vi.mocked(checkRateLimit).mockResolvedValue({ ok: true })
  vi.mocked(runFeedBackfill).mockResolvedValue(OK)
})

describe('the feed tools in the catalog', () => {
  it('lists the backfill (a direct write) and keeps the status read search-only', () => {
    expect(tools.find((t) => t.name === 'gnubok_backfill_feed')?.catalogVisibility).toBeUndefined()
    expect(tools.find((t) => t.name === 'gnubok_list_feed_connections')?.catalogVisibility).toBe('search')
  })
})

describe('gnubok_backfill_feed (crm#1385)', () => {
  it("runs the panel's backfill for the provider's connection", async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = (await backfill.execute(
      { provider: 'stripe', from: '2026-10-18' },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(runFeedBackfill).toHaveBeenCalledWith(
      stripeFeed,
      expect.objectContaining({ supabase, serviceClient: supabase, companyId: 'company-1' }),
      { from: '2026-10-18', connectionId: undefined, includeBooked: undefined },
    )
    expect(hasCapability).toHaveBeenCalledWith(supabase, 'company-1', stripeFeed.capability)
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'stripe:backfill', identifier: 'user-1' }),
    )
    expect(result).toMatchObject({
      connection_id: 'conn-1',
      provider: 'stripe',
      from: '2026-10-17T22:00:00.000Z',
      booked_through: null,
      summary: { imported: 2 },
    })
    expect(result.instructions).toMatch(/gnubok_list_uncategorized_transactions/)
  })

  it('says which days the books already held and how to fetch them anyway', async () => {
    vi.mocked(runFeedBackfill).mockResolvedValueOnce({ ...OK, bookedThrough: '2026-10-17' })
    const { supabase } = createQueuedMockSupabase()
    const result = (await backfill.execute(
      { provider: 'stripe', from: '2026-10-17' },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>
    expect(result.booked_through).toBe('2026-10-17')
    expect(result.instructions).toMatch(/2026-10-17.*include_booked=true/)
  })

  it('says a backfill the run bound paused is not done, and how to go on (accounted#209)', async () => {
    vi.mocked(runFeedBackfill).mockResolvedValueOnce({ ...OK, summary: { ...OK.summary, deadlineReached: true } })
    const { supabase } = createQueuedMockSupabase()
    const result = (await backfill.execute(
      { provider: 'stripe', from: '2026-01-01' },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>
    expect(result.instructions).not.toMatch(/^Fetched from/)
    expect(result.instructions).toMatch(/Started fetching from 2026-01-01/)
    expect(result.instructions).toMatch(/stopped before today.*last_synced_at.*gnubok_list_feed_connections/)
  })

  it('passes include_booked and connection_id through', async () => {
    const { supabase } = createQueuedMockSupabase()
    await backfill.execute(
      { provider: 'woocommerce', from: '2026-09-01', include_booked: true, connection_id: 'store-2' },
      'company-1',
      'user-1',
      supabase as never,
    )
    expect(vi.mocked(runFeedBackfill).mock.calls[0][2]).toEqual({
      from: '2026-09-01',
      connectionId: 'store-2',
      includeBooked: true,
    })
  })

  it('refuses an unknown provider before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      backfill.execute({ provider: 'paypal', from: '2026-10-01' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(runFeedBackfill).not.toHaveBeenCalled()
  })

  it("refuses without the provider's paid capability", async () => {
    vi.mocked(hasCapability).mockResolvedValueOnce(false)
    const { supabase } = createQueuedMockSupabase()
    const err = await backfill
      .execute({ provider: 'shopify', from: '2026-10-01' }, 'company-1', 'user-1', supabase as never)
      .then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ code: 'capability_blocked' })
    expect(runFeedBackfill).not.toHaveBeenCalled()
    // The envelope the dispatcher's own gate answers: it read as
    // UNKNOWN_ERROR, "Något gick fel. Försök igen.", when thrown.
    expect(toToolError(err).error).toMatchObject({
      code: 'capability_blocked',
      capability_blocked: true,
      retryable: false,
      message_sv: CAPABILITY_BLOCKED_MESSAGE_SV,
      remediation: { description: expect.stringContaining('/settings/billing') },
    })
  })

  it("shares the panel's rate limit", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 429 }) as never })
    const { supabase } = createQueuedMockSupabase()
    await expect(
      backfill.execute({ provider: 'stripe', from: '2026-10-01' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(runFeedBackfill).not.toHaveBeenCalled()
  })

  it('names the field at fault for a refused day, and NOT_FOUND without a connection', async () => {
    const { supabase } = createQueuedMockSupabase()
    vi.mocked(runFeedBackfill).mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: 'Startdatumet kan inte ligga i framtiden.',
      reason: 'future',
    })
    await expect(
      backfill.execute({ provider: 'stripe', from: '2999-01-01' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', issues: [{ field: 'from' }] })

    vi.mocked(runFeedBackfill).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: 'Inget anslutet Stripe-konto.',
      reason: 'not_connected',
    })
    await expect(
      backfill.execute({ provider: 'stripe', from: '2026-10-01' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reads a lost sync lock as retryable', async () => {
    vi.mocked(runFeedBackfill).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: 'En synkronisering pågår redan. Försök igen om en stund.',
      reason: 'locked',
    })
    const { supabase } = createQueuedMockSupabase()
    await expect(
      backfill.execute({ provider: 'zettle', from: '2026-10-01' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'TRANSIENT_ERROR' })
  })
})

describe('gnubok_list_feed_connections', () => {
  it("reads each provider's connections with its own cursor as last_synced_at", async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: 'conn-1',
          status: 'active',
          connected_at: '2026-10-17T23:17:34.194Z',
          error_message: null,
          transaction_sync_enabled: true,
          last_balance_txn_synced_at: '2026-10-22T03:31:10.843Z',
        },
      ],
    })
    const result = (await list.execute({ provider: 'stripe' }, 'company-1', 'user-1', supabase as never)) as {
      connections: Array<Record<string, unknown>>
    }
    expect(result.connections).toEqual([
      {
        connection_id: 'conn-1',
        provider: 'stripe',
        status: 'active',
        connected_at: '2026-10-17T23:17:34.194Z',
        last_synced_at: '2026-10-22T03:31:10.843Z',
        nightly_sync: true,
        error_message: null,
      },
    ])
    expect(findCalls('stripe_connections', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCalls('stripe_connections', 'neq')).toContainEqual(['status', 'revoked'])
  })

  it('reads all four feeds when no provider is named', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    const result = (await list.execute({}, 'company-1', 'user-1', supabase as never)) as {
      connections: unknown[]
      instructions: string
    }
    expect(result.connections).toEqual([])
    for (const table of ['stripe_connections', 'shopify_connections', 'woocommerce_connections', 'zettle_connections']) {
      expect(findCalls(table, 'select')).toHaveLength(1)
    }
    expect(result.instructions).toMatch(/No Stripe/)
  })
})
