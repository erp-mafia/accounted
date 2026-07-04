import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

// Verifies the three webhook-substrate DB guards shipped in Phase 6 PR-1:
//   - enforce_webhook_delivery_immutability (BEFORE UPDATE)
//   - block_webhook_delivery_terminal_delete (BEFORE DELETE)
//   - assert_webhook_delivery_company_match (BEFORE INSERT)
//
// CLAUDE.md ("Migration Rules" + Testing section) mandates a *.pg.test.ts
// for any PR that touches a trigger / RPC / RLS / DEFERRABLE constraint.
// PR-1 (#496) shipped the triggers without the accompanying pg test; this
// closes that test debt.

async function insertWebhook(params: {
  // userId kept in the signature for parity with seedCompany's return: the
  // webhooks table itself has no user_id column (see route comment in
  // app/api/v1/companies/[companyId]/webhooks/route.ts).
  userId: string
  companyId: string
  eventType?: string
}): Promise<string> {
  void params.userId
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhooks
       (id, company_id, name, event_type, webhook_url, secret, active)
     VALUES ($1, $2, 'pg-test', $3, 'https://example.com/hook', $4, true)`,
    [
      id,
      params.companyId,
      params.eventType ?? 'invoice.paid',
      `whsec_${randomUUID().replace(/-/g, '')}`,
    ],
  )
  return id
}

async function insertDelivery(params: {
  webhookId: string | null
  companyId: string
  status?: 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dead'
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.webhook_deliveries
       (id, webhook_id, company_id, event_type, payload, api_version,
        status, next_attempt_at)
     VALUES ($1, $2, $3, 'invoice.paid', '{"hello":"world"}'::jsonb,
             '2026-05-12', $4, now())`,
    [id, params.webhookId, params.companyId, params.status ?? 'pending'],
  )
  return id
}

