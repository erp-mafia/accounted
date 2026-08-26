import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { randomUUID } from 'crypto'
import { seedCompany, insertDraftJournalEntry } from './fixtures'

/**
 * Covers migrations 20260811073315_webshop_orders,
 * 20260811073333_webshop_store_settings and
 * 20260811073416_journal_source_type_webshop_order:
 *   1. RLS: members read/update their company's rows, cannot INSERT
 *      (sync is service-role only) and cannot DELETE; outsiders see nothing.
 *   2. (company_id, external_id) unique index.
 *   3. Financial freeze trigger: booked rows reject money-field updates but
 *      accept status/refund-summary updates.
 *   4. journal_entries.source_type accepts 'webshop_order'.
 *   5. webshop_store_settings RLS + upsert key.
 */

// Rows persist across pg-real runs; unique external ids per run.
const uniqueExternalId = (label: string) =>
  `woo_test-${label}-${randomUUID()}.example.se_order_1001`

async function insertOrderRow(params: {
  companyId: string
  userId: string
  externalId?: string
  journalEntryId?: string | null
}): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO public.webshop_orders
       (company_id, user_id, platform, store_scope, row_type, external_id,
        platform_order_id, order_number, status, is_paid, order_date, paid_date,
        currency, total, total_tax, total_sek, exchange_rate, vat_breakdown,
        payment_method, journal_entry_id)
     VALUES ($1, $2, 'woocommerce', 'butik.example.se', 'order', $3,
             '1001', '1001', 'processing', true, '2026-08-01', '2026-08-01',
             'SEK', 500.00, 100.00, 500.00, 1, '[{"rate":25,"net":400,"tax":100}]'::jsonb,
             'swish', $4)
     RETURNING id`,
    [
      params.companyId,
      params.userId,
      params.externalId ?? uniqueExternalId('order'),
      params.journalEntryId ?? null,
    ],
  )
  return rows[0].id as string
}

describe('webshop_orders RLS', () => {
  it('a member reads and updates own-company rows but cannot delete', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertOrderRow({ companyId, userId })

    await withUserContext(userId, async (client) => {
      const read = await client.query(
        `SELECT status, payment_method FROM public.webshop_orders WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toEqual([{ status: 'processing', payment_method: 'swish' }])

      // Member UPDATE works (the booking route writes back journal_entry_id).
      const updated = await client.query(
        `UPDATE public.webshop_orders SET status = 'completed' WHERE id = $1`,
        [rowId],
      )
      expect(updated.rowCount).toBe(1)

      // No DELETE policy: order rows are accounting underlag.
      const del = await client.query(
        `DELETE FROM public.webshop_orders WHERE id = $1`,
        [rowId],
      )
      expect(del.rowCount).toBe(0)
    })
  })

  it('a member cannot INSERT (the sync path is service-role only)', async () => {
    // Own withUserContext block: an RLS rejection aborts the transaction, so
    // the failing statement must be the block's last.
    const { userId, companyId } = await seedCompany()
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.webshop_orders
             (company_id, user_id, platform, store_scope, external_id,
              platform_order_id, order_number, status, order_date, currency, total)
           VALUES ($1, $2, 'woocommerce', 'butik.example.se', $3,
                   '9', '9', 'pending', '2026-08-01', 'SEK', 100.00)`,
          [companyId, userId, uniqueExternalId('member-insert')],
        ),
      ).rejects.toThrow(/row-level security/i)
    })
  })

  it('a non-member sees nothing and cannot update foreign rows', async () => {
    const { userId: ownerId, companyId } = await seedCompany()
    const rowId = await insertOrderRow({ companyId, userId: ownerId })
    const { userId: outsiderId } = await seedCompany()

    await withUserContext(outsiderId, async (client) => {
      const read = await client.query(
        `SELECT id FROM public.webshop_orders WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toHaveLength(0)

      const update = await client.query(
        `UPDATE public.webshop_orders SET status = 'hacked' WHERE id = $1`,
        [rowId],
      )
      expect(update.rowCount).toBe(0)
    })
  })

  it('(company_id, external_id) is unique per company but not across companies', async () => {
    const { userId: userA, companyId: companyA } = await seedCompany()
    const { userId: userB, companyId: companyB } = await seedCompany()
    const externalId = uniqueExternalId('dedup')

    await insertOrderRow({ companyId: companyA, userId: userA, externalId })
    await expect(
      insertOrderRow({ companyId: companyA, userId: userA, externalId }),
    ).rejects.toMatchObject({ code: '23505' })

    // Another company may carry the same external id (scope is per company).
    const other = await insertOrderRow({ companyId: companyB, userId: userB, externalId })
    expect(other).toBeTruthy()
  })
})

