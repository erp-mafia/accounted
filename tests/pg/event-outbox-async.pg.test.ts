import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Event outbox step E3, webhooks delivered from the outbox:
 *   20261018110000/110100  event_deliveries.inline_result takes 'deferred'
 *   20261018110200         webhook_deliveries.outbox_id and the unique key
 *                          (webhook_id, outbox_id): the fan-out from the
 *                          outbox inserts or ignores on it
 *   20261018110300         claim_event_deliveries answers inline_result;
 *                          event_outbox_async_counts reconciles the deferred
 *                          deliveries
 */

async function asService<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return runAsServiceRole(async (client) => (await client.query(sql, params)).rows as T[])
}

async function enqueue(consumers: string[], inline: Record<string, string> | null, eventType = 'invoice.sent'): Promise<string> {
  const rows = await asService<{ id: string }>(
    `SELECT public.enqueue_event($1, NULL, '{"n":1}'::jsonb, $2::text[], NULL, $3::jsonb) AS id`,
    [eventType, consumers, inline ? JSON.stringify(inline) : null],
  )
  return rows[0]!.id
}

/** Webhooks this file created: their open deliveries are removed after each test. */
const createdWebhooks: string[] = []

async function insertWebhook(companyId: string): Promise<string> {
  const id = randomUUID()
  createdWebhooks.push(id)
  await getPool().query(
    `INSERT INTO public.webhooks (id, company_id, name, event_type, webhook_url, secret, active)
     VALUES ($1, $2, 'pg-test', 'invoice.sent', 'https://example.com/hook', $3, true)`,
    [id, companyId, `whsec_${randomUUID().replace(/-/g, '')}`],
  )
  return id
}

/**
 * The fan-out's write from the outbox, as PostgREST runs the upsert with
 * ignoreDuplicates and on_conflict=webhook_id,outbox_id. Answers the ids of
 * the rows it inserted.
 */
async function fanOutInsert(webhookId: string, companyId: string, outboxId: string | null): Promise<string[]> {
  const rows = await asService<{ id: string }>(
    `INSERT INTO public.webhook_deliveries (webhook_id, company_id, event_type, payload, api_version, request_id, outbox_id)
     VALUES ($1, $2, 'invoice.sent', '{"n":1}'::jsonb, '2026-05-12', $3, $4)
     ON CONFLICT (webhook_id, outbox_id) DO NOTHING
     RETURNING id`,
    [webhookId, companyId, `whfan_${randomUUID()}`, outboxId],
  )
  return rows.map((r) => r.id)
}

async function deliveriesOf(webhookId: string): Promise<Array<{ outbox_id: string | null; status: string }>> {
  const { rows } = await getPool().query(
    `SELECT outbox_id, status FROM public.webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at, id`,
    [webhookId],
  )
  return rows
}

beforeEach(async () => {
  await getPool().query(`DELETE FROM public.event_outbox`)
})

// The pending rows this file writes are due at once: left behind, they would
// be claimed by the webhook dispatcher tests that share the database
// (claim_due_webhook_deliveries takes the oldest due rows first). Terminal
// rows cannot be deleted, and are never claimed.
afterEach(async () => {
  if (createdWebhooks.length === 0) return
  await getPool().query(
    `DELETE FROM public.webhook_deliveries WHERE webhook_id = ANY($1::uuid[]) AND status NOT IN ('delivered', 'dead')`,
    [createdWebhooks.splice(0)],
  )
})

