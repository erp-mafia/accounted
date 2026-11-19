import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for 20261027051617_supplier_auto_debit.sql (crm#1463):
// suppliers.auto_debit and supplier_invoices.auto_debit default to false, and
// the inherit_supplier_auto_debit trigger gives a new invoice its supplier's
// flag on insert (also under a user's session, where RLS reads the supplier),
// keeps an explicit true, never reaches across companies, and leaves an
// invoice's own later change alone.

async function insertSupplier(companyId: string, userId: string, autoDebit: boolean | null): Promise<string> {
  const id = randomUUID()
  if (autoDebit === null) {
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Banken AB')`,
      [id, userId, companyId],
    )
  } else {
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name, auto_debit) VALUES ($1, $2, $3, 'Banken AB', $4)`,
      [id, userId, companyId, autoDebit],
    )
  }
  return id
}

const INSERT_INVOICE = `INSERT INTO public.supplier_invoices
     (id, user_id, company_id, supplier_id, arrival_number,
      supplier_invoice_number, invoice_date, due_date,
      subtotal, vat_amount, total, remaining_amount, status)
   VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int,
           $5, '2026-10-20', '2026-10-27',
           181.1, 0, 181.1, 181.1, 'approved')
   RETURNING auto_debit`

async function insertInvoice(companyId: string, userId: string, supplierId: string): Promise<{ id: string; autoDebit: boolean }> {
  const id = randomUUID()
  const { rows } = await getPool().query<{ auto_debit: boolean }>(INSERT_INVOICE, [id, userId, companyId, supplierId, `AG-${id.slice(0, 8)}`])
  return { id, autoDebit: rows[0]!.auto_debit }
}

describe('auto_debit on suppliers and supplier invoices (crm#1463)', () => {
  it('defaults to false on both', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(companyId, userId, null)
    const { rows } = await getPool().query<{ auto_debit: boolean }>(`SELECT auto_debit FROM public.suppliers WHERE id = $1`, [supplierId])
    expect(rows[0]!.auto_debit).toBe(false)
    expect((await insertInvoice(companyId, userId, supplierId)).autoDebit).toBe(false)
  })

  it('gives a new invoice its supplier\'s auto_debit', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(companyId, userId, true)
    expect((await insertInvoice(companyId, userId, supplierId)).autoDebit).toBe(true)
  })

  it('inherits under a user\'s session too, where RLS reads the supplier', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(companyId, userId, true)
    const id = randomUUID()
    const inherited = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ auto_debit: boolean }>(INSERT_INVOICE, [id, userId, companyId, supplierId, `AG-${id.slice(0, 8)}`])
      return rows[0]!.auto_debit
    })
    expect(inherited).toBe(true)
  })

  it('keeps an explicit true on a supplier without the flag, and an invoice\'s own later change', async () => {
    const { userId, companyId } = await seedCompany()
    const supplierId = await insertSupplier(companyId, userId, false)
    const id = randomUUID()
    const { rows } = await getPool().query<{ auto_debit: boolean }>(
      `INSERT INTO public.supplier_invoices
         (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date,
          subtotal, vat_amount, total, remaining_amount, status, auto_debit)
       VALUES ($1, $2, $3, $4, floor(random() * 1000000)::int, $5, '2026-10-20', '2026-10-27',
               181.1, 0, 181.1, 181.1, 'approved', true)
       RETURNING auto_debit`,
      [id, userId, companyId, supplierId, `AG-${id.slice(0, 8)}`],
    )
    expect(rows[0]!.auto_debit).toBe(true)

    // Insert-only: switching one invoice back is never overridden.
    const flagged = await insertSupplier(companyId, userId, true)
    const invoice = await insertInvoice(companyId, userId, flagged)
    const { rows: after } = await getPool().query<{ auto_debit: boolean }>(
      `UPDATE public.supplier_invoices SET auto_debit = false WHERE id = $1 RETURNING auto_debit`,
      [invoice.id],
    )
    expect(after[0]!.auto_debit).toBe(false)
  })

  it('never reads a supplier of another company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const foreignSupplier = await insertSupplier(b.companyId, b.userId, true)
    // The trigger matches supplier and company together; a foreign id finds nothing.
    const id = randomUUID()
    const result = await getPool()
      .query<{ auto_debit: boolean }>(INSERT_INVOICE, [id, a.userId, a.companyId, foreignSupplier, `AG-${id.slice(0, 8)}`])
      .then((r) => r.rows[0]!.auto_debit)
      .catch(() => 'refused' as const)
    // Either the FK refuses the cross-company supplier or the flag is not taken over.
    expect([false, 'refused']).toContain(result)
  })
})
