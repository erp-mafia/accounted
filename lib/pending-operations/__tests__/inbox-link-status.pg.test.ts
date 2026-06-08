import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Regression guard for the inbox-linking step of the two "from inbox" commit
 * handlers in lib/pending-operations/commit.ts:
 *
 *   - commitCreateVoucher                (book-direct kvitto → verifikat)
 *   - commitCreateSupplierInvoiceFromInbox (inbox → leverantörsfaktura)
 *
 * Both resolve the source inbox row on approval by stamping a terminal link
 * column (created_journal_entry_id / created_supplier_invoice_id). An earlier
 * version of both handlers ALSO wrote `status: 'confirmed'` in that same
 * UPDATE. But migration 20260504180000 tightened the status enum to
 * `CHECK (status IN ('received','error'))` — 'confirmed' is no longer legal.
 *
 * Because the link column and the illegal status were set in ONE atomic
 * UPDATE, Postgres rejected the whole statement. The handler swallowed the
 * error with a non-fatal log.warn, so the verifikat / supplier invoice was
 * created but the inbox item silently stayed in "needs action" (its link
 * column never landed) and the OCR document was never attached. That was the
 * reported bug.
 *
 * The unit suites (voucher-executors.test.ts, create-supplier-invoice-from-
 * inbox.test.ts) mock @/lib/supabase/server, so the CHECK constraint is never
 * exercised — the buggy UPDATE "succeeds" against the mock. Only a real
 * Postgres catches it. This test locks the DB-level contract the fix depends
 * on: resolving an inbox row writes ONLY the link column, never `status`.
 */

