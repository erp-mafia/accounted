import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The mail-hunt duplicate guard (migration 20260807103000).
 *
 * Receipts reach these mailboxes by being forwarded, and a single forward
 * routinely carries several of them: "Fwd: Kvitton februari" with five
 * attachments is five underlag, not one. The index that predated this
 * migration was unique on (company_id, mail_message_id), so filing the first
 * attachment silently and permanently blocked the other four.
 *
 * These tests pin the shape the hunt depends on: one row per attachment, the
 * same attachment refused twice, and the partial predicate keeping the index
 * out of the way of every other inbox source.
 */
async function insertHunted(companyId: string, userId: string, fileKey: string) {
  return getPool().query(
    `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, status, channel_context)
     VALUES ($1, $2, 'mail_hunt', 'received', jsonb_build_object('mail_file_key', $3::text))
     RETURNING id`,
    [companyId, userId, fileKey],
  )
}

describe('mail-hunt attachment dedupe (pg)', () => {
  it('accepts every attachment on one forwarded message', async () => {
    const { userId, companyId } = await seedCompany()
    const message = randomUUID()

    // Five receipts in one mail is the case that motivated the migration.
    for (const attachment of ['a', 'b', 'c', 'd', 'e']) {
      await insertHunted(companyId, userId, `${message}::${attachment}`)
    }

    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoice_inbox_items
       WHERE company_id = $1 AND source = 'mail_hunt'`,
      [companyId],
    )
    expect(rows[0].n).toBe(5)
  })

  it('refuses the same attachment twice, so a re-run is idempotent', async () => {
    const { userId, companyId } = await seedCompany()
    const fileKey = `${randomUUID()}::att-1`

    await insertHunted(companyId, userId, fileKey)
    await expect(insertHunted(companyId, userId, fileKey)).rejects.toThrow(
      /duplicate key|idx_invoice_inbox_mail_file_unique/i,
    )
  })

  it('lets two companies hold the same attachment independently', async () => {
    // Two bookkeepers can be forwarded the same supplier invoice.
    const first = await seedCompany()
    const second = await seedCompany()
    const fileKey = `${randomUUID()}::att-1`

    await insertHunted(first.companyId, first.userId, fileKey)
    await expect(insertHunted(second.companyId, second.userId, fileKey)).resolves.toBeTruthy()
  })

  it('leaves every other inbox source alone', async () => {
    // The index is partial on source = 'mail_hunt'. Uploads and WhatsApp
    // photos carry no file key and must not collide on a shared NULL.
    const { userId, companyId } = await seedCompany()

    for (let i = 0; i < 2; i++) {
      await getPool().query(
        `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, status)
         VALUES ($1, $2, 'email', 'received')`,
        [companyId, userId],
      )
    }

    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.invoice_inbox_items
       WHERE company_id = $1 AND source = 'email'`,
      [companyId],
    )
    expect(rows[0].n).toBe(2)
  })

  it('is the only unique index left on the hunted-mail key', async () => {
    // The message-scoped predecessor must be gone, or the five-attachment
    // case above would still fail in production.
    const { rows } = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'invoice_inbox_items'
         AND indexname IN ('idx_invoice_inbox_mail_file_unique',
                           'idx_invoice_inbox_mail_message_unique')`,
    )
    const names = rows.map((r) => r.indexname)
    expect(names).toContain('idx_invoice_inbox_mail_file_unique')
    expect(names).not.toContain('idx_invoice_inbox_mail_message_unique')
  })
})
