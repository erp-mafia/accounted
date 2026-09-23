import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

/**
 * recover_stuck_webhook_deliveries (migration 20260730123000, issue #1257).
 *
 * The sweep that pulls webhook deliveries out of in_flight moved from a
 * PostgREST chain into SQL so it can charge an attempt atomically and land a
 * row past MAX_ATTEMPTS on the same terminal state the normal retry path
 * produces. The properties that need real Postgres:
 *
 *   - `attempts = attempts + 1` actually happens (PostgREST cannot express it)
 *   - the re-armed row waits out the SAME backoff a normal failed attempt
 *     waits, so a repeatedly stranded row cannot burn its 8 attempts in
 *     minutes and land in the immutable 'dead' state uncontacted
 *   - a row at the cap becomes 'dead' with attempts = p_max_attempts, and the
 *     claim function then never picks it up again
 *   - terminal rows are skipped by the outer WHERE, so
 *     enforce_webhook_delivery_immutability never fires
 *   - the service-role gate rejects everyone else
 */

// ──────────────────────────────────────────────────────────────────────
// Fixtures: parent webhook + child delivery (copied from
// claim-due-webhook-deliveries.pg.test.ts, plus explicit updated_at)
// ──────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 8

/**
 * RETRY_BACKOFF_SECONDS from lib/webhooks/dispatcher.ts, spelled out rather
 * than imported: this file asserts what the SQL does with the array it is
 * handed, and importing the constant would make a schedule change silently
 * rewrite the expectations too.
 */
const BACKOFF = [60, 5 * 60, 30 * 60, 2 * 60 * 60, 12 * 60 * 60, 24 * 60 * 60, 48 * 60 * 60]

/**
 * Every delivery this file seeds, so the non-terminal ones can be removed
 * again. The suite is tenant-global by nature (the sweep has no company
 * filter) and a leftover row that becomes due later shows up as a phantom
 * extra claim in the sibling claim-due suite, which reads the whole table.
 * Terminal rows are left alone: block_webhook_delivery_terminal_delete
 * forbids deleting them, and the claim function never picks them up anyway.
 */
const seededDeliveryIds: string[] = []

afterAll(async () => {
  if (seededDeliveryIds.length === 0) return
  await getPool().query(
    `DELETE FROM public.webhook_deliveries
      WHERE id = ANY($1::uuid[]) AND status NOT IN ('delivered', 'dead')`,
    [seededDeliveryIds],
  )
})

async function insertWebhook(params: { companyId: string }): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhooks
       (id, company_id, name, event_type, webhook_url, secret, active)
     VALUES ($1, $2, 'pg-test', 'invoice.paid', 'https://example.com/hook', $3, true)`,
    [id, params.companyId, `whsec_${randomUUID().replace(/-/g, '')}`],
  )
  return id
}

/**
 * updated_at is only auto-stamped by the BEFORE UPDATE trigger, so a value
 * supplied at INSERT time sticks: that is what lets a row be seeded as
 * "abandoned N seconds ago".
 */
async function insertDelivery(params: {
  webhookId: string | null
  companyId: string
  status?: 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dead'
  attempts?: number
  updatedAt?: string
  nextAttemptAt?: string
  responseStatus?: number | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhook_deliveries
       (id, webhook_id, company_id, event_type, payload, api_version,
        status, next_attempt_at, attempts, updated_at, response_status)
     VALUES ($1, $2, $3, 'invoice.paid', '{"hello":"world"}'::jsonb, '2026-05-12',
             $4, $5, $6, $7, $8)`,
    [
      id,
      params.webhookId,
      params.companyId,
      params.status ?? 'in_flight',
      params.nextAttemptAt ?? new Date().toISOString(),
      params.attempts ?? 0,
      params.updatedAt ?? new Date().toISOString(),
      params.responseStatus ?? null,
    ],
  )
  seededDeliveryIds.push(id)
  return id
}

interface DeliveryRow {
  status: string
  attempts: number
  error: string | null
  next_attempt_at: Date
  response_status: number | null
}

async function readDelivery(id: string): Promise<DeliveryRow> {
  const r = await getPool().query<DeliveryRow>(
    `SELECT status, attempts, error, next_attempt_at, response_status
       FROM public.webhook_deliveries WHERE id = $1`,
    [id],
  )
  const row = r.rows[0]
  if (!row) throw new Error(`delivery ${id} not found`)
  return row
}

