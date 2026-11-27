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
 * Covers 20261126233000_delete_last_voucher_returns_correction_pointers.
 *
 * correctEntry leaves a corrected verifikat like this: the original A1
 * reversed by the storno A2, the correction A3 posted with
 * correction_of_id = A1, and the pointer of each record the verifikat books
 * moved to A3: the invoice (invoices.journal_entry_id,
 * supplier_invoices.registration_journal_entry_id), the inbox item it was
 * booked from (invoice_inbox_items.created_journal_entry_id) and the utlagg
 * (expense_claims.journal_entry_id). The undo deletes A3 as the last voucher
 * and then A2, which posts A1 again. Before this migration the invoice and
 * inbox item pointers went NULL with A3 (ON DELETE SET NULL) and the utlagg
 * was removed with it, so A1 came back with no record naming it.
 *
 * Pinned, for each of the four records on a company of its own:
 *  - deleting the correction returns the pointer to the original, and the
 *    record is still there;
 *  - deleting the storno after it posts the original again, and the pointer
 *    still names it.
 * And once: a correction with no record behind it deletes as before, and
 * pointers that never left the original stay on it.
 *
 * The verifikat is a plain one: the function reads the pointers, never the
 * lines or the source of the verifikat they name.
 */

type Queryable = Pick<PoolClient, 'query'>

async function entryStatus(id: string, db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ status: string }>(`SELECT status FROM public.journal_entries WHERE id = $1`, [id])
  return rows[0]?.status ?? null
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

/** A record that names the verifikat that books it, and where it keeps that pointer. */
interface BookedRecord {
  name: string
  table: string
  column: string
  /** Insert one whose pointer names `entryId`; answers its id. */
  seed: (company: CashCompany, entryId: string) => Promise<string>
}

const BOOKED_RECORDS: BookedRecord[] = [
  {
    name: 'a customer invoice',
    table: 'invoices',
    column: 'journal_entry_id',
    seed: async (company, entryId) => {
      const id = await insertCustomerInvoice(company)
      await getPool().query(`UPDATE public.invoices SET journal_entry_id = $1 WHERE id = $2`, [entryId, id])
      return id
    },
  },
  {
    name: 'a supplier invoice',
    table: 'supplier_invoices',
    column: 'registration_journal_entry_id',
    seed: async (company, entryId) => {
      const id = await insertSupplierInvoice(company)
      await getPool().query(
        `UPDATE public.supplier_invoices SET registration_journal_entry_id = $1 WHERE id = $2`,
        [entryId, id],
      )
      return id
    },
  },
  {
    name: 'an inbox item',
    table: 'invoice_inbox_items',
    column: 'created_journal_entry_id',
    seed: async (company, entryId) => {
      const { rows } = await getPool().query<{ id: string }>(
        `INSERT INTO public.invoice_inbox_items
           (company_id, user_id, source, status, document_id, created_journal_entry_id, created_supplier_invoice_id)
         VALUES ($1, $2, 'upload', 'received', NULL, $3, NULL)
         RETURNING id`,
        [company.companyId, company.userId, entryId],
      )
      const row = rows[0]
      if (!row) throw new Error('the inbox item insert returned no row')
      return row.id
    },
  },
  {
    name: 'an utlagg',
    table: 'expense_claims',
    column: 'journal_entry_id',
    seed: async (company, entryId) => {
      const id = randomUUID()
      await getPool().query(
        `INSERT INTO public.expense_claims
           (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account)
         VALUES ($1, $2, $3, 'Owner', 'Receipt', CURRENT_DATE - 10, 40, 0, '5410')`,
        [id, company.companyId, company.userId],
      )
      await getPool().query(`UPDATE public.expense_claims SET journal_entry_id = $1 WHERE id = $2`, [entryId, id])
      return id
    },
  },
]

/** The record's verifikat pointer, or 'record deleted' when the row is gone. */
async function pointerOf(record: BookedRecord, id: string, db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ pointer: string | null }>(
    `SELECT ${record.column} AS pointer FROM public.${record.table} WHERE id = $1`,
    [id],
  )
  const row = rows[0]
  return row ? row.pointer : 'record deleted'
}

function deleteLast(db: Queryable, companyId: string, entryId: string) {
  return db.query<{ result: { deleted: boolean } }>(
    `SELECT public.delete_last_voucher($1::uuid, $2::uuid) AS result`,
    [companyId, entryId],
  )
}

describe.each(BOOKED_RECORDS)('delete_last_voucher on a correction of the verifikat that books $name', (record) => {
  it('returns the pointer to the original and keeps the record', async () => {
    const { company, originalId, stornoId, correctionId } = await correctedVerifikat()
    const recordId = await record.seed(company, correctionId)

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, correctionId)
      await c.query('RESET ROLE')
      return {
        pointer: await pointerOf(record, recordId, c),
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        correction: await entryStatus(correctionId, c),
      }
    })

    expect(result).toEqual({ pointer: originalId, original: 'reversed', storno: 'posted', correction: null })
  })

  it('still names the original once the storno is deleted too and the original is posted again', async () => {
    const { company, originalId, stornoId, correctionId } = await correctedVerifikat()
    const recordId = await record.seed(company, correctionId)

    const result = await withUserContext(company.userId, async (c) => {
      await deleteLast(c, company.companyId, correctionId)
      await deleteLast(c, company.companyId, stornoId)
      await c.query('RESET ROLE')
      return {
        pointer: await pointerOf(record, recordId, c),
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        correction: await entryStatus(correctionId, c),
      }
    })

    expect(result).toEqual({ pointer: originalId, original: 'posted', storno: null, correction: null })
  })
})

describe('delete_last_voucher on a correction with no record behind it', () => {
  it('deletes as before and leaves pointers that never left the original alone', async () => {
    const { company, originalId, stornoId, correctionId } = await correctedVerifikat()
    // Nothing names the correction: every pointer is still on the original.
    const seeded: Array<{ record: BookedRecord; id: string }> = []
    for (const record of BOOKED_RECORDS) seeded.push({ record, id: await record.seed(company, originalId) })

    const result = await withUserContext(company.userId, async (c) => {
      const deleted = await deleteLast(c, company.companyId, correctionId)
      await c.query('RESET ROLE')
      const pointers: Array<string | null> = []
      for (const { record, id } of seeded) pointers.push(await pointerOf(record, id, c))
      return {
        deleted: deleted.rows[0]?.result.deleted ?? null,
        pointers,
        original: await entryStatus(originalId, c),
        storno: await entryStatus(stornoId, c),
        correction: await entryStatus(correctionId, c),
      }
    })

    expect(result).toEqual({
      deleted: true,
      pointers: [originalId, originalId, originalId, originalId],
      original: 'reversed',
      storno: 'posted',
      correction: null,
    })
  })
})
