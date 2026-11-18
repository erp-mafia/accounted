import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  insertPostedBankJournalEntry,
  insertPostedJournalEntry,
  insertTransaction,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261031220000_delete_last_voucher_reanchors_bank_row.
 *
 * The sequence in production: a bank row is booked (verifikat A1), un-booked
 * (storno A2, row released by the uncategorize route), and the user then
 * deletes A2 as the last voucher to undo the un-booking. A1 comes back as
 * posted; before this migration its row stayed released and asked to be
 * booked again, which books the money twice.
 *
 * Pinned:
 *  - the row follows A1 back (pointer, is_business = true, 'uncategorized'),
 *    and the audit snapshot names it;
 *  - a row the user ignored after un-booking is left alone;
 *  - a row booked again on another verifikat refuses the delete;
 *  - a storno of a non-bank verifikat deletes exactly as before.
 */

type Queryable = Pick<PoolClient, 'query'>

const BANK_OUT = [
  { accountNumber: '1930', debitAmount: 0, creditAmount: 100 },
  { accountNumber: '2999', debitAmount: 100, creditAmount: 0 },
]

interface RowState {
  journal_entry_id: string | null
  is_business: boolean | null
  category: string | null
  is_ignored: boolean
}

async function rowState(id: string, db: Queryable = getPool()): Promise<RowState> {
  const { rows } = await db.query<RowState>(
    `SELECT journal_entry_id, is_business, category, is_ignored FROM public.transactions WHERE id = $1`,
    [id],
  )
  return rows[0]
}

async function entryStatus(id: string, db: Queryable = getPool()): Promise<string | null> {
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

/** Booked from the bank row (A1), then un-booked (A2) the way the uncategorize route leaves it. */
async function bookedThenUnbooked(opts: { ignoreAfter?: boolean } = {}) {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const txId = await insertTransaction({ companyId, userId, amount: -100 })
  const originalId = await insertPostedBankJournalEntry({
    userId,
    companyId,
    fiscalPeriodId,
    transactionId: txId,
    voucherNumber: 1,
    lines: BANK_OUT,
  })
  await getPool().query(
    `UPDATE public.transactions SET journal_entry_id = $2, is_business = true, category = 'expense_office' WHERE id = $1`,
    [txId, originalId],
  )
  const stornoId = await stornoOf({ userId, companyId, fiscalPeriodId, originalId, voucherNumber: 2 })
  await getPool().query(
    `UPDATE public.transactions SET journal_entry_id = NULL, is_business = NULL, category = NULL, is_ignored = $2 WHERE id = $1`,
    [txId, opts.ignoreAfter ?? false],
  )
  return { userId, companyId, fiscalPeriodId, txId, originalId, stornoId }
}

function deleteLast(db: Queryable, companyId: string, entryId: string) {
  return db.query(`SELECT public.delete_last_voucher($1::uuid, $2::uuid)`, [companyId, entryId])
}

describe('delete_last_voucher on a storno of a bank verifikat', () => {
  it('brings the bank row back with its verifikat and names it in the audit snapshot', async () => {
    const { userId, companyId, txId, originalId, stornoId } = await bookedThenUnbooked()

    const result = await withUserContext(userId, async (c) => {
      await deleteLast(c, companyId, stornoId)
      const row = await rowState(txId, c)
      const original = await entryStatus(originalId, c)
      const storno = await entryStatus(stornoId, c)
      await c.query('RESET ROLE')
      const { rows } = await c.query<{ reanchored: string | null }>(
        `SELECT old_state -> 'register_effects' ->> 'reanchored_transaction_id' AS reanchored
           FROM public.audit_log
          WHERE record_id = $1 AND action = 'DELETE' AND table_name = 'journal_entries'
            AND old_state ? 'register_effects'`,
        [stornoId],
      )
      return { row, original, storno, reanchored: rows[0]?.reanchored ?? null }
    })

    expect(result.original).toBe('posted')
    expect(result.storno).toBeNull()
    expect(result.row).toMatchObject({
      journal_entry_id: originalId,
      is_business: true,
      category: 'uncategorized',
      is_ignored: false,
    })
    expect(result.reanchored).toBe(txId)
  })

  it('leaves a row the user ignored after un-booking as the user left it', async () => {
    const { userId, companyId, txId, originalId, stornoId } = await bookedThenUnbooked({ ignoreAfter: true })

    const result = await withUserContext(userId, async (c) => {
      await deleteLast(c, companyId, stornoId)
      return { row: await rowState(txId, c), original: await entryStatus(originalId, c) }
    })

    expect(result.original).toBe('posted')
    expect(result.row).toMatchObject({ journal_entry_id: null, is_ignored: true })
  })

  it('refuses when the row was booked again on another verifikat', async () => {
    const { userId, companyId, fiscalPeriodId, txId, originalId, stornoId } = await bookedThenUnbooked()
    // Booked again in another series, so the storno is still the last A voucher.
    const rebookId = await insertPostedBankJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      transactionId: txId,
      voucherSeries: 'B',
      voucherNumber: 1,
      lines: BANK_OUT,
    })
    await getPool().query(
      `UPDATE public.transactions SET journal_entry_id = $2, is_business = true, category = 'expense_office' WHERE id = $1`,
      [txId, rebookId],
    )

    await expect(withUserContext(userId, (c) => deleteLast(c, companyId, stornoId))).rejects.toThrow(/bokförd igen/)

    expect(await entryStatus(stornoId)).toBe('posted')
    expect(await entryStatus(originalId)).toBe('reversed')
    expect((await rowState(txId)).journal_entry_id).toBe(rebookId)
  })

  it('deletes a storno of a non-bank verifikat exactly as before', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const originalId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    const stornoId = await stornoOf({ userId, companyId, fiscalPeriodId, originalId, voucherNumber: 2 })

    const result = await withUserContext(userId, async (c) => {
      await deleteLast(c, companyId, stornoId)
      return { original: await entryStatus(originalId, c), storno: await entryStatus(stornoId, c) }
    })

    expect(result).toEqual({ original: 'posted', storno: null })
  })
})
