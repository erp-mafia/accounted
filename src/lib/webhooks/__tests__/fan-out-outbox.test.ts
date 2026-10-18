/**
 * The webhook fan-out (lib/webhooks/handler.ts, fanOutEvent) inline and from
 * the event outbox (step E3).
 *
 * Inline (no outbox delivery): exactly as before, on its own service-role
 * client, a plain insert, never throwing.
 * From the outbox: on the dispatcher's client, every row carries the outbox id
 * and is upserted with ignoreDuplicates on (webhook_id, outbox_id), so a
 * delivery the outbox runs twice fans out once (the unique key itself is
 * pinned in tests/pg/event-outbox-async.pg.test.ts); a lookup or insert
 * failure throws so the dispatcher retries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

const inlineClient = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => inlineClient.current) }))

const kick = vi.hoisted(() => vi.fn())
vi.mock('../dispatch-kick', () => ({ kickWebhookDispatch: kick }))

import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { WebhookFanOutError, fanOutEvent } from '../handler'

const COMPANY = '00000000-0000-4000-8000-000000000001'
const VERIFIED = { verified_at: '2026-10-01T00:00:00Z', verification_grace_ends_at: null }

type Result = { data?: unknown; error: { code?: string; message?: string } | null }

/** A client whose webhooks lookup answers `lookup` and whose writes answer `write`. */
function mockClient(lookup: Result, write: Result = { error: null }) {
  const insert = vi.fn(async (_rows: unknown) => write)
  const upsert = vi.fn(async (_rows: unknown, _options: unknown) => write)
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    contains: vi.fn(() => query),
    is: vi.fn(async () => lookup),
  }
  const from = vi.fn((table: string) => (table === 'webhooks' ? query : { insert, upsert }))
  return { client: { from } as unknown as SupabaseClient, from, insert, upsert }
}

const payload = { companyId: COMPANY, userId: 'user-1', invoice: { id: 'inv-1', user_id: 'user-1' } }
const twoWebhooks = {
  data: [
    { id: 'wh-1', api_version_pinned: '2026-05-12', ...VERIFIED },
    { id: 'wh-2', api_version_pinned: null, ...VERIFIED },
  ],
  error: null,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fanOutEvent inline (no outbox delivery)', () => {
  it('inserts one row per matching webhook on its own client, without an outbox id, then kicks the dispatch', async () => {
    const { client, insert, upsert } = mockClient(twoWebhooks)
    inlineClient.current = client

    await fanOutEvent('invoice.sent', payload)

    expect(createServiceClientNoCookies).toHaveBeenCalledTimes(1)
    expect(upsert).not.toHaveBeenCalled()
    const rows = insert.mock.calls[0]![0] as Array<Record<string, unknown>>
    expect(rows.map((row) => [row.webhook_id, row.company_id, row.event_type])).toEqual([
      ['wh-1', COMPANY, 'invoice.sent'],
      ['wh-2', COMPANY, 'invoice.sent'],
    ])
    expect(rows.every((row) => !('outbox_id' in row))).toBe(true)
    // Minimised: the actor ids are gone at any depth.
    expect(rows[0]!.payload).toEqual({ companyId: COMPANY, invoice: { id: 'inv-1' } })
    expect(kick).toHaveBeenCalledTimes(1)
  })

  it('never throws: a failed lookup or insert is logged and swallowed', async () => {
    inlineClient.current = mockClient({ data: null, error: { code: '57014', message: 'timeout' } }).client
    await expect(fanOutEvent('invoice.sent', payload)).resolves.toBeUndefined()
    expect(logMock.error).toHaveBeenCalledWith('webhook lookup failed', expect.anything(), expect.anything())

    inlineClient.current = mockClient(twoWebhooks, { error: { code: '23505', message: 'duplicate' } }).client
    await expect(fanOutEvent('invoice.sent', payload)).resolves.toBeUndefined()
    expect(logMock.error).toHaveBeenCalledWith('webhook_deliveries insert failed', expect.anything(), expect.anything())
    expect(kick).not.toHaveBeenCalled()
  })
})

describe('fanOutEvent from the outbox', () => {
  it('runs on the dispatcher client and upserts every row keyed by the outbox id, ignoring duplicates', async () => {
    const { client, insert, upsert } = mockClient(twoWebhooks)

    await fanOutEvent('invoice.sent', payload, { outboxId: 9001, attempt: 1, supabase: client })

    expect(createServiceClientNoCookies).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    expect(upsert).toHaveBeenCalledTimes(1)
    const [rows, options] = upsert.mock.calls[0]! as [Array<Record<string, unknown>>, unknown]
    expect(options).toEqual({ onConflict: 'webhook_id,outbox_id', ignoreDuplicates: true })
    expect(rows.map((row) => [row.webhook_id, row.outbox_id])).toEqual([
      ['wh-1', 9001],
      ['wh-2', 9001],
    ])
    expect(kick).toHaveBeenCalledTimes(1)
  })

  it('writes the same keys when the same delivery runs again, so the unique key turns the rerun into a no-op', async () => {
    const { client, upsert } = mockClient(twoWebhooks)

    await fanOutEvent('invoice.sent', payload, { outboxId: 77, attempt: 1, supabase: client })
    await fanOutEvent('invoice.sent', payload, { outboxId: 77, attempt: 2, supabase: client })

    const keys = upsert.mock.calls.map(([rows]) =>
      (rows as Array<Record<string, unknown>>).map((row) => `${row.webhook_id}:${row.outbox_id}`),
    )
    expect(keys).toEqual([
      ['wh-1:77', 'wh-2:77'],
      ['wh-1:77', 'wh-2:77'],
    ])
  })

  it('throws when the lookup fails, so the outbox retries the delivery', async () => {
    const { client, upsert } = mockClient({ data: null, error: { code: '57014', message: 'canceling statement' } })

    await expect(
      fanOutEvent('invoice.sent', payload, { outboxId: 1, attempt: 1, supabase: client }),
    ).rejects.toBeInstanceOf(WebhookFanOutError)
    expect(upsert).not.toHaveBeenCalled()
  })

  it('throws when the insert fails, so the outbox retries the delivery', async () => {
    const { client } = mockClient(twoWebhooks, { error: { code: '40P01', message: 'deadlock detected' } })

    await expect(fanOutEvent('invoice.sent', payload, { outboxId: 1, attempt: 1, supabase: client })).rejects.toMatchObject({
      name: 'WebhookFanOutError',
      code: '40P01',
      message: 'webhook fanout insert failed: deadlock detected (40P01)',
    })
    expect(kick).not.toHaveBeenCalled()
  })

  it('finishes without a write when no webhook matches', async () => {
    const { client, upsert } = mockClient({ data: [], error: null })
    await expect(fanOutEvent('invoice.sent', payload, { outboxId: 1, attempt: 1, supabase: client })).resolves.toBeUndefined()
    expect(upsert).not.toHaveBeenCalled()
    expect(kick).not.toHaveBeenCalled()
  })

  it('logs and finishes an event without a company: no retry could give it one', async () => {
    const { client, from } = mockClient(twoWebhooks)
    await expect(
      fanOutEvent('invoice.sent', { userId: 'u1' }, { outboxId: 1, attempt: 1, supabase: client }),
    ).resolves.toBeUndefined()
    expect(from).not.toHaveBeenCalled()
    expect(logMock.error).toHaveBeenCalledWith(
      'event missing companyId: webhook fanout skipped',
      expect.any(Error),
      { eventType: 'invoice.sent' },
    )
  })
})
