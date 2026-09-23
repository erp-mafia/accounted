/**
 * pg-real tests for 20260904190000_supplier_credit_note_not_payable.sql.
 *
 * A supplier credit note is a reversal, never a payable: it must not sit in
 * the attest/payment lifecycle (registered, approved, overdue, paid,
 * partially_paid). Ordinary supplier invoices keep the whole lifecycle.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

async function seedSupplierInvoicePair(): Promise<{
  companyId: string
  originalId: string
  creditNoteId: string
  insertCreditNote: (status: string) => Promise<unknown>
}> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId })

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.suppliers (user_id, company_id, name)
     VALUES ($1, $2, 'Hi3G Access AB') RETURNING id`,
    [userId, companyId],
  )
  const supplierId = rows[0]!.id

  const originalId = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, status, subtotal, vat_amount, total, remaining_amount)
     VALUES ($1, $2, $3, $4, 4, '528285626420', '2026-08-03', '2026-08-17', 'credited',
             1048, 262, 1310, 0)`,
    [originalId, userId, companyId, supplierId],
  )

  let nextArrival = 5
  const insertCreditNote = (status: string) => {
    const id = randomUUID()
    const arrival = nextArrival++
    return getPool().query(
      `INSERT INTO public.supplier_invoices
         (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
          invoice_date, due_date, status, subtotal, vat_amount, total, remaining_amount,
          is_credit_note, credited_invoice_id)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-09-04', '2026-09-04', $7,
               1048, 262, 1310, 0, true, $8)`,
      [id, userId, companyId, supplierId, arrival, `KREDIT-528285626420-${arrival}`, status, originalId],
    ).then(() => id)
  }

  const creditNoteId = (await insertCreditNote('credited')) as string
  return { companyId, originalId, creditNoteId, insertCreditNote }
}

describe('supplier_invoices_credit_note_not_payable constraint', () => {
  it.each(['registered', 'approved', 'overdue', 'paid', 'partially_paid'])(
    'rejects moving a credit note to %s',
    async (status) => {
      const { creditNoteId } = await seedSupplierInvoicePair()
      await expect(
        getPool().query(`UPDATE public.supplier_invoices SET status = $1 WHERE id = $2`, [
          status,
          creditNoteId,
        ]),
      ).rejects.toMatchObject({ code: '23514' })
    },
  )

  it('rejects inserting a credit note at the attest entry state', async () => {
    // The state every creation path used before 20260904190000.
    const { insertCreditNote } = await seedSupplierInvoicePair()
    await expect(insertCreditNote('registered')).rejects.toMatchObject({ code: '23514' })
  })

  it('lets a credit note rest at credited and be soft-deleted to reversed', async () => {
    const { creditNoteId } = await seedSupplierInvoicePair()
    await expect(
      getPool().query(`UPDATE public.supplier_invoices SET status = 'reversed' WHERE id = $1`, [
        creditNoteId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('leaves ordinary supplier invoices on the payable lifecycle', async () => {
    const { originalId } = await seedSupplierInvoicePair()
    for (const status of ['registered', 'approved', 'overdue', 'partially_paid', 'paid']) {
      await expect(
        getPool().query(`UPDATE public.supplier_invoices SET status = $1 WHERE id = $2`, [
          status,
          originalId,
        ]),
      ).resolves.toMatchObject({ rowCount: 1 })
    }
  })
})
