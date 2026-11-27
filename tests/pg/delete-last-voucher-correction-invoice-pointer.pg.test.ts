import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { insertPostedJournalEntry } from '@/tests/pg/fixtures'
import {
  insertCustomerInvoice,
  insertSupplierInvoice,
  seedCashCompany,
  type CashCompany,
} from '@/tests/pg/kontantmetod-carry-fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261126233000_delete_last_voucher_returns_invoice_pointer.
 *
 * correctEntry leaves a corrected registration verifikat like this: the
 * original A1 reversed by the storno A2, the correction A3 posted with
 * correction_of_id = A1, and the pointer of the invoice the verifikat books
 * (invoices.journal_entry_id, supplier_invoices.registration_journal_entry_id)
 * moved to A3. The undo deletes A3 as the last voucher and then A2, which
 * posts A1 again. Before this migration the pointer went NULL with A3
 * (ON DELETE SET NULL), so A1 came back with no invoice naming it.
 *
 * Pinned:
 *  - deleting the correction returns both pointers to the original;
 *  - deleting the storno after it posts the original again, and both
 *    pointers still name it;
 *  - a correction with no invoice behind it deletes as before, and a pointer
 *    that never left the original stays on it.
 *
 * One verifikat stands in for both registrations: the function moves the two
 * pointers independently, and its lines play no part.
 */

type Queryable = Pick<PoolClient, 'query'>

async function entryStatus(id: string, db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM public.journal_entries WHERE id = $1`, [id])
  return rows[0]?.status ?? null
}

async function invoicePointer(id: string, db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ journal_entry_id: string | null }>(
    `SELECT journal_entry_id FROM public.invoices WHERE id = $1`,
    [id],
  )
  return rows[0]?.journal_entry_id ?? null
}

async function supplierInvoicePointer(id: string, db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ registration_journal_entry_id: string | null }>(
    `SELECT registration_journal_entry_id FROM public.supplier_invoices WHERE id = $1`,
    [id],
  )
  return rows[0]?.registration_journal_entry_id ?? null
}

/** Storno of a posted entry as the engine leaves it: swapped lines, posted, original reversed. */
async function stornoOf(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  originalId: string
  voucherNumber: number
}): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, reverses_id, status, bank_booking_context)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-06-01', 'Storno', 'storno', $6, 'draft', '[]'::jsonb)`,
      [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber, params.originalId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       SELECT $1, account_number, credit_amount, debit_amount, currency, sort_order
         FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [id, params.originalId],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query(
      `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
      [params.originalId, id],
    )
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** The corrected verifikat correctEntry posts: source_type 'correction', correction_of_id, its own lines. */
async function correctionOf(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  originalId: string
  voucherNumber: number
}): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, correction_of_id, status, bank_booking_context)
       VALUES ($1, $2, $3, $4, $5, 'A', '2026-06-01', 'Correction', 'correction', $6, 'draft', '[]'::jsonb)`,
      [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber, params.originalId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order)
       VALUES ($1, '1930', 900, 0, 'SEK', 0), ($1, '3001', 0, 900, 'SEK', 1)`,
      [id],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

interface CorrectedChain {
  company: CashCompany
  originalId: string
  stornoId: string
  correctionId: string
}

/** A1 reversed by storno A2, correction A3 of A1 posted: A3 is the last voucher in the series. */
async function correctedVerifikat(): Promise<CorrectedChain> {
  const company = await seedCashCompany('accrual')
  const { userId, companyId, fiscalPeriodId } = company
  const originalId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
  const stornoId = await stornoOf({ userId, companyId, fiscalPeriodId, originalId, voucherNumber: 2 })
  const correctionId = await correctionOf({ userId, companyId, fiscalPeriodId, originalId, voucherNumber: 3 })
  return { company, originalId, stornoId, correctionId }
}

/** A customer invoice and a supplier invoice whose verifikat pointers name `entryId`. */
async function invoicesPointingAt(company: CashCompany, entryId: string) {
  const invoiceId = await insertCustomerInvoice(company)
  const supplierInvoiceId = await insertSupplierInvoice(company)
  await getPool().query(`UPDATE public.invoices SET journal_entry_id = $1 WHERE id = $2`, [entryId, invoiceId])
  await getPool().query(
    `UPDATE public.supplier_invoices SET registration_journal_entry_id = $1 WHERE id = $2`,
    [entryId, supplierInvoiceId],
  )
  return { invoiceId, supplierInvoiceId }
}

function deleteLast(db: Queryable, companyId: string, entryId: string) {
  return db.query<{ result: { deleted: boolean } }>(
    `SELECT public.delete_last_voucher($1::uuid, $2::uuid) AS result`,
    [companyId, entryId],
  )
}

describe('delete_last_voucher on a correction of a verifikat that books an invoice', () => {
  it('returns the customer and the supplier invoice pointer to the original', async () => {
    const { company, originalId, stornoId, correctionId } = await correctedVerifikat()
    const { invoiceId, supplierInvoiceId } = await invoicesPointingAt(company, correctionId)

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, correctionId)
      await c.query('RESET ROLE')
      return {
        invoice: await invoicePointer(invoiceId, c),
        supplierInvoice: await supplierInvoicePointer(supplierInvoiceId, c),
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        correction: await entryStatus(correctionId, c),
      }
    })

    expect(result).toEqual({
      invoice: originalId,
      supplierInvoice: originalId,
      original: 'reversed',
      storno: 'posted',
      correction: null,
    })
  })

  it('still names the original once the storno is deleted too and the original is posted again', async () => {
    const { company, originalId, stornoId, correctionId } = await correctedVerifikat()
    const { invoiceId, supplierInvoiceId } = await invoicesPointingAt(company, correctionId)

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, correctionId)
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      return {
        invoice: await invoicePointer(invoiceId, c),
        supplierInvoice: await supplierInvoicePointer(supplierInvoiceId, c),
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        correction: await entryStatus(correctionId, c),
      }
    })

    expect(result).toEqual({
      invoice: originalId,
      supplierInvoice: originalId,
      original: 'posted',
      storno: null,
      correction: null,
    })
  })

  it('deletes a correction with no invoice behind it as before, and leaves a pointer on the original alone', async () => {
    const { company, originalId, stornoId, correctionId } = await correctedVerifikat()
    // The pointers never left the original: nothing names the correction.
    const { invoiceId, supplierInvoiceId } = await invoicesPointingAt(company, originalId)

    const result = await withUserContext(company.userId, async (c) => {
      const deleted = await deleteLast(c, company.companyId, correctionId)
      await c.query('RESET ROLE')
      return {
        deleted: deleted.rows[0]?.result.deleted ?? null,
        invoice: await invoicePointer(invoiceId, c),
        supplierInvoice: await supplierInvoicePointer(supplierInvoiceId, c),
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        correction: await entryStatus(correctionId, c),
      }
    })

    expect(result).toEqual({
      deleted: true,
      invoice: originalId,
      supplierInvoice: originalId,
      original: 'reversed',
      storno: 'posted',
      correction: null,
    })
  })
})
