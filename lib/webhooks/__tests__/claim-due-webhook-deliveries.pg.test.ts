import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// ──────────────────────────────────────────────────────────────────────
// Fixtures: parent webhook + child delivery
// ──────────────────────────────────────────────────────────────────────

async function insertWebhook(params: {
  // userId kept in the signature for parity with seedCompany's return: the
  // webhooks table itself has no user_id column (see route comment in
  // app/api/v1/companies/[companyId]/webhooks/route.ts).
  userId: string
  companyId: string
  eventType?: string
  active?: boolean
}): Promise<string> {
  void params.userId
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhooks
       (id, company_id, name, event_type, webhook_url, secret, active)
     VALUES ($1, $2, 'pg-test', $3, 'https://example.com/hook', $4, $5)`,
    [
      id,
      params.companyId,
      params.eventType ?? 'invoice.paid',
      `whsec_${randomUUID().replace(/-/g, '')}`,
      params.active ?? true,
    ],
  )
  return id
}

async function insertDelivery(params: {
  webhookId: string | null
  companyId: string
  status?: 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dead'
  nextAttemptAt?: string
  eventType?: string
  attempts?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhook_deliveries
       (id, webhook_id, company_id, event_type, payload, api_version,
        status, next_attempt_at, attempts)
     VALUES ($1, $2, $3, $4, '{"hello":"world"}'::jsonb, '2026-05-12',
             $5, $6, $7)`,
    [
      id,
      params.webhookId,
      params.companyId,
      params.eventType ?? 'invoice.paid',
      params.status ?? 'pending',
      params.nextAttemptAt ?? new Date().toISOString(),
      params.attempts ?? 0,
    ],
  )
  return id
}

async function getDeliveryStatus(id: string): Promise<string | null> {
  const r = await getPool().query<{ status: string }>(
    `SELECT status FROM public.webhook_deliveries WHERE id = $1`,
    [id],
  )
  return r.rows[0]?.status ?? null
}

// Direct-insert rows for one test isolation. Each it() seeds its own
// company + webhook so the dispatcher sees a clean slate; we just need to
// make sure the function only returns rows we created, which we do by
// asserting on ids.

describe('claim_due_webhook_deliveries.pg: atomic SKIP LOCKED claim', () => {
  it('claims a pending row that is due', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'pending' })

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
      [10],
    )

    expect(rows.map((r) => r.id)).toContain(deliveryId)
    expect(await getDeliveryStatus(deliveryId)).toBe('in_flight')
  })

  it('claims a failed row that has reached its retry deadline', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    // next_attempt_at in the past: retry due.
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'failed',
      nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
      attempts: 2,
    })

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
      [10],
    )

    expect(rows.map((r) => r.id)).toContain(deliveryId)
    expect(await getDeliveryStatus(deliveryId)).toBe('in_flight')
  })

  it('skips a row whose next_attempt_at is still in the future', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'failed',
      nextAttemptAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    })

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
      [10],
    )

    expect(rows.map((r) => r.id)).not.toContain(deliveryId)
    // Status stays pre-claim.
    expect(await getDeliveryStatus(deliveryId)).toBe('failed')
  })

  it('skips dangling rows (webhook_id IS NULL)', async () => {
    const { companyId } = await seedCompany()
    // webhook deleted between enqueue and dispatch: FK ON DELETE SET NULL.
    const deliveryId = await insertDelivery({
      webhookId: null,
      companyId,
      status: 'pending',
    })

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
      [10],
    )

    expect(rows.map((r) => r.id)).not.toContain(deliveryId)
  })

  it('skips terminal-status rows', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveredId = await insertDelivery({
      webhookId,
      companyId,
      status: 'delivered',
    })
    const deadId = await insertDelivery({
      webhookId,
      companyId,
      status: 'dead',
    })

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
      [10],
    )

    const ids = rows.map((r) => r.id)
    expect(ids).not.toContain(deliveredId)
    expect(ids).not.toContain(deadId)
  })

  // The status filter `IN ('pending', 'failed')` is what prevents
  // double-delivery once a tick has already claimed a row to in_flight.
  // recoverStuckInFlight is the ONLY legitimate path back from in_flight
  // (sweeps the row to 'failed' after the stuck-threshold), so the claim
  // function must NEVER re-pick a row already marked in_flight.
  it('skips rows already in in_flight status', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const inFlightId = await insertDelivery({
      webhookId,
      companyId,
      status: 'in_flight',
    })

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
      [10],
    )

    expect(rows.map((r) => r.id)).not.toContain(inFlightId)
    // Status must NOT have been re-flipped.
    expect(await getDeliveryStatus(inFlightId)).toBe('in_flight')
  })

  it('respects the batch size', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })

    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        insertDelivery({ webhookId, companyId, status: 'pending' }),
      ),
    )

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
      [2],
    )

    expect(rows.length).toBe(2)
    // The 3 unclaimed rows stay pending.
    const unclaimed = ids.filter((id) => !rows.some((r) => r.id === id))
    for (const id of unclaimed) {
      expect(await getDeliveryStatus(id)).toBe('pending')
    }
  })

  it('rejects out-of-range batch sizes', async () => {
    await expect(
      getPool().query(`SELECT * FROM public.claim_due_webhook_deliveries($1, now())`, [0]),
    ).rejects.toThrow(/p_batch_size must be in/i)

    await expect(
      getPool().query(`SELECT * FROM public.claim_due_webhook_deliveries($1, now())`, [-1]),
    ).rejects.toThrow(/p_batch_size must be in/i)

    await expect(
      getPool().query(`SELECT * FROM public.claim_due_webhook_deliveries($1, now())`, [10000]),
    ).rejects.toThrow(/p_batch_size must be in/i)
  })

  // SKIP LOCKED is the entire point of this migration. Two transactions
  // calling the function at the same moment must not both see the same
  // row: the row locked by the first caller is invisible to the second,
  // closing the duplicate-delivery window the old SELECT-then-UPDATE-
  // intersect pattern documented as load-bearing.
  it('SKIP LOCKED: a concurrent caller does not see rows locked by an in-flight transaction', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({
      webhookId,
      companyId,
      status: 'pending',
    })

    const a = await getClient()
    const b = await getClient()
    try {
      await a.query('BEGIN')
      await b.query('BEGIN')

      // A claims first. The row is now status='in_flight' AND held under
      // a row lock by transaction A (UPDATE sets ROW EXCLUSIVE).
      const aClaim = await a.query<{ id: string }>(
        `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
        [10],
      )
      expect(aClaim.rows.map((r) => r.id)).toContain(deliveryId)

      // B's call SKIPs the locked row entirely. Without SKIP LOCKED this
      // call would BLOCK on the row lock; the test would hang and only
      // fail via testTimeout. SKIP LOCKED makes it return promptly with
      // the row simply absent from results.
      const bClaim = await b.query<{ id: string }>(
        `SELECT id FROM public.claim_due_webhook_deliveries($1, now())`,
        [10],
      )
      expect(bClaim.rows.map((r) => r.id)).not.toContain(deliveryId)

      // Commit A and roll back B (no-op since B claimed nothing).
      await a.query('COMMIT')
      await b.query('ROLLBACK')
    } finally {
      a.release()
      b.release()
    }

    // Final state: row is in_flight, claimed exactly once.
    expect(await getDeliveryStatus(deliveryId)).toBe('in_flight')
  })
})
