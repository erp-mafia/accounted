import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { beforeEach, describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * The event outbox (20261017120000_event_outbox, 20261017120100_event_outbox_functions):
 * enqueue_event writes the event and one delivery per consumer;
 * claim_event_deliveries leases due deliveries (SKIP LOCKED), claims an
 * expired lease again and never a done or dead one; a finish needs the
 * claim's attempt; one consumer's failure holds back nobody else; repeated
 * failure ends in dead; prune_event_outbox keeps owed work and deletes by
 * retention; event_outbox_shadow_counts is the shadow reconciliation. Both
 * tables are service role only.
 *
 * Nothing else writes the outbox in this suite (EVENT_OUTBOX_MODE is off), so
 * each test starts from empty tables.
 */

interface DeliveryRow {
  consumer_id: string
  status: string
  attempts: number
  lease_until: Date | null
  last_error: string | null
  inline_result: string | null
  done_at: Date | null
}

interface ClaimRow {
  outbox_id: string
  consumer_id: string
  attempts: number
  lease_until: Date
  company_id: string | null
  event_type: string
  payload: Record<string, unknown>
  created_at: Date
}

async function asService<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return runAsServiceRole(async (client) => (await client.query(sql, params)).rows as T[])
}

async function enqueue(params: {
  eventType?: string
  companyId?: string | null
  payload?: Record<string, unknown>
  consumers: string[]
  dedupeKey?: string | null
  inline?: Record<string, string> | null
}): Promise<string | null> {
  const rows = await asService<{ id: string | null }>(
    `SELECT public.enqueue_event($1, $2, $3::jsonb, $4::text[], $5, $6::jsonb) AS id`,
    [
      params.eventType ?? 'invoice.created',
      params.companyId ?? null,
      JSON.stringify(params.payload ?? { n: 1 }),
      params.consumers,
      params.dedupeKey ?? null,
      params.inline ? JSON.stringify(params.inline) : null,
    ],
  )
  return rows[0]!.id
}

const CLAIM_SQL = `SELECT * FROM public.claim_event_deliveries($1, $2, $3)`

async function claim(limit = 100, leaseSeconds = 60, maxAttempts = 8): Promise<ClaimRow[]> {
  return asService<ClaimRow>(CLAIM_SQL, [limit, leaseSeconds, maxAttempts])
}

async function complete(rows: Array<Pick<ClaimRow, 'outbox_id' | 'consumer_id' | 'attempts'>>): Promise<number> {
  const result = await asService<{ n: number }>(
    `SELECT public.complete_event_deliveries($1::bigint[], $2::text[], $3::integer[]) AS n`,
    [rows.map((r) => r.outbox_id), rows.map((r) => r.consumer_id), rows.map((r) => r.attempts)],
  )
  return result[0]!.n
}

async function fail(
  row: Pick<ClaimRow, 'outbox_id' | 'consumer_id' | 'attempts'>,
  error: string,
  retryAfterSeconds = 60,
  maxAttempts = 8,
): Promise<string> {
  const result = await asService<{ status: string }>(
    `SELECT public.fail_event_delivery($1, $2, $3, $4, $5, $6) AS status`,
    [row.outbox_id, row.consumer_id, row.attempts, error, retryAfterSeconds, maxAttempts],
  )
  return result[0]!.status
}

async function deliveries(outboxId: string): Promise<DeliveryRow[]> {
  const { rows } = await getPool().query<DeliveryRow>(
    `SELECT consumer_id, status, attempts, lease_until, last_error, inline_result, done_at
       FROM public.event_deliveries WHERE outbox_id = $1 ORDER BY consumer_id`,
    [outboxId],
  )
  return rows
}

/** Let every lease (or backoff) of the event's deliveries run out. */
async function expireLeases(outboxId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.event_deliveries SET lease_until = now() - interval '1 second'
      WHERE outbox_id = $1 AND lease_until IS NOT NULL`,
    [outboxId],
  )
}

async function ageEvent(outboxId: string, age: string): Promise<void> {
  await getPool().query(`UPDATE public.event_outbox SET created_at = now() - $2::interval WHERE id = $1`, [outboxId, age])
}

async function setStatus(outboxId: string, consumerId: string, status: 'done' | 'dead' | 'pending'): Promise<void> {
  await getPool().query(
    `UPDATE public.event_deliveries
        SET status = $3, done_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END, lease_until = NULL
      WHERE outbox_id = $1 AND consumer_id = $2`,
    [outboxId, consumerId, status],
  )
}

async function outboxIds(): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id FROM public.event_outbox ORDER BY id`)
  return rows.map((r) => r.id)
}

