import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'
import { CORRECTION_COLUMN_POLICY } from '../correction-column-policy'

/**
 * Class guard for crm#1078. correctEntry dropped the note of every corrected
 * verifikat because the rättelse header listed the columns to copy and
 * `notes` was never listed. CORRECTION_COLUMN_POLICY now names every
 * journal_entries column and what the rättelse does with it; this file holds
 * that table against the real schema, which the JournalEntry type lags (the
 * table has columns the type never got).
 *
 * A migration that adds a column to journal_entries fails here until someone
 * decides whether a correction carries it.
 */
describe('CORRECTION_COLUMN_POLICY against the real journal_entries table (pg-real)', () => {
  it('classifies every column of the table, and nothing that is not a column', async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'journal_entries'`,
    )
    const tableColumns = rows.map((r) => r.column_name).sort()
    const classified = Object.keys(CORRECTION_COLUMN_POLICY).sort()

    const unclassified = tableColumns.filter((column) => !classified.includes(column))
    const stale = classified.filter((column) => !tableColumns.includes(column))

    expect(
      unclassified,
      'journal_entries has a column that CORRECTION_COLUMN_POLICY (correction-column-policy.ts) does not list: ' +
        'decide whether the rättelse carries it from the corrected verifikat, then add it there',
    ).toEqual([])
    expect(
      stale,
      'CORRECTION_COLUMN_POLICY lists a column that journal_entries no longer has: remove it',
    ).toEqual([])
  })

  // The unit tests prove the header carries what the table says. This proves
  // the database takes it: a carried column guarded by a trigger (import
  // identity, bank booking context) would be refused here, not in production.
  it('accepts a rättelse that carries the carried columns, and leaves the original and the storno alone', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const pool = getPool()
    const carried = Object.entries(CORRECTION_COLUMN_POLICY)
      .filter(([, policy]) => policy === 'carried')
      .map(([column]) => column)
    expect(carried).toContain('notes')
    const carriedList = carried.map((column) => `"${column}"`).join(', ')

    async function insertLines(entryId: string, debitAcc: string, creditAcc: string, amount: number) {
      await pool.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
        [entryId, debitAcc, amount, creditAcc],
      )
    }
    async function commit(entryId: string) {
      await pool.query(`SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`, [
        companyId,
        entryId,
      ])
    }

    // Original, with a note, posted.
    const originalId = randomUUID()
    await pool.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, notes)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-15', 'Lunch', 'manual', 'draft', $5)`,
      [originalId, userId, companyId, fiscalPeriodId, 'Deltagare: två kunder. Syfte: genomgång av avtalet.'],
    )
    await insertLines(originalId, '5410', '1930', 1000)
    await commit(originalId)

    // Storno: the columns correctEntry writes, nothing carried.
    const stornoId = randomUUID()
    await pool.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-15', 'Storno: Lunch', 'storno', 'draft', $5)`,
      [stornoId, userId, companyId, fiscalPeriodId, originalId],
    )
    await insertLines(stornoId, '1930', '5410', 1000)
    await commit(stornoId)

    // Rättelse: the written columns plus the carried ones, copied as they are.
    const correctionId = randomUUID()
    await pool.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, correction_of_id, ${carriedList})
       SELECT $1, $2, $3, $4, 0, 'A', '2026-06-15', 'Rättelse: Lunch', 'correction', 'draft', o.id, ${carried
         .map((column) => `o."${column}"`)
         .join(', ')}
         FROM public.journal_entries o
        WHERE o.id = $5`,
      [correctionId, userId, companyId, fiscalPeriodId, originalId],
    )
    await insertLines(correctionId, '5420', '1930', 1200)
    await commit(correctionId)

    await pool.query(
      `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2
        WHERE id = $1 AND status = 'posted'`,
      [originalId, stornoId],
    )

    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT id, status, source_type, ${carriedList}
         FROM public.journal_entries
        WHERE id = ANY($1::uuid[])`,
      [[originalId, stornoId, correctionId]],
    )
    const byId = Object.fromEntries(rows.map((r) => [r.id as string, r]))

    expect(byId[originalId]).toMatchObject({ status: 'reversed', source_type: 'manual' })
    expect(byId[stornoId]).toMatchObject({ status: 'posted', source_type: 'storno' })
    expect(byId[correctionId]).toMatchObject({ status: 'posted', source_type: 'correction' })
    expect(byId[originalId]!.notes).toBe('Deltagare: två kunder. Syfte: genomgång av avtalet.')
    for (const column of carried) {
      expect(byId[correctionId]![column], column).toEqual(byId[originalId]![column])
      expect(byId[stornoId]![column], column).toBeNull()
    }
  })
})