describe('event_deliveries.inline_result deferred (pg)', () => {
  it('takes deferred beside the shadow values, and nothing else', async () => {
    const id = await enqueue(['webhooks', 'attest-notify'], { webhooks: 'deferred', 'attest-notify': 'ok' })
    const { rows } = await getPool().query(
      `SELECT consumer_id, inline_result FROM public.event_deliveries WHERE outbox_id = $1 ORDER BY consumer_id`,
      [id],
    )
    expect(rows).toEqual([
      { consumer_id: 'attest-notify', inline_result: 'ok' },
      { consumer_id: 'webhooks', inline_result: 'deferred' },
    ])

    await expect(enqueue(['webhooks'], { webhooks: 'later' })).rejects.toMatchObject({ code: '23514' })
  })

  it('has the widened CHECK validated', async () => {
    const { rows } = await getPool().query(
      `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'public.event_deliveries'::regclass AND conname = 'event_deliveries_inline_result_check'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.convalidated).toBe(true)
    for (const value of ['ok', 'failed', 'not_subscribed', 'deferred']) expect(rows[0]!.def).toContain(`'${value}'`)
  })
})

describe('claim_event_deliveries with inline_result (pg)', () => {
  it('answers each claimed delivery with what the bus recorded, so the dispatcher runs only the deferred one', async () => {
    const id = await enqueue(['webhooks', 'attest-notify'], { webhooks: 'deferred', 'attest-notify': 'ok' })
    const shadowOnly = await enqueue(['webhooks'], null)

    const claimed = await asService<{ outbox_id: string; consumer_id: string; attempts: number; inline_result: string | null }>(
      `SELECT outbox_id, consumer_id, attempts, inline_result FROM public.claim_event_deliveries(10, 60, 8)`,
    )
    expect(claimed).toEqual([
      { outbox_id: id, consumer_id: 'attest-notify', attempts: 1, inline_result: 'ok' },
      { outbox_id: id, consumer_id: 'webhooks', attempts: 1, inline_result: 'deferred' },
      { outbox_id: shadowOnly, consumer_id: 'webhooks', attempts: 1, inline_result: null },
    ])
  })

  it('keeps its signature and stays service role only', async () => {
    const { rows } = await getPool().query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'claim_event_deliveries'`,
    )
    expect(rows).toEqual([{ sig: 'claim_event_deliveries(integer,integer,integer)' }])
    const { userId } = await seedCompany()
    await expect(
      withUserContext(userId, (client) => client.query(`SELECT * FROM public.claim_event_deliveries(10, 60)`)),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('webhook_deliveries.outbox_id: the fan-out idempotency key (pg)', () => {
  it('is a nullable bigint with a unique index over (webhook_id, outbox_id)', async () => {
    const { rows: columns } = await getPool().query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'webhook_deliveries' AND column_name = 'outbox_id'`,
    )
    expect(columns).toEqual([{ data_type: 'bigint', is_nullable: 'YES', column_default: null }])

    const { rows: indexes } = await getPool().query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'webhook_deliveries_webhook_outbox_key'`,
    )
    expect(indexes).toHaveLength(1)
    expect(indexes[0]!.indexdef).toMatch(/CREATE UNIQUE INDEX .* \(webhook_id, outbox_id\)$/)
  })

  it('makes a rerun of the same outbox delivery insert nothing for a webhook that already has its row', async () => {
    const { companyId } = await seedCompany()
    const webhookA = await insertWebhook(companyId)
    const webhookB = await insertWebhook(companyId)

    // First run: one row per webhook.
    expect(await fanOutInsert(webhookA, companyId, '9001')).toHaveLength(1)
    expect(await fanOutInsert(webhookB, companyId, '9001')).toHaveLength(1)
    // The same delivery again (a crash after the fan-out, an expired lease): nothing.
    expect(await fanOutInsert(webhookA, companyId, '9001')).toEqual([])
    expect(await fanOutInsert(webhookB, companyId, '9001')).toEqual([])
    // Another event for the same webhook is a new row.
    expect(await fanOutInsert(webhookA, companyId, '9002')).toHaveLength(1)

    expect(await deliveriesOf(webhookA)).toEqual([
      { outbox_id: '9001', status: 'pending' },
      { outbox_id: '9002', status: 'pending' },
    ])
    expect(await deliveriesOf(webhookB)).toEqual([{ outbox_id: '9001', status: 'pending' }])
  })

  it('ignores a rerun after the first row was delivered, without touching the immutable row', async () => {
    const { companyId } = await seedCompany()
    const webhook = await insertWebhook(companyId)
    const [id] = await fanOutInsert(webhook, companyId, '42')
    await getPool().query(
      `UPDATE public.webhook_deliveries SET status = 'delivered', delivered_at = now(), response_status = 200 WHERE id = $1`,
      [id],
    )

    expect(await fanOutInsert(webhook, companyId, '42')).toEqual([])
    expect(await deliveriesOf(webhook)).toEqual([{ outbox_id: '42', status: 'delivered' }])
  })

  it('leaves rows without an outbox id alone: inline rows never conflict, the same event may repeat as before', async () => {
    const { companyId } = await seedCompany()
    const webhook = await insertWebhook(companyId)

    // The inline fan-out and the v1 retry and test endpoints write no outbox id.
    expect(await fanOutInsert(webhook, companyId, null)).toHaveLength(1)
    expect(await fanOutInsert(webhook, companyId, null)).toHaveLength(1)
    // An outbox row for the same webhook is keyed apart from them.
    expect(await fanOutInsert(webhook, companyId, '7')).toHaveLength(1)

    expect(await deliveriesOf(webhook)).toEqual([
      { outbox_id: null, status: 'pending' },
      { outbox_id: null, status: 'pending' },
      { outbox_id: '7', status: 'pending' },
    ])
  })

  it('keeps the key apart from the outbox: pruning the event leaves the delivery and its outbox id', async () => {
    const { companyId } = await seedCompany()
    const webhook = await insertWebhook(companyId)
    const outboxId = await enqueue(['webhooks'], { webhooks: 'deferred' })
    await fanOutInsert(webhook, companyId, outboxId)

    await getPool().query(`DELETE FROM public.event_outbox WHERE id = $1`, [outboxId])

    expect(await deliveriesOf(webhook)).toEqual([{ outbox_id: outboxId, status: 'pending' }])
  })
})

describe('event_outbox_async_counts (pg)', () => {
  type Row = {
    consumer_id: string
    event_type: string
    enqueued: number
    processed: number
    open: number
    retrying: number
    dead: number
    retried: number
    max_attempts: number
    latency_p50_seconds: string | null
    latency_max_seconds: string | null
    oldest_open_seconds: string | null
  }

  async function counts(): Promise<Row[]> {
    return asService<Row>(
      `SELECT consumer_id, event_type, enqueued::int, processed::int, open::int, retrying::int, dead::int,
              retried::int, max_attempts, latency_p50_seconds::text, latency_max_seconds::text,
              oldest_open_seconds::text
         FROM public.event_outbox_async_counts(now() - interval '1 hour')`,
    )
  }

  it('counts the deferred deliveries only, per consumer and event type: processed, open, retrying, dead, latency', async () => {
    const done1 = await enqueue(['webhooks'], { webhooks: 'deferred' })
    const done2 = await enqueue(['webhooks'], { webhooks: 'deferred' })
    const retrying = await enqueue(['webhooks'], { webhooks: 'deferred' })
    const dead = await enqueue(['webhooks'], { webhooks: 'deferred' })
    await enqueue(['webhooks'], { webhooks: 'deferred' }, 'invoice.paid')
    // Shadow deliveries (ran inline) are the shadow counts' business.
    await enqueue(['webhooks', 'attest-notify'], { webhooks: 'ok', 'attest-notify': 'ok' })

    // done1: done on the first attempt, 10 s after the event; done2: on the
    // third, 50 s after; retrying: one failed attempt, waiting; dead: gave up.
    await getPool().query(
      `UPDATE public.event_outbox SET created_at = now() - interval '5 minutes' WHERE id = ANY($1::bigint[])`,
      [[done1, done2, retrying, dead]],
    )
    await getPool().query(
      `UPDATE public.event_deliveries d
          SET status = 'done', attempts = v.attempts, done_at = o.created_at + v.after
         FROM public.event_outbox o,
              (VALUES ($1::bigint, 1, interval '10 seconds'), ($2::bigint, 3, interval '50 seconds')) AS v(id, attempts, after)
        WHERE d.outbox_id = v.id AND o.id = v.id`,
      [done1, done2],
    )
    await getPool().query(
      `UPDATE public.event_deliveries SET attempts = 1, last_error = 'deadlock detected', lease_until = now() + interval '30 seconds'
        WHERE outbox_id = $1`,
      [retrying],
    )
    await getPool().query(
      `UPDATE public.event_deliveries SET status = 'dead', attempts = 8, last_error = 'still down' WHERE outbox_id = $1`,
      [dead],
    )

    const rows = await counts()
    expect(rows).toHaveLength(2)
    const sent = rows.find((r) => r.event_type === 'invoice.sent')!
    expect(sent).toMatchObject({
      consumer_id: 'webhooks',
      enqueued: 4,
      processed: 2,
      open: 1,
      retrying: 1,
      dead: 1,
      retried: 1,
      max_attempts: 8,
      latency_p50_seconds: '30.0',
      latency_max_seconds: '50.0',
    })
    expect(Number(sent.oldest_open_seconds)).toBeGreaterThanOrEqual(299)
    expect(rows.find((r) => r.event_type === 'invoice.paid')).toMatchObject({
      enqueued: 1,
      processed: 0,
      open: 1,
      retrying: 0,
      latency_p50_seconds: null,
    })
  })

  it('is service role only', async () => {
    const { userId } = await seedCompany()
    await expect(
      withUserContext(userId, (client) =>
        client.query(`SELECT * FROM public.event_outbox_async_counts(now() - interval '1 hour')`),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('leaves the shadow counts as they were: a deferred delivery is enqueued but ran nowhere inline', async () => {
    await enqueue(['webhooks'], { webhooks: 'deferred' })
    const rows = await asService<Record<string, number>>(
      `SELECT enqueued::int, inline_ok::int, inline_failed::int, not_subscribed::int
         FROM public.event_outbox_shadow_counts(now() - interval '1 hour')`,
    )
    expect(rows).toEqual([{ enqueued: 1, inline_ok: 0, inline_failed: 0, not_subscribed: 0 }])
  })
})
