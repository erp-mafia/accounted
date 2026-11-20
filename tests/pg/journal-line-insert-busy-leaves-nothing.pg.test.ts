/**
 * A verifikat line insert refused under the company's busy lock leaves
 * nothing behind, so the engine may try the same insert again (for #206).
 *
 * commit_journal_entry takes the company row first and holds it until it
 * commits. lock_cash_history_for_journal_line observes that row with FOR
 * SHARE NOWAIT, so a line insert of another booking of the same company is
 * refused at once with CASH_ACCOUNT_OPERATION_BUSY: five parallel bookings
 * of one batch refused each other this way. The engine's retry
 * (insertEntryLines in src/lib/bookkeeping/engine.ts) is only right if the
 * refused statement wrote no line and left the draft as it was. Each insert
 * below runs on the pool without BEGIN, one statement in its own
 * transaction, as a PostgREST request does.
 */
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'
import { insertBalancedLines, insertDraftJournalEntry, seedCompany } from './fixtures'

const BUSY = { code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY' }

function insertLines(entryId: string) {
  return getPool().query(
    `INSERT INTO journal_entry_lines(journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', 0, 250), ($1, '5410', 250, 0)`,
    [entryId],
  )
}

async function draftState(entryId: string) {
  const { rows } = await getPool().query(
    `SELECT je.status, je.voucher_number,
            (SELECT count(*)::int FROM journal_entry_lines l WHERE l.journal_entry_id = je.id) AS lines
       FROM journal_entries je WHERE je.id = $1`,
    [entryId],
  )
  return rows[0]
}

/** Runs `whileHeld` while another connection holds the company as `hold` leaves it, then lets go as told. */
async function withHolder(
  hold: (holder: PoolClient) => Promise<unknown>,
  whileHeld: () => Promise<void>,
  end: 'COMMIT' | 'ROLLBACK',
) {
  const holder = await getClient()
  try {
    await holder.query('BEGIN')
    await holder.query("SET LOCAL lock_timeout = '3s'")
    await hold(holder)
    await whileHeld()
    await holder.query(end)
  } catch (error) {
    await holder.query('ROLLBACK')
    throw error
  } finally {
    holder.release()
  }
}

describe('a line insert refused under the busy company lock', () => {
  it('writes no line while another booking of the company is being numbered, and goes through once it is', async () => {
    const company = await seedCompany()
    const other = await insertDraftJournalEntry(company)
    await insertBalancedLines(other)
    const draft = await insertDraftJournalEntry(company)

    await withHolder(
      (holder) => holder.query('SELECT * FROM commit_journal_entry($1, $2)', [company.companyId, other]),
      async () => {
        // Refused every time for as long as the commit is open, and each
        // refusal leaves the draft exactly as it was.
        for (let attempt = 0; attempt < 3; attempt++) {
          await expect(insertLines(draft)).rejects.toMatchObject(BUSY)
          expect(await draftState(draft)).toEqual({ status: 'draft', voucher_number: 0, lines: 0 })
        }
      },
      'COMMIT',
    )

    // The other booking is numbered: the very same insert now goes through,
    // once, with nothing doubled by the refused attempts.
    await insertLines(draft)
    expect(await draftState(draft)).toEqual({ status: 'draft', voucher_number: 0, lines: 2 })
    expect((await draftState(other)).status).toBe('posted')
  })

  it('rolls back the whole statement, not only the row that met the lock', async () => {
    const company = await seedCompany()
    const draft = await insertDraftJournalEntry(company)

    await withHolder(
      (holder) => holder.query('SELECT lock_cash_account_company($1)', [company.companyId]),
      async () => {
        await expect(insertLines(draft)).rejects.toMatchObject(BUSY)
      },
      'ROLLBACK',
    )

    expect(await draftState(draft)).toEqual({ status: 'draft', voucher_number: 0, lines: 0 })
    await insertLines(draft)
    expect(await draftState(draft)).toEqual({ status: 'draft', voucher_number: 0, lines: 2 })
  })

  it('does not refuse a booking of another company', async () => {
    const company = await seedCompany()
    const elsewhere = await seedCompany()
    const draft = await insertDraftJournalEntry(elsewhere)

    await withHolder(
      (holder) => holder.query('SELECT lock_cash_account_company($1)', [company.companyId]),
      async () => {
        await insertLines(draft)
      },
      'ROLLBACK',
    )

    expect((await draftState(draft)).lines).toBe(2)
  })
})