// status='received', source='upload' — a fresh, unresolved inbox row, exactly
// what an uploaded item looks like before it's booked.
async function insertInboxItem(params: {
  userId: string
  companyId: string
  documentId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_inbox_items
       (id, user_id, company_id, status, source, document_id)
     VALUES ($1, $2, $3, 'received', 'upload', $4)`,
    [id, params.userId, params.companyId, params.documentId ?? null],
  )
  return id
}

// Minimal supplier + supplier_invoice so created_supplier_invoice_id has a
// valid FK target. arrival_number is UNIQUE per user; one per fresh tenant.
async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Test Leverantör AB')`,
    [supplierId, params.userId, params.companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date)
     VALUES ($1, $2, $3, $4, 1, 'INV-1', '2026-05-01', '2026-05-31')`,
    [invoiceId, params.userId, params.companyId, supplierId],
  )
  return invoiceId
}

async function readInbox(
  inboxId: string,
): Promise<{ status: string; created_journal_entry_id: string | null; created_supplier_invoice_id: string | null }> {
  const res = await getPool().query<{
    status: string
    created_journal_entry_id: string | null
    created_supplier_invoice_id: string | null
  }>(
    `SELECT status, created_journal_entry_id, created_supplier_invoice_id
       FROM public.invoice_inbox_items WHERE id = $1`,
    [inboxId],
  )
  return res.rows[0]!
}

describe('invoice_inbox_items status CHECK — root cause', () => {
  it("rejects status='confirmed' (the value the old handlers wrote)", async () => {
    const { userId, companyId } = await seedCompany()
    const inboxId = await insertInboxItem({ userId, companyId })

    await expect(
      getPool().query(
        `UPDATE public.invoice_inbox_items SET status = 'confirmed' WHERE id = $1`,
        [inboxId],
      ),
    ).rejects.toThrow(/invoice_inbox_items_status_check|violates check constraint/)
  })

  it("accepts the two legal status values, received and error", async () => {
    const { userId, companyId } = await seedCompany()
    const inboxId = await insertInboxItem({ userId, companyId })

    await getPool().query(
      `UPDATE public.invoice_inbox_items SET status = 'error' WHERE id = $1`,
      [inboxId],
    )
    await getPool().query(
      `UPDATE public.invoice_inbox_items SET status = 'received' WHERE id = $1`,
      [inboxId],
    )
    expect((await readInbox(inboxId)).status).toBe('received')
  })
})

describe('commitCreateVoucher inbox link (book-direct kvitto)', () => {
  // Mirrors the WHERE clause at lib/pending-operations/commit.ts (the race
  // guard: only the first commit on a still-unresolved row wins).
  const WHERE = `WHERE id = $2 AND company_id = $3
                   AND created_journal_entry_id IS NULL
                   AND created_supplier_invoice_id IS NULL
                 RETURNING id`

  it("OLD buggy form (link + status='confirmed') is rejected ATOMICALLY — link never lands", async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const inboxId = await insertInboxItem({ userId, companyId })
    const jeId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    await expect(
      getPool().query(
        `UPDATE public.invoice_inbox_items
            SET created_journal_entry_id = $1, status = 'confirmed' ${WHERE}`,
        [jeId, inboxId, companyId],
      ),
    ).rejects.toThrow(/invoice_inbox_items_status_check|violates check constraint/)

    // The atomic rejection is the bug: the verifikat is posted, but the inbox
    // row is untouched and stays in "needs action".
    const row = await readInbox(inboxId)
    expect(row.created_journal_entry_id).toBeNull()
    expect(row.status).toBe('received')
  })

  it('FIXED form (link only) lands created_journal_entry_id and leaves status=received', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const inboxId = await insertInboxItem({ userId, companyId })
    const jeId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    const res = await getPool().query(
      `UPDATE public.invoice_inbox_items
          SET created_journal_entry_id = $1 ${WHERE}`,
      [jeId, inboxId, companyId],
    )
    expect(res.rows).toHaveLength(1) // one row claimed

    const row = await readInbox(inboxId)
    expect(row.created_journal_entry_id).toBe(jeId)
    // status untouched — the link column alone drops the row out of the
    // "needs action" filter (the UI and list_unmatched_documents read it).
    expect(row.status).toBe('received')
  })

  it('race guard: a second commit on an already-linked row updates 0 rows (no clobber)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const inboxId = await insertInboxItem({ userId, companyId })
    const je1 = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    const je2 = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    const first = await getPool().query(
      `UPDATE public.invoice_inbox_items SET created_journal_entry_id = $1 ${WHERE}`,
      [je1, inboxId, companyId],
    )
    expect(first.rows).toHaveLength(1)

    // Loser: the `created_journal_entry_id IS NULL` predicate no longer holds.
    const second = await getPool().query(
      `UPDATE public.invoice_inbox_items SET created_journal_entry_id = $1 ${WHERE}`,
      [je2, inboxId, companyId],
    )
    expect(second.rows).toHaveLength(0)
    expect((await readInbox(inboxId)).created_journal_entry_id).toBe(je1)
  })

  it('UNIQUE(created_journal_entry_id) blocks two inbox rows pointing at the same verifikat', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const inboxA = await insertInboxItem({ userId, companyId })
    const inboxB = await insertInboxItem({ userId, companyId })
    const jeId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    await getPool().query(
      `UPDATE public.invoice_inbox_items SET created_journal_entry_id = $1 WHERE id = $2`,
      [jeId, inboxA],
    )
    await expect(
      getPool().query(
        `UPDATE public.invoice_inbox_items SET created_journal_entry_id = $1 WHERE id = $2`,
        [jeId, inboxB],
      ),
    ).rejects.toThrow(/unique|invoice_inbox_items_created_je/i)
  })
})

describe('commitCreateSupplierInvoiceFromInbox inbox link', () => {
  // Mirrors the WHERE clause at lib/pending-operations/commit.ts:1726 —
  // id + company_id only; idempotency is handled by an early-return check
  // upstream, so this UPDATE carries no null guards.
  const WHERE = `WHERE id = $2 AND company_id = $3 RETURNING id`

  it("OLD buggy form (link + status='confirmed') is rejected ATOMICALLY — link never lands", async () => {
    const { userId, companyId } = await seedCompany()
    const inboxId = await insertInboxItem({ userId, companyId })
    const supplierInvoiceId = await insertSupplierInvoice({ userId, companyId })

    await expect(
      getPool().query(
        `UPDATE public.invoice_inbox_items
            SET created_supplier_invoice_id = $1, status = 'confirmed' ${WHERE}`,
        [supplierInvoiceId, inboxId, companyId],
      ),
    ).rejects.toThrow(/invoice_inbox_items_status_check|violates check constraint/)

    const row = await readInbox(inboxId)
    expect(row.created_supplier_invoice_id).toBeNull()
    expect(row.status).toBe('received')
  })

  it('FIXED form (link only) lands created_supplier_invoice_id and leaves status=received', async () => {
    const { userId, companyId } = await seedCompany()
    const inboxId = await insertInboxItem({ userId, companyId })
    const supplierInvoiceId = await insertSupplierInvoice({ userId, companyId })

    const res = await getPool().query(
      `UPDATE public.invoice_inbox_items
          SET created_supplier_invoice_id = $1 ${WHERE}`,
      [supplierInvoiceId, inboxId, companyId],
    )
    expect(res.rows).toHaveLength(1)

    const row = await readInbox(inboxId)
    expect(row.created_supplier_invoice_id).toBe(supplierInvoiceId)
    expect(row.status).toBe('received')
  })
})
