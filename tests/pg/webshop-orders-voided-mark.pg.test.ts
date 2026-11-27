import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertDraftJournalEntry } from './fixtures'

/**
 * Covers 20261127101523_webshop_orders_voided_mark: an order the store
 * cancelled is voided (makulerad) through the manual mark, with
 * manually_voided saying the mark books nothing. A member voids and undoes
 * it through the member UPDATE policy, the row freezes like any marked row,
 * the sync can still write its status, and the check refuses a void without
 * its mark or with a verifikat. Unit tests mock Supabase and never meet the
 * check.
 */

async function insertCancelledOrder(companyId: string, userId: string): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO public.webshop_orders
       (company_id, user_id, platform, store_scope, row_type, external_id,
        platform_order_id, order_number, status, is_paid, order_date, paid_date,
        currency, total, total_tax, total_sek, exchange_rate, vat_breakdown,
        payment_method)
     VALUES ($1, $2, 'woocommerce', 'butik.example.se', 'order', $3,
             '1001', '1001', 'cancelled', true, '2026-11-20', '2026-11-20',
             'SEK', 500.00, 100.00, 500.00, 1, '[{"rate":25,"net":400,"tax":100}]'::jsonb,
             'kco')
     RETURNING id`,
    [companyId, userId, `woo_void-${randomUUID()}.example.se_order_1001`],
  )
  return rows[0].id as string
}

describe('webshop_orders voided mark', () => {
  it('a new row is not voided', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertCancelledOrder(companyId, userId)
    const { rows } = await getPool().query(
      `SELECT manually_voided FROM public.webshop_orders WHERE id = $1`,
      [rowId],
    )
    expect(rows).toEqual([{ manually_voided: false }])
  })

  it('a member voids a cancelled order and undoes it through the member UPDATE policy', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertCancelledOrder(companyId, userId)

    // withUserContext rolls back at the end: both writes run in its one
    // transaction, as the member.
    await withUserContext(userId, async (client) => {
      // What POST mark-booked with voided: true writes.
      const voided = await client.query(
        `UPDATE public.webshop_orders
           SET manually_booked_at = now(), manually_booked_by = $2,
               manually_booked_journal_entry_id = NULL, manually_voided = true
         WHERE id = $1`,
        [rowId, userId],
      )
      expect(voided.rowCount).toBe(1)
      const marked = await client.query(
        `SELECT manually_voided, manually_booked_by FROM public.webshop_orders WHERE id = $1`,
        [rowId],
      )
      expect(marked.rows).toEqual([{ manually_voided: true, manually_booked_by: userId }])

      // What DELETE mark-booked writes: the void is undone, the row stays.
      const undone = await client.query(
        `UPDATE public.webshop_orders
           SET manually_booked_at = NULL, manually_booked_by = NULL,
               manually_booked_journal_entry_id = NULL, manually_voided = false
         WHERE id = $1`,
        [rowId],
      )
      expect(undone.rowCount).toBe(1)
      const cleared = await client.query(
        `SELECT manually_booked_at, manually_voided FROM public.webshop_orders WHERE id = $1`,
        [rowId],
      )
      expect(cleared.rows).toEqual([{ manually_booked_at: null, manually_voided: false }])
    })
  })

  it('a voided row freezes like a marked one but still takes the store status; undoing thaws it', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertCancelledOrder(companyId, userId)
    await getPool().query(
      `UPDATE public.webshop_orders
         SET manually_booked_at = now(), manually_booked_by = $2, manually_voided = true
       WHERE id = $1`,
      [rowId, userId],
    )

    // No money field moves under the mark.
    await expect(
      getPool().query(`UPDATE public.webshop_orders SET total = 600.00 WHERE id = $1`, [rowId]),
    ).rejects.toThrow(/financial fields are frozen/i)
    // The store's status still lands (the sync writes it on frozen rows).
    const status = await getPool().query(
      `UPDATE public.webshop_orders SET status = 'processing' WHERE id = $1`,
      [rowId],
    )
    expect(status.rowCount).toBe(1)

    await getPool().query(
      `UPDATE public.webshop_orders
         SET manually_booked_at = NULL, manually_booked_by = NULL, manually_voided = false
       WHERE id = $1`,
      [rowId],
    )
    const thawed = await getPool().query(
      `UPDATE public.webshop_orders SET total = 600.00, total_sek = 600.00 WHERE id = $1`,
      [rowId],
    )
    expect(thawed.rowCount).toBe(1)
  })

  it('refuses a void without the mark it belongs to', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertCancelledOrder(companyId, userId)
    await expect(
      getPool().query(`UPDATE public.webshop_orders SET manually_voided = true WHERE id = $1`, [rowId]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a void that links a verifikat, and the unmark that forgets the void', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const rowId = await insertCancelledOrder(companyId, userId)
    const entryId = await insertDraftJournalEntry({ companyId, userId, fiscalPeriodId })
    await expect(
      getPool().query(
        `UPDATE public.webshop_orders
           SET manually_booked_at = now(), manually_voided = true,
               manually_booked_journal_entry_id = $2
         WHERE id = $1`,
        [rowId, entryId],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    await getPool().query(
      `UPDATE public.webshop_orders SET manually_booked_at = now(), manually_voided = true WHERE id = $1`,
      [rowId],
    )
    await expect(
      getPool().query(`UPDATE public.webshop_orders SET manually_booked_at = NULL WHERE id = $1`, [rowId]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
