import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getClient, getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

/**
 * Migration 20260903190000 (#2181): the InboundMailReceived catalog row, and
 * the per-attachment idempotency index on invoice_inbox_items becoming
 * company-scoped so one mail addressed to two inboxes files once per inbox.
 * tests/pg/processing-event-types.pg.test.ts already proves every emitted
 * type is registered; this file pins the two behaviours the webhook now
 * relies on.
 */
describe('InboundMailReceived event type (#2181)', () => {
  it('is registered in the catalog', async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM public.processing_event_types WHERE event_type = 'InboundMailReceived'`,
    )
    expect(rows).toHaveLength(1)
  })

  it('still refuses an unregistered event type through the FK', async () => {
    const { companyId } = await seedCompany()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await expect(
        client.query(
          `INSERT INTO public.processing_history
             (company_id, correlation_id, aggregate_type, aggregate_id, event_type,
              payload, actor, occurred_at)
           VALUES ($1, $2, 'System', $2, 'InboundMailReceivedTypo', '{}'::jsonb,
                   '{"type":"system","id":"inbound-mail-received-test"}', now())`,
          [companyId, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '23503' })
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

describe('invoice_inbox_items idempotency per company (#2181)', () => {
  async function insertItem(
    client: Awaited<ReturnType<typeof getClient>>,
    companyId: string,
    userId: string,
    emailId: string,
    attachmentId: string | null,
  ) {
    return client.query(
      `INSERT INTO public.invoice_inbox_items
         (company_id, user_id, status, source, resend_email_id, resend_attachment_id)
       VALUES ($1, $2, 'received', 'email', $3, $4)
       RETURNING id`,
      [companyId, userId, emailId, attachmentId],
    )
  }

  it('lets two companies file the same mail attachment, and refuses a repeat for one company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const emailId = randomUUID()
    const attachmentId = randomUUID()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await insertItem(client, a.companyId, a.userId, emailId, attachmentId)
      // Before the migration this insert hit the (email, attachment) unique
      // index and the second inbox's copy was lost.
      await insertItem(client, b.companyId, b.userId, emailId, attachmentId)

      // A Resend retry for the same company still dedupes at the index.
      await client.query('SAVEPOINT repeat')
      await expect(
        insertItem(client, a.companyId, a.userId, emailId, attachmentId),
      ).rejects.toMatchObject({ code: '23505' })
      await client.query('ROLLBACK TO SAVEPOINT repeat')

      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.invoice_inbox_items
          WHERE resend_email_id = $1 AND resend_attachment_id = $2`,
        [emailId, attachmentId],
      )
      expect(rows[0].n).toBe('2')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('keeps the old single-company index gone', async () => {
    const { rows } = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'invoice_inbox_items'
          AND indexname IN (
            'idx_invoice_inbox_items_resend_email_attachment',
            'idx_invoice_inbox_items_company_resend_email_attachment'
          )`,
    )
    expect(rows.map((r) => r.indexname)).toEqual([
      'idx_invoice_inbox_items_company_resend_email_attachment',
    ])
  })
})
