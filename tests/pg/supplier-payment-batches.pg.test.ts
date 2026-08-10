import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser } from './fixtures'

// pg-real coverage for 20260810160748_supplier_payment_batches.sql: RLS
// isolation on both tables, the FK RESTRICT that keeps invoices referenced by
// a payment instruction undeletable, the payee_fields_match CHECK, the
// per-batch invoice uniqueness, item immutability (no UPDATE/DELETE policies),
// and the updated_at trigger.

async function insertSupplier(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name, bankgiro)
     VALUES ($1, $2, $3, 'Derome Bygg AB', '5050-1055')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSupplierInvoice(
  companyId: string,
  userId: string,
  supplierId: string,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number,
        supplier_invoice_number, invoice_date, due_date,
        subtotal, vat_amount, total, remaining_amount, status)
     VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
             $5, '2026-06-23', '2026-07-07',
             590, 147.5, 737.5, 737.5, 'approved')`,
    [id, userId, companyId, supplierId, `CD-${id.slice(0, 8)}`],
  )
  return id
}

async function insertBatch(companyId: string, userId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_payment_batches
       (id, company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
     VALUES ($1, $2, $3, 'pain001', 737.5, 1, $4,
             '{"name":"Test AB","org_number":"556677-8899","iban":"SE3550000000054910000003","bic":"ESSESESS"}')`,
    [id, companyId, userId, `ACCOUNTED-5566778899-B${id.slice(0, 8)}`],
  )
  return id
}