beforeEach(async () => {
  // Cascades to event_deliveries.
  await getPool().query(`DELETE FROM public.event_outbox`)
})

describe('enqueue_event (pg)', () => {
  it('writes the event and exactly one delivery per consumer, with the inline results', async () => {
    const { companyId } = await seedCompany()
    const payload = { companyId, userId: randomUUID(), invoice: { id: randomUUID(), total: 1250 } }

    const id = await enqueue({
      companyId,
      payload,
      consumers: ['webhooks', 'ext:stripe', 'webhooks'],
      inline: { webhooks: 'ok', 'ext:stripe': 'not_subscribed' },
    })
    expect(id).not.toBeNull()

    const { rows: events } = await getPool().query(
      `SELECT company_id, event_type, payload, dedupe_key FROM public.event_outbox WHERE id = $1`,
      [id],
    )
    expect(events).toEqual([{ company_id: companyId, event_type: 'invoice.created', payload, dedupe_key: null }])

    const rows = await deliveries(id!)
    expect(rows.map((r) => [r.consumer_id, r.status, r.attempts, r.inline_result, r.lease_until])).toEqual([
      ['ext:stripe', 'pending', 0, 'not_subscribed', null],
      ['webhooks', 'pending', 0, 'ok', null],
    ])
  })

  it('writes nothing without consumers, and nothing again for a dedupe key already there', async () => {
    expect(await enqueue({ consumers: [] })).toBeNull()
    expect(await outboxIds()).toEqual([])

    const first = await enqueue({ consumers: ['webhooks'], dedupeKey: 'journal_entry.committed:e1' })
    const second = await enqueue({ consumers: ['webhooks', 'attest-notify'], dedupeKey: 'journal_entry.committed:e1' })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(await outboxIds()).toEqual([first])
    expect((await deliveries(first!)).map((r) => r.consumer_id)).toEqual(['webhooks'])
  })

  it('keeps the event when its company id is not a company', async () => {
    const id = await enqueue({ companyId: randomUUID(), consumers: ['webhooks'] })
    const { rows } = await getPool().query(`SELECT company_id FROM public.event_outbox WHERE id = $1`, [id])
    expect(rows).toEqual([{ company_id: null }])
    expect(await deliveries(id!)).toHaveLength(1)
  })

  it('goes with its company (ON DELETE CASCADE)', async () => {
    const { rows } = await getPool().query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'public.event_outbox'::regclass AND contype = 'f'`,
    )
    expect(rows).toEqual([{ confdeltype: 'c' }])
  })
})

describe('claim_event_deliveries (pg)', () => {
  it('leases a due delivery once, with its event; an expired lease is claimed again', async () => {
    const { companyId } = await seedCompany()
    const id = await enqueue({ companyId, payload: { companyId, n: 7 }, consumers: ['webhooks'] })

    const [first, ...rest] = await claim(10, 60)
    expect(rest).toEqual([])
    expect(first).toMatchObject({
      outbox_id: id,
      consumer_id: 'webhooks',
      attempts: 1,
      company_id: companyId,
      event_type: 'invoice.created',
      payload: { companyId, n: 7 },
    })
    const leaseMs = first!.lease_until.getTime() - Date.now()
    expect(leaseMs).toBeGreaterThan(50_000)
    expect(leaseMs).toBeLessThan(70_000)
    expect((await deliveries(id!))[0]).toMatchObject({ status: 'claimed', attempts: 1 })

    // Leased: nobody else gets it.
    expect(await claim(10, 60)).toEqual([])

    // The holder died: the lease runs out and the delivery is claimed again.
    await expireLeases(id!)
    const again = await claim(10, 60)
    expect(again.map((r) => [r.outbox_id, r.consumer_id, r.attempts])).toEqual([[id, 'webhooks', 2]])
  })

  it('skips deliveries another claim holds locked (SKIP LOCKED)', async () => {
    const a = await enqueue({ consumers: ['webhooks'] })
    const b = await enqueue({ consumers: ['webhooks'] })

    const holder: PoolClient = await getClient()
    try {
      await holder.query('BEGIN')
      await holder.query(`SET LOCAL ROLE service_role`)
      const held = await holder.query<ClaimRow>(CLAIM_SQL, [1, 60, 8])
      expect(held.rows.map((r) => r.outbox_id)).toEqual([a])

      // The first claim has not committed: its row is locked and skipped,
      // not waited for.
      const other = await claim(10, 60)
      expect(other.map((r) => r.outbox_id)).toEqual([b])
      await holder.query('COMMIT')
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
  })

  it('never claims a done delivery again, and a finish needs the claim\'s attempt', async () => {
    const id = await enqueue({ consumers: ['webhooks'] })
    const [first] = await claim()

    // The lease ran out and another dispatcher claimed it: the first one's
    // finish lands nowhere.
    await expireLeases(id!)
    const [second] = await claim()
    expect(second!.attempts).toBe(2)
    expect(await complete([first!])).toBe(0)
    expect((await deliveries(id!))[0]!.status).toBe('claimed')

    expect(await complete([second!])).toBe(1)
    const [row] = await deliveries(id!)
    expect(row).toMatchObject({ status: 'done', lease_until: null, last_error: null })
    expect(row!.done_at).toBeInstanceOf(Date)

    // Done is final, whatever its lease column says.
    await getPool().query(
      `UPDATE public.event_deliveries SET lease_until = now() - interval '1 hour' WHERE outbox_id = $1`,
      [id],
    )
    expect(await claim()).toEqual([])
    expect(await complete([second!])).toBe(0)
  })

  it('lets one consumer\'s failure hold back no other consumer and no other event', async () => {
    const id = await enqueue({ consumers: ['webhooks', 'attest-notify'] })
    const claimed = await claim()
    expect(claimed.map((r) => r.consumer_id)).toEqual(['attest-notify', 'webhooks'])
    const attest = claimed.find((r) => r.consumer_id === 'attest-notify')!
    const webhooks = claimed.find((r) => r.consumer_id === 'webhooks')!

    expect(await fail(attest, 'mail provider answered 503', 300)).toBe('pending')
    expect(await complete([webhooks])).toBe(1)

    const rows = await deliveries(id!)
    expect(rows.map((r) => [r.consumer_id, r.status, r.last_error])).toEqual([
      ['attest-notify', 'pending', 'mail provider answered 503'],
      ['webhooks', 'done', null],
    ])
    // Backing off: not due for five minutes.
    expect(rows[0]!.lease_until!.getTime()).toBeGreaterThan(Date.now() + 250_000)

    // A later event is claimed while the failed delivery waits.
    const later = await enqueue({ consumers: ['attest-notify'] })
    expect((await claim()).map((r) => [r.outbox_id, r.consumer_id])).toEqual([[later, 'attest-notify']])

    // Once the backoff has passed, only the failed delivery comes back.
    await expireLeases(id!)
    expect((await claim()).map((r) => [r.outbox_id, r.consumer_id, r.attempts])).toEqual([[id, 'attest-notify', 2]])
  })

  it('ends repeated failure in dead, which is never claimed again', async () => {
    const id = await enqueue({ consumers: ['agent-feedback-relay'] })
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) {
      const [row] = await claim(10, 60, 3)
      expect(row!.attempts).toBe(i + 1)
      outcomes.push(await fail(row!, `attempt ${i + 1} failed`, 0, 3))
    }
    expect(outcomes).toEqual(['pending', 'pending', 'dead'])
    expect(await claim(10, 60, 3)).toEqual([])
    expect(await deliveries(id!)).toEqual([
      expect.objectContaining({ status: 'dead', attempts: 3, lease_until: null, last_error: 'attempt 3 failed' }),
    ])

    // A finish for a delivery that is no longer claimed changes nothing.
    expect(await fail({ outbox_id: id!, consumer_id: 'agent-feedback-relay', attempts: 3 }, 'late', 0, 3)).toBe(
      'lease_lost',
    )
  })

  it('makes a delivery dead when its lease runs out on the last attempt', async () => {
    const id = await enqueue({ consumers: ['webhooks'] })
    expect(await claim(10, 60, 1)).toHaveLength(1)
    await expireLeases(id!)

    expect(await claim(10, 60, 1)).toEqual([])
    expect(await deliveries(id!)).toEqual([
      expect.objectContaining({
        status: 'dead',
        attempts: 1,
        lease_until: null,
        last_error: 'lease expired on the last attempt',
      }),
    ])
  })

  it('refuses a batch size, lease or attempt limit out of range', async () => {
    await expect(claim(0, 60)).rejects.toMatchObject({ code: '22023' })
    await expect(claim(10, 1)).rejects.toMatchObject({ code: '22023' })
    await expect(claim(10, 60, 0)).rejects.toMatchObject({ code: '22023' })
  })
})

describe('prune_event_outbox (pg)', () => {
  it('deletes finished events after 7 days and dead ones after 30, never owed work', async () => {
    const doneOld = await enqueue({ consumers: ['webhooks'] })
    const doneRecent = await enqueue({ consumers: ['webhooks'] })
    const pendingOld = await enqueue({ consumers: ['webhooks'] })
    const deadRecent = await enqueue({ consumers: ['webhooks', 'attest-notify'] })
    const deadOld = await enqueue({ consumers: ['webhooks', 'attest-notify'] })

    await setStatus(doneOld!, 'webhooks', 'done')
    await ageEvent(doneOld!, '8 days')
    await setStatus(doneRecent!, 'webhooks', 'done')
    await ageEvent(doneRecent!, '2 days')
    await ageEvent(pendingOld!, '40 days')
    await setStatus(deadRecent!, 'webhooks', 'done')
    await setStatus(deadRecent!, 'attest-notify', 'dead')
    await ageEvent(deadRecent!, '10 days')
    await setStatus(deadOld!, 'webhooks', 'done')
    await setStatus(deadOld!, 'attest-notify', 'dead')
    await ageEvent(deadOld!, '31 days')

    const [{ pruned }] = await asService<{ pruned: number }>(`SELECT public.prune_event_outbox() AS pruned`)
    expect(pruned).toBe(2)
    expect(await outboxIds()).toEqual([doneRecent, pendingOld, deadRecent])
    // Their deliveries went with them.
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.event_deliveries WHERE outbox_id = ANY($1::bigint[])`,
      [[doneOld, deadOld]],
    )
    expect(rows[0]!.n).toBe(0)
  })
})

