/**
 * correctEntry against a real PostgREST and the real balance trigger.
 *
 * A correction is written beside the engine, after the storno has drawn its
 * number: a line stored unlike the balance check read it got past the check,
 * was refused at commit, and left a cancelled storno in the series. 1,005 is an
 * exact half whose binary sits below it, the input that told the two apart.
 */
import { describe, expect, it } from 'vitest'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import { insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from '@/tests/tool-pg/client'

async function linesOf(entryId: string) {
  const { rows } = await getPool().query(
    `SELECT account_number, debit_amount::float8 AS debit, credit_amount::float8 AS credit
       FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
    [entryId],
  )
  return rows as Array<{ account_number: string; debit: number; credit: number }>
}

describe('correctEntry (real PostgREST)', () => {
  it('posts a half-öre line as the balance check read it, storno and correction both', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const originalId = await insertPostedJournalEntry({ userId, companyId, fiscalPeriodId })

    const { corrected, reversal } = await correctEntry(createToolPgClient(), companyId, userId, originalId, [
      { account_number: '5420', debit_amount: 1.005, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1.01 },
    ])

    expect(reversal.status).toBe('posted')
    expect(corrected.status).toBe('posted')
    expect(await linesOf(corrected.id)).toEqual([
      { account_number: '5420', debit: 1.01, credit: 0 },
      { account_number: '1930', debit: 0, credit: 1.01 },
    ])
  })
})