describe('webhook_deliveries triggers: immutability + DELETE block', () => {
  // The lifecycle that dispatcher.ts depends on must remain mutable:
  // pending → in_flight (claim), in_flight → failed (retry-pending),
  // failed → in_flight (re-claim). Only `delivered` and `dead` are
  // terminal and locked.
  it('allows pending → in_flight (claim) transition', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'pending' })

    const result = await getPool().query(
      `UPDATE public.webhook_deliveries SET status = 'in_flight' WHERE id = $1`,
      [deliveryId],
    )
    expect(result.rowCount).toBe(1)
  })

  it('allows in_flight → failed (retry-pending) transition', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'in_flight' })

    const result = await getPool().query(
      `UPDATE public.webhook_deliveries SET status = 'failed', attempts = 1 WHERE id = $1`,
      [deliveryId],
    )
    expect(result.rowCount).toBe(1)
  })

  it('allows failed → in_flight (re-claim) transition', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'failed' })

    const result = await getPool().query(
      `UPDATE public.webhook_deliveries SET status = 'in_flight' WHERE id = $1`,
      [deliveryId],
    )
    expect(result.rowCount).toBe(1)
  })

  it('allows in_flight → delivered (success terminal) transition', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'in_flight' })

    const result = await getPool().query(
      `UPDATE public.webhook_deliveries
          SET status = 'delivered', delivered_at = now(), response_status = 200
        WHERE id = $1`,
      [deliveryId],
    )
    expect(result.rowCount).toBe(1)
  })

  it('rejects UPDATE on a delivered row (status flip-back blocked)', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'delivered' })

    await expect(
      getPool().query(
        `UPDATE public.webhook_deliveries SET status = 'pending' WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/terminal status \(delivered\) is immutable/i)
  })

  it('rejects UPDATE on a dead row (response rewrite blocked)', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'dead' })

    await expect(
      getPool().query(
        `UPDATE public.webhook_deliveries
            SET response_body = 'tampered' WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/terminal status \(dead\) is immutable/i)
  })

  it('rejects DELETE on a delivered row', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'delivered' })

    await expect(
      getPool().query(
        `DELETE FROM public.webhook_deliveries WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/terminal status \(delivered\) cannot be deleted/i)
  })

  it('rejects DELETE on a dead row', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'dead' })

    await expect(
      getPool().query(
        `DELETE FROM public.webhook_deliveries WHERE id = $1`,
        [deliveryId],
      ),
    ).rejects.toThrow(/terminal status \(dead\) cannot be deleted/i)
  })

  // Non-terminal rows are still deletable: the queue-cleanup path
  // (operator clears a stuck pending row, dev environment wipes,
  // companies CASCADE delete) keeps working.
  it('allows DELETE on a pending row', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })
    const deliveryId = await insertDelivery({ webhookId, companyId, status: 'pending' })

    const result = await getPool().query(
      `DELETE FROM public.webhook_deliveries WHERE id = $1`,
      [deliveryId],
    )
    expect(result.rowCount).toBe(1)
  })
})

describe('webhook_deliveries triggers: cross-tenant INSERT guard', () => {
  it('rejects INSERT when delivery.company_id != webhooks.company_id', async () => {
    // Tenant A owns the webhook; tenant B owns the company on the
    // delivery row. A compromised service-role caller (or future bug)
    // attempting to enqueue a delivery against another tenant's webhook
    // is refused at write time: closes cases (a) (cross-tenant
    // visibility) and (c) (existence leak) flagged in migration
    // 20260515190000's comment.
    const a = await seedCompany()
    const b = await seedCompany()
    const webhookId = await insertWebhook({ userId: a.userId, companyId: a.companyId })

    await expect(
      getPool().query(
        `INSERT INTO public.webhook_deliveries
           (id, webhook_id, company_id, event_type, payload, api_version,
            status, next_attempt_at)
         VALUES (gen_random_uuid(), $1, $2, 'invoice.paid',
                 '{"hello":"world"}'::jsonb, '2026-05-12', 'pending', now())`,
        [webhookId, b.companyId],
      ),
    ).rejects.toThrow(/company_id .+ does not match parent webhooks\.company_id/i)
  })

  it('accepts INSERT when delivery.company_id == webhooks.company_id', async () => {
    const { userId, companyId } = await seedCompany()
    const webhookId = await insertWebhook({ userId, companyId })

    const result = await getPool().query(
      `INSERT INTO public.webhook_deliveries
         (id, webhook_id, company_id, event_type, payload, api_version,
          status, next_attempt_at)
       VALUES (gen_random_uuid(), $1, $2, 'invoice.paid',
               '{"hello":"world"}'::jsonb, '2026-05-12', 'pending', now())
       RETURNING id`,
      [webhookId, companyId],
    )
    expect(result.rowCount).toBe(1)
  })

  it('allows INSERT with webhook_id IS NULL (dangling row after webhook delete)', async () => {
    // ON DELETE SET NULL on the FK leaves these rows after a webhook is
    // deleted. New inserts with webhook_id IS NULL aren't a normal write
    // path (the handler never inserts a null webhook_id) but the trigger
    // explicitly bypasses the check rather than blocking: leaving room
    // for an admin-side audit-replay tool that recreates an archived
    // delivery for forensic export.
    const { companyId } = await seedCompany()

    const result = await getPool().query(
      `INSERT INTO public.webhook_deliveries
         (id, webhook_id, company_id, event_type, payload, api_version,
          status, next_attempt_at)
       VALUES (gen_random_uuid(), NULL, $1, 'invoice.paid',
               '{"hello":"world"}'::jsonb, '2026-05-12', 'pending', now())
       RETURNING id`,
      [companyId],
    )
    expect(result.rowCount).toBe(1)
  })

  it('rejects INSERT pointing at a non-existent webhook_id', async () => {
    // Bypass-check path: the trigger early-returns when the parent
    // lookup yields NULL so the FK constraint surfaces the bad
    // reference rather than the more-confusing company_match error.
    // This test pins the FK-error pathway.
    const { companyId } = await seedCompany()
    const ghostWebhookId = randomUUID()

    await expect(
      getPool().query(
        `INSERT INTO public.webhook_deliveries
           (id, webhook_id, company_id, event_type, payload, api_version,
            status, next_attempt_at)
         VALUES (gen_random_uuid(), $1, $2, 'invoice.paid',
                 '{"hello":"world"}'::jsonb, '2026-05-12', 'pending', now())`,
        [ghostWebhookId, companyId],
      ),
    ).rejects.toThrow(/webhook_deliveries_webhook_id_fkey|foreign key/i)
  })
})