describe('event_outbox_shadow_counts (pg)', () => {
  it('compares what was enqueued with what ran inline, per hour, consumer and event type', async () => {
    const first = await enqueue({ consumers: ['webhooks', 'ext:stripe'], inline: { webhooks: 'ok', 'ext:stripe': 'not_subscribed' } })
    await enqueue({ consumers: ['webhooks'], inline: { webhooks: 'failed' } })
    await enqueue({ eventType: 'supplier_invoice.registered', consumers: ['attest-notify'], inline: { 'attest-notify': 'ok' } })
    const [claimed] = (await claim()).filter((r) => r.outbox_id === first && r.consumer_id === 'webhooks')
    await complete([claimed!])
    const others = (await claim(100, 60)).length
    expect(others).toBe(0)

    const rows = await asService<Record<string, unknown>>(
      `SELECT consumer_id, event_type, enqueued::int, inline_ok::int, inline_failed::int, not_subscribed::int,
              done::int, open::int, dead::int
         FROM public.event_outbox_shadow_counts(now() - interval '1 hour')`,
    )
    expect(rows).toEqual([
      { consumer_id: 'attest-notify', event_type: 'supplier_invoice.registered', enqueued: 1, inline_ok: 1, inline_failed: 0, not_subscribed: 0, done: 0, open: 1, dead: 0 },
      { consumer_id: 'ext:stripe', event_type: 'invoice.created', enqueued: 1, inline_ok: 0, inline_failed: 0, not_subscribed: 1, done: 0, open: 1, dead: 0 },
      { consumer_id: 'webhooks', event_type: 'invoice.created', enqueued: 2, inline_ok: 1, inline_failed: 1, not_subscribed: 0, done: 1, open: 1, dead: 0 },
    ])
  })
})