describe('webshop_orders financial freeze', () => {
  it('rejects money-field updates once booked, allows status updates', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'webshop_order',
    })
    const rowId = await insertOrderRow({ companyId, userId, journalEntryId: entryId })

    await expect(
      getPool().query(
        `UPDATE public.webshop_orders SET total = 600.00 WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow(/financial fields are frozen/i)

    await expect(
      getPool().query(
        `UPDATE public.webshop_orders SET paid_date = '2026-08-02' WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow(/financial fields are frozen/i)

    // Non-financial fields keep syncing on frozen rows.
    const ok = await getPool().query(
      `UPDATE public.webshop_orders
         SET status = 'refunded', refunded_total = 500.00,
             remote_changed_after_freeze = true
       WHERE id = $1`,
      [rowId],
    )
    expect(ok.rowCount).toBe(1)
  })

  it('leaves unbooked rows fully mutable', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertOrderRow({ companyId, userId })
    const ok = await getPool().query(
      `UPDATE public.webshop_orders SET total = 750.00, total_sek = 750.00 WHERE id = $1`,
      [rowId],
    )
    expect(ok.rowCount).toBe(1)
  })

  it('allows unlinking while the entry is still a draft (booking rollback path)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const draftId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'webshop_order',
    })
    const rowId = await insertOrderRow({ companyId, userId, journalEntryId: draftId })
    const ok = await getPool().query(
      `UPDATE public.webshop_orders SET journal_entry_id = NULL WHERE id = $1`,
      [rowId],
    )
    expect(ok.rowCount).toBe(1)
  })

  it('freezes financial fields while manually marked as booked; unmark restores mutability (#1879, freeze v3)', async () => {
    const { userId, companyId } = await seedCompany()
    const rowId = await insertOrderRow({ companyId, userId })

    // Mark as booked outside the integration (what the mark-booked route does).
    const marked = await getPool().query(
      `UPDATE public.webshop_orders
         SET manually_booked_at = now(), manually_booked_by = $2
       WHERE id = $1`,
      [rowId, userId],
    )
    expect(marked.rowCount).toBe(1)

    // Financial fields are frozen at the DB level while marked.
    await expect(
      getPool().query(
        `UPDATE public.webshop_orders SET total = 600.00 WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow(/financial fields are frozen/i)
    await expect(
      getPool().query(
        `UPDATE public.webshop_orders SET line_items = '[{"name":"x"}]'::jsonb WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow(/financial fields are frozen/i)

    // Safe sync fields still pass (drift flagging keeps working).
    const safe = await getPool().query(
      `UPDATE public.webshop_orders
         SET status = 'completed', remote_changed_after_freeze = true
       WHERE id = $1`,
      [rowId],
    )
    expect(safe.rowCount).toBe(1)

    // Unmark (the DELETE route) is the escape hatch...
    const unmark = await getPool().query(
      `UPDATE public.webshop_orders
         SET manually_booked_at = NULL, manually_booked_by = NULL,
             manually_booked_journal_entry_id = NULL
       WHERE id = $1`,
      [rowId],
    )
    expect(unmark.rowCount).toBe(1)

    // ...after which the row is fully mutable again.
    const thawed = await getPool().query(
      `UPDATE public.webshop_orders SET total = 600.00, total_sek = 600.00 WHERE id = $1`,
      [rowId],
    )
    expect(thawed.rowCount).toBe(1)
  })

  it('rejects clearing the journal link once the entry is posted', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const postedId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'webshop_order',
      status: 'posted',
      voucherNumber: 4711,
    })
    const rowId = await insertOrderRow({ companyId, userId, journalEntryId: postedId })
    await expect(
      getPool().query(
        `UPDATE public.webshop_orders SET journal_entry_id = NULL WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow(/journal link is immutable/i)
  })
})

describe('journal_entries source_type webshop_order', () => {
  it('accepts webshop_order (CHECK constraint expanded)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      sourceType: 'webshop_order',
    })
    const { rows } = await getPool().query(
      `SELECT source_type FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(rows).toEqual([{ source_type: 'webshop_order' }])
  })
})

describe('webshop_store_settings', () => {
  it('members insert/read/update their mapping; outsiders see nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const storeScope = `butik-${randomUUID()}.example.se`

    // withUserContext ROLLS BACK, so the duplicate-key assertion below needs
    // a persistent seed row inserted via the pool.
    await getPool().query(
      `INSERT INTO public.webshop_store_settings
         (company_id, user_id, platform, store_scope, payment_method_account_map)
       VALUES ($1, $2, 'woocommerce', $3, '{"swish":{"mode":"book","account":"1930"}}'::jsonb)`,
      [companyId, userId, storeScope],
    )

    await withUserContext(userId, async (client) => {
      const memberScope = `butik-member-${randomUUID()}.example.se`
      const inserted = await client.query(
        `INSERT INTO public.webshop_store_settings
           (company_id, user_id, platform, store_scope, payment_method_account_map)
         VALUES ($1, $2, 'woocommerce', $3, '{"swish":{"mode":"book","account":"1930"}}'::jsonb)
         RETURNING id`,
        [companyId, userId, memberScope],
      )
      expect(inserted.rows).toHaveLength(1)

      const updated = await client.query(
        `UPDATE public.webshop_store_settings
           SET payment_method_account_map = '{"swish":{"mode":"book","account":"1580"}}'::jsonb
         WHERE company_id = $1 AND store_scope = $2`,
        [companyId, storeScope],
      )
      expect(updated.rowCount).toBe(1)
    })

    // Duplicate (company, platform, store_scope) rejected: upsert key.
    await expect(
      getPool().query(
        `INSERT INTO public.webshop_store_settings
           (company_id, user_id, platform, store_scope)
         VALUES ($1, $2, 'woocommerce', $3)`,
        [companyId, userId, storeScope],
      ),
    ).rejects.toMatchObject({ code: '23505' })

    const { userId: outsiderId } = await seedCompany()
    await withUserContext(outsiderId, async (client) => {
      const read = await client.query(
        `SELECT id FROM public.webshop_store_settings WHERE company_id = $1`,
        [companyId],
      )
      expect(read.rows).toHaveLength(0)
    })
  })
})
