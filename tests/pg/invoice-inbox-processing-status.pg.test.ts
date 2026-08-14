import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * The staged-upload status CHECK (migration 20260813213000).
 *
 * The web upload route inserts the inbox row before AI extraction runs and
 * flips it to 'received' from a deferred worker (or the sweep cron after a
 * crash). That requires 'processing' back in the CHECK that migration
 * 20260504180000 tightened to received | error. These tests pin the widened
 * enum, that the constraint still rejects everything else, and that the
 * default stayed 'received'.
 */
describe('invoice_inbox_items staged-upload status (pg)', () => {
  it("accepts the re-admitted 'processing' status", async () => {
    const { userId, companyId } = await seedCompany()

    const { rows } = await getPool().query<{ id: string; status: string }>(
      `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, status)
       VALUES ($1, $2, 'upload', 'processing')
       RETURNING id, status`,
      [companyId, userId],
    )
    expect(rows[0].status).toBe('processing')
  })

  it('still refuses statuses outside the enum', async () => {
    const { userId, companyId } = await seedCompany()

    // 'ready' was one of the pre-20260504180000 AI states: it must stay out.
    await expect(
      getPool().query(
        `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, status)
         VALUES ($1, $2, 'upload', 'ready')`,
        [companyId, userId],
      ),
    ).rejects.toThrow(/invoice_inbox_items_status_check|violates check constraint/i)
  })

  it("defaults status to 'received' when the writer says nothing", async () => {
    const { userId, companyId } = await seedCompany()

    const { rows } = await getPool().query<{ status: string }>(
      `INSERT INTO public.invoice_inbox_items (company_id, user_id, source)
       VALUES ($1, $2, 'upload')
       RETURNING status`,
      [companyId, userId],
    )
    expect(rows[0].status).toBe('received')
  })
})
