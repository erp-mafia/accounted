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

/**
 * Migrations 20260916190000_webshop_orders_release_draft_invoice_link and
 * 20260916200000_invoices_cancelled_releases_webshop_order (desk crm#56): an
 * order is released when its invoice stops being a document, in the same
 * statement. The FK is ON DELETE SET NULL (hard delete of an unnumbered
 * draft) and release_webshop_order_on_invoice_cancel clears the link when
 * the invoice becomes 'cancelled' (makulering). The freeze trigger allows
 * invoice_id -> null only once the invoice is gone or cancelled: a live
 * draft stays linked, a sent invoice stays linked, and any swap to a
 * different invoice is refused.
 */
async function insertInvoiceRow(params: {
  companyId: string
  userId: string
  status: 'draft' | 'sent' | 'cancelled'
  invoiceNumber?: string | null
}): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type)
     VALUES ($1, $2, $3, 'Webshop Cust', 'swedish_business')`,
    [customerId, params.userId, params.companyId],
  )
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, user_id, company_id, customer_id, invoice_date, due_date,
       currency, vat_treatment, vat_rate, subtotal, vat_amount, total, status, invoice_number)
     VALUES ($1, $2, $3, $4, '2026-09-16', '2026-10-16', 'SEK', 'standard_25', 25,
             400, 100, 500, $5, $6)`,
    [id, params.userId, params.companyId, customerId, params.status, params.invoiceNumber ?? null],
  )
  return id
}

async function linkedOrder(params: {
  companyId: string
  userId: string
  invoiceId: string
}): Promise<string> {
  const orderId = await insertOrderRow({ companyId: params.companyId, userId: params.userId })
  await getPool().query(`UPDATE public.webshop_orders SET invoice_id = $1 WHERE id = $2`, [
    params.invoiceId,
    orderId,
  ])
  return orderId
}

async function orderInvoiceId(orderId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ invoice_id: string | null }>(
    `SELECT invoice_id FROM public.webshop_orders WHERE id = $1`,
    [orderId],
  )
  return rows[0]!.invoice_id
}

describe('webshop_orders invoice link release (crm#56)', () => {
  it('webshop_orders_invoice_id_fkey is ON DELETE SET NULL', async () => {
    const { rows } = await getPool().query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
       WHERE conname = 'webshop_orders_invoice_id_fkey'
         AND conrelid = 'public.webshop_orders'::regclass`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.confdeltype).toBe('n')
  })

  it('hard-deleting an unnumbered draft releases the order (the customer path)', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoiceRow({ companyId, userId, status: 'draft' })
    const orderId = await linkedOrder({ companyId, userId, invoiceId })

    // The member session is what DELETE /api/invoices/[id] runs as. The
    // helper rolls back at the end, so the order is read inside the block.
    const after = await withUserContext(userId, async (client) => {
      const removed = await client.query(
        `DELETE FROM public.invoices WHERE id = $1 RETURNING id`,
        [invoiceId],
      )
      expect(removed.rowCount).toBe(1)
      const { rows } = await client.query<{ invoice_id: string | null }>(
        `SELECT invoice_id FROM public.webshop_orders WHERE id = $1`,
        [orderId],
      )
      return rows[0]!.invoice_id
    })
    expect(after).toBeNull()
  })

  it('makulering a numbered draft releases the order in the same statement', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoiceRow({
      companyId,
      userId,
      status: 'draft',
      invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
    })
    const orderId = await linkedOrder({ companyId, userId, invoiceId })

    // The member session is what DELETE /api/invoices/[id] runs as for a
    // numbered draft: one UPDATE, no second write.
    const after = await withUserContext(userId, async (client) => {
      const cancelled = await client.query(
        `UPDATE public.invoices SET status = 'cancelled' WHERE id = $1 AND status = 'draft'`,
        [invoiceId],
      )
      expect(cancelled.rowCount).toBe(1)
      const { rows } = await client.query<{ invoice_id: string | null }>(
        `SELECT invoice_id FROM public.webshop_orders WHERE id = $1`,
        [orderId],
      )
      return rows[0]!.invoice_id
    })
    expect(after).toBeNull()
  })

  it('keeps the link to a live draft: no manual unlink through the member session', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoiceRow({ companyId, userId, status: 'draft' })
    const orderId = await linkedOrder({ companyId, userId, invoiceId })

    // Own withUserContext block: the raise aborts the transaction, so the
    // failing statement must be the block's last.
    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.webshop_orders SET invoice_id = NULL WHERE id = $1`, [
          orderId,
        ]),
      ),
    ).rejects.toThrow(/still a document/)
    expect(await orderInvoiceId(orderId)).toBe(invoiceId)
  })

  it('keeps the link to a sent invoice immutable', async () => {
    const { userId, companyId } = await seedCompany()
    const invoiceId = await insertInvoiceRow({
      companyId,
      userId,
      status: 'sent',
      invoiceNumber: `F-${randomUUID().slice(0, 8)}`,
    })
    const orderId = await linkedOrder({ companyId, userId, invoiceId })

    await expect(
      getPool().query(`UPDATE public.webshop_orders SET invoice_id = NULL WHERE id = $1`, [
        orderId,
      ]),
    ).rejects.toThrow(/still a document/)
    expect(await orderInvoiceId(orderId)).toBe(invoiceId)
  })

  it('refuses swapping the link to another invoice even while both are drafts', async () => {
    const { userId, companyId } = await seedCompany()
    const first = await insertInvoiceRow({ companyId, userId, status: 'draft' })
    const second = await insertInvoiceRow({ companyId, userId, status: 'draft' })
    const orderId = await linkedOrder({ companyId, userId, invoiceId: first })

    await expect(
      getPool().query(`UPDATE public.webshop_orders SET invoice_id = $1 WHERE id = $2`, [
        second,
        orderId,
      ]),
    ).rejects.toThrow(/the link is immutable/)
    expect(await orderInvoiceId(orderId)).toBe(first)
  })
})