/** A timestamp far enough in the past to be inside any sane sweep window. */
function longAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString()
}

/** Sweep boundary: rows older than this are abandoned. */
function stuckBefore(seconds = 160): string {
  return new Date(Date.now() - seconds * 1000).toISOString()
}

describe('recover_stuck_webhook_deliveries.pg', () => {
  it('charges an attempt and re-arms an abandoned in_flight row', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
      attempts: 0,
      updatedAt: longAgo(600),
    })

    const pNow = new Date()
    const returned = await runAsServiceRole(async (client) => {
      const r = await client.query<{ id: string; status: string; attempts: number }>(
        `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], $4)`,
        [stuckBefore(), MAX_ATTEMPTS, BACKOFF, pNow.toISOString()],
      )
      return r.rows
    })

    expect(returned.find((r) => r.id === deliveryId)).toMatchObject({
      status: 'failed',
      attempts: 1,
    })

    const row = await readDelivery(deliveryId)
    // The undercount is the second half of #1257: without the increment a row
    // caught in the recover/re-claim loop is re-POSTed past MAX_ATTEMPTS.
    expect(row.attempts).toBe(1)
    expect(row.status).toBe('failed')
    expect(row.error).toBe('recovered_from_in_flight_timeout')
    // First backoff step, exactly like markFailedForRetry on a 0-attempt row.
    // p_now would make the row re-claimable on the next per-minute tick, which
    // is how a repeatedly stranded delivery burned all 8 attempts in minutes.
    expect(row.next_attempt_at.getTime()).toBe(pNow.getTime() + BACKOFF[0] * 1000)
  })

  it('re-arms a swept row far enough out that the next tick cannot claim it', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
      attempts: 0,
      updatedAt: longAgo(600),
    })

    const pNow = new Date()
    await runAsServiceRole(async (client) => {
      await client.query(
        `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], $4)`,
        [stuckBefore(), MAX_ATTEMPTS, BACKOFF, pNow.toISOString()],
      )
    })

    // The claim function is the real predicate: a swept row must NOT be due
    // at the moment it was swept, nor a tick later. Rolled back so the claim's
    // in_flight flips do not leak into the sibling claim-due suite.
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM public.claim_due_webhook_deliveries($1, $2)`,
        [100, new Date(pNow.getTime() + 59_000).toISOString()],
      )
      expect(rows.map((r) => r.id)).not.toContain(deliveryId)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('picks the backoff step for the attempt it just charged', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    // attempts = 3 before the sweep, so the charged attempt is the 4th and the
    // wait is BACKOFF[3] (2 h): index = attempts BEFORE this one, exactly the
    // lookup markFailedForRetry does in TS, shifted by one for 1-indexed
    // Postgres arrays.
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
      attempts: 3,
      updatedAt: longAgo(600),
    })

    const pNow = new Date()
    await runAsServiceRole(async (client) => {
      await client.query(
        `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], $4)`,
        [stuckBefore(), MAX_ATTEMPTS, BACKOFF, pNow.toISOString()],
      )
    })

    const row = await readDelivery(deliveryId)
    expect(row.attempts).toBe(4)
    expect(row.next_attempt_at.getTime()).toBe(pNow.getTime() + BACKOFF[3] * 1000)
  })

  it('clamps to the last backoff step instead of subscripting past the array', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
      attempts: 4,
      updatedAt: longAgo(600),
    })

    // A two-step schedule with a cap of 8: index 5 is past the end. Without
    // the least() clamp the subscript yields NULL and next_attempt_at would go
    // NULL, which the claim function reads as "not due, ever".
    const shortBackoff = [60, 300]
    const pNow = new Date()
    await runAsServiceRole(async (client) => {
      await client.query(
        `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], $4)`,
        [stuckBefore(), MAX_ATTEMPTS, shortBackoff, pNow.toISOString()],
      )
    })

    const row = await readDelivery(deliveryId)
    expect(row.attempts).toBe(5)
    expect(row.next_attempt_at).not.toBeNull()
    expect(row.next_attempt_at.getTime()).toBe(pNow.getTime() + 300 * 1000)
  })

  it('lands a row at the cap on the same dead state the normal path produces', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
      attempts: MAX_ATTEMPTS - 1,
      updatedAt: longAgo(600),
      responseStatus: 503,
    })

    await runAsServiceRole(async (client) => {
      await client.query(
        `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
        [stuckBefore(), MAX_ATTEMPTS, BACKOFF],
      )
    })

    const row = await readDelivery(deliveryId)
    expect(row.status).toBe('dead')
    expect(row.attempts).toBe(MAX_ATTEMPTS)
    expect(row.error).toBe('attempts_exhausted:in_flight_timeout')
    // The last recorded response is the only diagnostic left on an abandoned
    // attempt: recovery must not null it out the way markDead-without-outcome
    // does.
    expect(row.response_status).toBe(503)
  })

  it('does not retry a recovered-at-cap row forever: the claim function skips it', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
      attempts: MAX_ATTEMPTS - 1,
      updatedAt: longAgo(600),
    })

    await runAsServiceRole(async (client) => {
      await client.query(
        `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
        [stuckBefore(), MAX_ATTEMPTS, BACKOFF],
      )
    })
    expect((await readDelivery(deliveryId)).status).toBe('dead')

    // Inside a rolled-back transaction: the claim function flips every due row
    // in the table to in_flight, and this suite must not leave that behind for
    // the sibling claim-due file.
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
        [100],
      )
      expect(rows.map((r) => r.id)).not.toContain(deliveryId)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('a second sweep over the same rows does not trip the immutability trigger', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
      attempts: MAX_ATTEMPTS - 1,
      updatedAt: longAgo(600),
    })

    const sweep = () =>
      runAsServiceRole(async (client) => {
        await client.query(
          `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
          [stuckBefore(), MAX_ATTEMPTS, BACKOFF],
        )
      })

    await sweep()
    // The row is now 'dead', so the WHERE excludes it and
    // enforce_webhook_delivery_immutability is never reached. A sweep that
    // matched terminal rows would abort the whole statement with a
    // check_violation.
    await expect(sweep()).resolves.toBeUndefined()

    const row = await readDelivery(deliveryId)
    expect(row.status).toBe('dead')
    expect(row.attempts).toBe(MAX_ATTEMPTS)
  })

  it('leaves a row a live cycle is still working through alone', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    // Freshly re-stamped by touchInFlight right before its own attempt.
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
      attempts: 2,
      updatedAt: new Date().toISOString(),
    })

    const returned = await runAsServiceRole(async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
        [stuckBefore(), MAX_ATTEMPTS, BACKOFF],
      )
      return r.rows
    })

    expect(returned.map((r) => r.id)).not.toContain(deliveryId)
    const row = await readDelivery(deliveryId)
    expect(row.status).toBe('in_flight')
    expect(row.attempts).toBe(2)
  })

  it('never touches terminal rows, however old their updated_at is', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    const deliveredId = await insertDelivery({
      webhookId,
      companyId,
      status: 'delivered',
      attempts: 1,
      updatedAt: longAgo(6000),
    })
    const deadId = await insertDelivery({
      webhookId,
      companyId,
      status: 'dead',
      attempts: MAX_ATTEMPTS,
      updatedAt: longAgo(6000),
    })

    // No check_violation: the statement must complete, not abort.
    await expect(
      runAsServiceRole(async (client) => {
        await client.query(
          `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
          [stuckBefore(), MAX_ATTEMPTS, BACKOFF],
        )
      }),
    ).resolves.toBeUndefined()

    expect(await readDelivery(deliveredId)).toMatchObject({ status: 'delivered', attempts: 1 })
    expect(await readDelivery(deadId)).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS })
  })

  it('requires the service role', async () => {
    // Plain pool: superuser connection, auth.role() NULL. Nothing reachable by
    // anon or authenticated may re-arm another tenant's deliveries.
    await expect(
      getPool().query(
        `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
        [stuckBefore(), MAX_ATTEMPTS, BACKOFF],
      ),
    ).rejects.toThrow(/server-controlled service role/i)
  })

  it('rejects a missing stuck boundary and a non-positive cap', async () => {
    await expect(
      runAsServiceRole(async (client) => {
        await client.query(
          `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
          [null, MAX_ATTEMPTS, BACKOFF],
        )
      }),
    ).rejects.toThrow(/p_stuck_before is required/i)

    await expect(
      runAsServiceRole(async (client) => {
        await client.query(
          `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
          [stuckBefore(), 0, BACKOFF],
        )
      }),
    ).rejects.toThrow(/p_max_attempts must be > 0/i)

    await expect(
      runAsServiceRole(async (client) => {
        await client.query(
          `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
          [stuckBefore(), null, BACKOFF],
        )
      }),
    ).rejects.toThrow(/p_max_attempts must be > 0/i)
  })

  it('rejects a missing or non-positive backoff schedule', async () => {
    // A NULL, empty or zero/negative schedule would re-arm swept rows for
    // immediate re-claim, which is the strand loop the backoff exists to stop.
    // Failing loudly beats silently reverting to next_attempt_at = p_now.
    for (const backoff of [null, [], [60, 0], [60, -5]]) {
      await expect(
        runAsServiceRole(async (client) => {
          await client.query(
            `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
            [stuckBefore(), MAX_ATTEMPTS, backoff],
          )
        }),
      ).rejects.toThrow(/p_backoff/i)
    }
  })
})

