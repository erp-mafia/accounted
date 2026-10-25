import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertCashAccount, insertDraftJournalEntry, insertTransaction, seedCompany } from '@/tests/pg/fixtures'

// crm#1433. A purchase booked from its bank row (cost / 1930) is corrected
// into a supplier invoice (cost / 2440). correctEntry (storno-service.ts)
// first tries to move the bank row to the correction; the correction has no
// bank leg, so guard_cash_transaction_binding refuses. The row must then be
// released the way a storno releases it (release_reversed_entry_transactions,
// via releaseBankRowsOfReversedEntry), so it returns to Att bokföra and can be
// matched to the verifikat that books the payment. These run the statements
// the service issues, as the correcting user, against real Postgres.

const POINTER_RELINK = `
  UPDATE public.transactions
     SET journal_entry_id = $3
   WHERE company_id = $1 AND journal_entry_id = $2`

type Line = [account: string, debit: number, credit: number]

async function postedEntry(
  seed: { userId: string; companyId: string; fiscalPeriodId: string },
  voucherNumber: number,
  lines: Line[],
  correctionOfId?: string,
): Promise<string> {
  const id = await insertDraftJournalEntry({ ...seed, voucherNumber })
  for (const [account, debit, credit] of lines) {
    await getPool().query(
      `INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [id, account, debit, credit],
    )
  }
  if (correctionOfId) {
    await getPool().query(`UPDATE public.journal_entries SET correction_of_id = $2 WHERE id = $1`, [
      id,
      correctionOfId,
    ])
  }
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
  return id
}

/** The bank row booked from itself, then the original reversed and corrected with `correctedLines`. */
async function seedCorrectedBankBooking(correctedLines: Line[]) {
  const seed = await seedCompany()
  const cashAccountId = await insertCashAccount({ companyId: seed.companyId, ledgerAccount: '1930' })
  const originalId = await postedEntry(seed, 1, [
    ['5800', 3388.13, 0],
    ['1930', 0, 3388.13],
  ])
  const txId = await insertTransaction({
    userId: seed.userId,
    companyId: seed.companyId,
    amount: -3388.13,
    journalEntryId: originalId,
    cashAccountId,
  })
  await getPool().query(`UPDATE public.transactions SET is_business = true WHERE id = $1`, [txId])
  await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [originalId])
  const correctionId = await postedEntry(seed, 2, correctedLines, originalId)
  return { seed, originalId, correctionId, txId }
}

async function rowOf(client: PoolClient, txId: string) {
  const r = await client.query<{ journal_entry_id: string | null; is_business: boolean | null; booked: boolean }>(
    `SELECT journal_entry_id, is_business, public.is_transaction_booked(id) AS booked
       FROM public.transactions WHERE id = $1`,
    [txId],
  )
  return r.rows[0]!
}

describe('correction-bank-leg-moved.pg (crm#1433)', () => {
  it('a correction without the bank leg cannot take the row; the release puts it back in Att bokföra, matchable to the payment', async () => {
    const { seed, originalId, correctionId, txId } = await seedCorrectedBankBooking([
      ['5800', 3388.13, 0],
      ['2440', 0, 3388.13],
    ])
    const paymentId = await postedEntry(seed, 3, [
      ['2440', 3388.13, 0],
      ['1930', 0, 3388.13],
    ])

    await withUserContext(seed.userId, async (client) => {
      await client.query('SAVEPOINT relink')
      await expect(client.query(POINTER_RELINK, [seed.companyId, originalId, correctionId])).rejects.toThrow(
        'BANK_ANCHOR_SETTLEMENT_CHANGED',
      )
      await client.query('ROLLBACK TO SAVEPOINT relink')

      // Before the fix the row stopped here: on the reversed original, booked.
      expect(await rowOf(client, txId)).toEqual({ journal_entry_id: originalId, is_business: true, booked: true })

      const released = await client.query<{ r: { released: number; dropped: number } }>(
        `SELECT public.release_reversed_entry_transactions($1, $2) AS r`,
        [seed.companyId, originalId],
      )
      expect(released.rows[0]!.r).toEqual({ released: 1, dropped: 0 })
      expect(await rowOf(client, txId)).toEqual({ journal_entry_id: null, is_business: null, booked: false })

      // Back in Att bokföra, the row links to the payment like any manual match.
      await client.query(
        `UPDATE public.transactions
            SET journal_entry_id = $2, is_business = true, reconciliation_method = 'manual'
          WHERE id = $1`,
        [txId, paymentId],
      )
      expect(await rowOf(client, txId)).toEqual({ journal_entry_id: paymentId, is_business: true, booked: true })
    })
  })

  it('a correction that keeps the bank leg still takes the row, and the release then finds nothing', async () => {
    const { seed, originalId, correctionId, txId } = await seedCorrectedBankBooking([
      ['6110', 3388.13, 0],
      ['1930', 0, 3388.13],
    ])

    await withUserContext(seed.userId, async (client) => {
      const moved = await client.query(POINTER_RELINK, [seed.companyId, originalId, correctionId])
      expect(moved.rowCount).toBe(1)
      const released = await client.query<{ r: { released: number; dropped: number } }>(
        `SELECT public.release_reversed_entry_transactions($1, $2) AS r`,
        [seed.companyId, originalId],
      )
      expect(released.rows[0]!.r).toEqual({ released: 0, dropped: 0 })
      expect(await rowOf(client, txId)).toEqual({ journal_entry_id: correctionId, is_business: true, booked: true })
    })
  })
})