async function insertItem(params: {
  batchId: string
  companyId: string
  supplierInvoiceId: string
  payeeType?: string
  payeeBankgiro?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_payment_batch_items
       (id, batch_id, company_id, supplier_invoice_id, amount, payment_date,
        payee_type, payee_bankgiro, payee_name, reference_type, reference)
     VALUES ($1, $2, $3, $4, 737.5, '2026-08-15',
             $5, $6, 'Derome Bygg AB', 'invoice_number', 'CD3014794407')`,
    [
      id,
      params.batchId,
      params.companyId,
      params.supplierInvoiceId,
      params.payeeType ?? 'bankgiro',
      params.payeeBankgiro === undefined ? '50501055' : params.payeeBankgiro,
    ],
  )
  return id
}

async function seedBatchWithItem() {
  const ctx = await seedCompany()
  const supplierId = await insertSupplier(ctx.companyId, ctx.userId)
  const invoiceId = await insertSupplierInvoice(ctx.companyId, ctx.userId, supplierId)
  const batchId = await insertBatch(ctx.companyId, ctx.userId)
  const itemId = await insertItem({
    batchId,
    companyId: ctx.companyId,
    supplierInvoiceId: invoiceId,
  })
  return { ...ctx, supplierId, invoiceId, batchId, itemId }
}

describe('supplier_payment_batches RLS', () => {
  it('isolates batches and items to company members', async () => {
    const ctx = await seedBatchWithItem()
    const stranger = await insertAuthUser()

    const ownerBatches = await withUserContext(ctx.userId, (client) =>
      client.query(`SELECT id FROM public.supplier_payment_batches WHERE id = $1`, [ctx.batchId]),
    )
    expect(ownerBatches.rows).toHaveLength(1)

    const strangerBatches = await withUserContext(stranger, (client) =>
      client.query(`SELECT id FROM public.supplier_payment_batches WHERE id = $1`, [ctx.batchId]),
    )
    expect(strangerBatches.rows).toHaveLength(0)

    const ownerItems = await withUserContext(ctx.userId, (client) =>
      client.query(`SELECT id FROM public.supplier_payment_batch_items WHERE id = $1`, [
        ctx.itemId,
      ]),
    )
    expect(ownerItems.rows).toHaveLength(1)

    const strangerItems = await withUserContext(stranger, (client) =>
      client.query(`SELECT id FROM public.supplier_payment_batch_items WHERE id = $1`, [
        ctx.itemId,
      ]),
    )
    expect(strangerItems.rows).toHaveLength(0)
  })

  it('blocks a stranger from inserting into another company', async () => {
    const ctx = await seedBatchWithItem()
    const stranger = await insertAuthUser()

    await expect(
      withUserContext(stranger, (client) =>
        client.query(
          `INSERT INTO public.supplier_payment_batches
             (company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
           VALUES ($1, $2, 'pain001', 1, 1, 'X', '{}')`,
          [ctx.companyId, stranger],
        ),
      ),
    ).rejects.toThrow(/row-level security/)
  })

  it('lets a member cancel (update) a batch but never update or delete items', async () => {
    const ctx = await seedBatchWithItem()

    const cancel = await withUserContext(ctx.userId, (client) =>
      client.query(
        `UPDATE public.supplier_payment_batches
            SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2
          WHERE id = $1 AND status = 'created'`,
        [ctx.batchId, ctx.userId],
      ),
    )
    expect(cancel.rowCount).toBe(1)

    // Items are immutable snapshots: no UPDATE/DELETE policies exist, so the
    // statements succeed but match zero rows.
    const update = await withUserContext(ctx.userId, (client) =>
      client.query(`UPDATE public.supplier_payment_batch_items SET amount = 1 WHERE id = $1`, [
        ctx.itemId,
      ]),
    )
    expect(update.rowCount).toBe(0)

    const del = await withUserContext(ctx.userId, (client) =>
      client.query(`DELETE FROM public.supplier_payment_batch_items WHERE id = $1`, [ctx.itemId]),
    )
    expect(del.rowCount).toBe(0)
  })
})

describe('supplier_payment_batches constraints', () => {
  it('FK RESTRICT keeps an invoice referenced by a batch item undeletable', async () => {
    const ctx = await seedBatchWithItem()

    await expect(
      getPool().query(`DELETE FROM public.supplier_invoices WHERE id = $1`, [ctx.invoiceId]),
    ).rejects.toThrow(/violates foreign key constraint/)

    // Removing the batch cascades the item away, after which the invoice can go.
    await getPool().query(`DELETE FROM public.supplier_payment_batches WHERE id = $1`, [
      ctx.batchId,
    ])
    await getPool().query(`DELETE FROM public.supplier_invoices WHERE id = $1`, [ctx.invoiceId])
  })

  it('payee_fields_match rejects a payee type without its fields', async () => {
    const ctx = await seedBatchWithItem()
    const otherInvoice = await insertSupplierInvoice(ctx.companyId, ctx.userId, ctx.supplierId)

    await expect(
      insertItem({
        batchId: ctx.batchId,
        companyId: ctx.companyId,
        supplierInvoiceId: otherInvoice,
        payeeType: 'bankgiro',
        payeeBankgiro: null,
      }),
    ).rejects.toThrow(/payee_fields_match/)

    await expect(
      insertItem({
        batchId: ctx.batchId,
        companyId: ctx.companyId,
        supplierInvoiceId: otherInvoice,
        payeeType: 'bank_account',
        payeeBankgiro: null,
      }),
    ).rejects.toThrow(/payee_fields_match/)
  })

  it('rejects the same invoice twice in one batch', async () => {
    const ctx = await seedBatchWithItem()

    await expect(
      insertItem({
        batchId: ctx.batchId,
        companyId: ctx.companyId,
        supplierInvoiceId: ctx.invoiceId,
      }),
    ).rejects.toThrow(/uq_supplier_payment_batch_invoice/)
  })

  it('rejects amounts and counts outside their CHECKs', async () => {
    const ctx = await seedCompany()

    await expect(
      getPool().query(
        `INSERT INTO public.supplier_payment_batches
           (company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
         VALUES ($1, $2, 'pain001', 0, 1, 'X', '{}')`,
        [ctx.companyId, ctx.userId],
      ),
    ).rejects.toThrow(/total_amount/)

    await expect(
      getPool().query(
        `INSERT INTO public.supplier_payment_batches
           (company_id, user_id, format, total_amount, item_count, msg_id, debtor_snapshot)
         VALUES ($1, $2, 'swish', 1, 1, 'X', '{}')`,
        [ctx.companyId, ctx.userId],
      ),
    ).rejects.toThrow(/format/)
  })

  it('touches updated_at on batch update', async () => {
    const ctx = await seedBatchWithItem()

    const before = await getPool().query(
      `SELECT updated_at FROM public.supplier_payment_batches WHERE id = $1`,
      [ctx.batchId],
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    await getPool().query(
      `UPDATE public.supplier_payment_batches SET download_count = download_count + 1 WHERE id = $1`,
      [ctx.batchId],
    )
    const after = await getPool().query(
      `SELECT updated_at FROM public.supplier_payment_batches WHERE id = $1`,
      [ctx.batchId],
    )
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before.rows[0].updated_at).getTime(),
    )
  })
})