/**
 * The other half of #1257 lives in TypeScript (touchInFlight), but it rests
 * entirely on two DB behaviours that no mock can prove. Pinned here because
 * if either stops holding, the fix silently reverts to the defect: a row
 * carrying its claim-time updated_at into the next cycle's sweep.
 */
describe('in_flight re-stamp: the DB behaviour touchInFlight relies on', () => {
  /** Byte-for-byte what PostgREST issues for the touchInFlight chain. */
  const TOUCH_SQL = `UPDATE public.webhook_deliveries
                        SET status = 'in_flight'
                      WHERE id = $1 AND status = 'in_flight'
                  RETURNING id`

  it('re-stamps updated_at on a no-op status write, pulling the row out of the sweep window', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    // Claimed 10 minutes ago: deep inside any sweep window.
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
      attempts: 1,
      updatedAt: longAgo(600),
    })

    const touched = await getPool().query<{ id: string }>(TOUCH_SQL, [deliveryId])
    expect(touched.rowCount).toBe(1)

    // Postgres runs the UPDATE even though no column value changed, so the
    // BEFORE UPDATE update_updated_at_column trigger (migration
    // 20260515200000) fires and re-stamps updated_at. Without that, writing
    // the status back verbatim would be an expensive no-op and the row's
    // in_flight age would still measure the claim, not the attempt.
    const { rows } = await getPool().query<{ updated_at: Date }>(
      `SELECT updated_at FROM public.webhook_deliveries WHERE id = $1`,
      [deliveryId],
    )
    expect(Date.now() - rows[0].updated_at.getTime()).toBeLessThan(60_000)

    // And that is the property the sweep reads: the row was swept-eligible a
    // moment ago and is not any more.
    const swept = await runAsServiceRole(async (client) => {
      const r = await client.query<{ id: string }>(
        `SELECT * FROM public.recover_stuck_webhook_deliveries($1, $2, $3::int[], now())`,
        [stuckBefore(), MAX_ATTEMPTS, BACKOFF],
      )
      return r.rows
    })
    expect(swept.map((r) => r.id)).not.toContain(deliveryId)
    expect(await readDelivery(deliveryId)).toMatchObject({ status: 'in_flight', attempts: 1 })
  })

  it('matches no row on a terminal delivery, so the immutability trigger never fires', async () => {
    const { companyId } = await seedCompany()
    const webhookId = await insertWebhook({ companyId })
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'delivered',
      attempts: 1,
      updatedAt: longAgo(600),
    })

    // The status filter is what keeps the touch off terminal rows. If it were
    // dropped, this would abort with a check_violation instead of returning
    // zero rows, and the dispatcher would read that as "row still ours".
    const touched = await getPool().query<{ id: string }>(TOUCH_SQL, [deliveryId])
    expect(touched.rowCount).toBe(0)
    expect(await readDelivery(deliveryId)).toMatchObject({ status: 'delivered', attempts: 1 })
  })
})