describe('event outbox access (pg)', () => {
  it('has RLS on with no policy, so only the service role reaches either table', async () => {
    const { rows } = await getPool().query<{ relname: string; rls: boolean; policies: number }>(
      `SELECT c.relname, c.relrowsecurity AS rls,
              (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
         FROM pg_class c
        WHERE c.oid IN ('public.event_outbox'::regclass, 'public.event_deliveries'::regclass)
        ORDER BY c.relname`,
    )
    expect(rows).toEqual([
      { relname: 'event_deliveries', rls: true, policies: 0 },
      { relname: 'event_outbox', rls: true, policies: 0 },
    ])
  })

  it('refuses a signed-in member reading, writing or enqueueing, even for their own company', async () => {
    const { userId, companyId } = await seedCompany()
    await enqueue({ companyId, payload: { companyId }, consumers: ['webhooks'] })

    for (const sql of [
      `SELECT * FROM public.event_outbox`,
      `SELECT * FROM public.event_deliveries`,
      `INSERT INTO public.event_outbox (event_type, payload) VALUES ('invoice.created', '{}'::jsonb)`,
      `SELECT public.enqueue_event('invoice.created', NULL, '{}'::jsonb, ARRAY['webhooks'])`,
      `SELECT * FROM public.claim_event_deliveries(10, 60)`,
    ]) {
      await expect(withUserContext(userId, (client) => client.query(sql)), sql).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('refuses the anon role', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      await expect(client.query(`SELECT * FROM public.event_outbox`)).rejects.toMatchObject({ code: '42501' })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
