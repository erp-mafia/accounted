import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertPostedJournalEntry, seedCompany } from './fixtures'

/**
 * Several underlag may back one verifikat (migration 20260911120500).
 *
 * The UNIQUE on invoice_inbox_items.created_journal_entry_id from migration
 * 20260515090000 let only ONE inbox item point at a voucher, so the second
 * document linked to the same verifikat (invoice + payment confirmation, the
 * normal case) raised 23505 on the stamp and stayed "unprocessed" forever
 * (MCP feedback seq 389343, 395894, 395931, 366701). These tests pin that the
 * constraint is gone, that two rows in one company can carry the same voucher,
 * that the compare-and-set predicate the executors rely on still refuses a
 * second claim of an already-stamped row, and that a lookup index keyed on the
 * column survived the drop.
 */

async function insertInboxItem(companyId: string, userId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.invoice_inbox_items (company_id, user_id, source, status)
     VALUES ($1, $2, 'upload', 'received')
     RETURNING id`,
    [companyId, userId],
  )
  return rows[0].id
}

// The exact CAS shape the executor stamps use (commit.ts
// stampInboxItemForLinkedDocument and the create_voucher inbox_item_id stamp).
function claimItem(itemId: string, companyId: string, voucherId: string) {
  return getPool().query(
    `UPDATE public.invoice_inbox_items
        SET created_journal_entry_id = $1
      WHERE id = $2 AND company_id = $3
        AND created_journal_entry_id IS NULL
        AND created_supplier_invoice_id IS NULL`,
    [voucherId, itemId, companyId],
  )
}

describe('invoice_inbox_items shared voucher (pg)', () => {
  it('no longer carries the UNIQUE on created_journal_entry_id', async () => {
    const { rows } = await getPool().query(
      `SELECT 1 FROM pg_constraint
        WHERE conname = 'invoice_inbox_items_journal_entry_unique'
          AND conrelid = 'public.invoice_inbox_items'::regclass`,
    )
    expect(rows).toHaveLength(0)
  })

  it('lets two inbox items in the same company carry the same created_journal_entry_id', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const voucherId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })
    const invoiceItem = await insertInboxItem(companyId, userId)
    const paymentItem = await insertInboxItem(companyId, userId)

    expect((await claimItem(invoiceItem, companyId, voucherId)).rowCount).toBe(1)
    // Before the migration this UPDATE raised 23505 and the item stayed
    // "unprocessed" forever.
    expect((await claimItem(paymentItem, companyId, voucherId)).rowCount).toBe(1)

    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.invoice_inbox_items
        WHERE company_id = $1 AND created_journal_entry_id = $2`,
      [companyId, voucherId],
    )
    expect(rows.map((r) => r.id).sort()).toEqual([invoiceItem, paymentItem].sort())
  })

  it('still refuses a second claim of an already-stamped row through the CAS predicate', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const first = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const second = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })
    const item = await insertInboxItem(companyId, userId)

    expect((await claimItem(item, companyId, first)).rowCount).toBe(1)
    // The double-commit race the dropped constraint was added for (and never
    // caught: same row, different value): the predicate is the guard.
    expect((await claimItem(item, companyId, second)).rowCount).toBe(0)

    const { rows } = await getPool().query<{ created_journal_entry_id: string }>(
      `SELECT created_journal_entry_id FROM public.invoice_inbox_items WHERE id = $1`,
      [item],
    )
    expect(rows[0].created_journal_entry_id).toBe(first)
  })

  it('keeps a lookup index keyed on created_journal_entry_id alone', async () => {
    const { rows } = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'invoice_inbox_items'
          AND indexname = 'idx_inbox_items_journal_entry_id'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/\(created_journal_entry_id\)/)
  })
})
