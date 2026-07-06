import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  insertBalancedLines,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'

describe('engine.pg: triggers & RPCs that mocks cannot catch', () => {
  it('rejects INSERT into journal_entries when the fiscal period is closed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany({ isClosed: true })

    await expect(
      insertDraftJournalEntry({ userId, companyId, fiscalPeriodId }),
    ).rejects.toThrow(/locked\/closed fiscal period/i)
  })

  it('commit_journal_entry assigns sequential voucher numbers under concurrency', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const entryA = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    const entryB = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryA)
    await insertBalancedLines(entryB)

    // Two dedicated clients so the row-level lock on voucher_sequences is
    // actually exercised: not just a single connection serialising calls.
    const clientA = await getPool().connect()
    const clientB = await getPool().connect()
    try {
      const [resA, resB] = await Promise.all([
        clientA.query<{ voucher_number: number }>(
          `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
          [companyId, entryA],
        ),
        clientB.query<{ voucher_number: number }>(
          `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
          [companyId, entryB],
        ),
      ])
      const numbers = [resA.rows[0]!.voucher_number, resB.rows[0]!.voucher_number].sort(
        (a, b) => a - b,
      )
      expect(numbers).toEqual([1, 2])
    } finally {
      clientA.release()
      clientB.release()
    }
  })

  it('rejects UPDATE to a posted journal entry (committed immutability)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Bypass commit_journal_entry by inserting directly as 'posted'. The
    // immutability trigger fires on UPDATE, not INSERT, so this is legal
    // setup on the superuser connection.
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      voucherNumber: 1,
    })

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET description = 'tampered' WHERE id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/Cannot modify a posted journal entry/i)
  })

  it('next_voucher_number falls back to the company owner when auth.uid() is NULL', async () => {
    // The superuser pg connection has no Supabase JWT, so auth.uid() IS NULL:
    // exactly the service-role shape (repair scripts, cron) that used to fail
    // the voucher_sequences user_id NOT NULL check before ON CONFLICT could
    // arbitrate (commit_journal_entry got the fallback in 20260421170500;
    // next_voucher_number (the storno/correction path) did not until
    // 20260623130000).
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const first = await getPool().query<{ n: number }>(
      `SELECT public.next_voucher_number($1::uuid, $2::uuid) AS n`,
      [companyId, fiscalPeriodId],
    )
    const second = await getPool().query<{ n: number }>(
      `SELECT public.next_voucher_number($1::uuid, $2::uuid) AS n`,
      [companyId, fiscalPeriodId],
    )
    expect(first.rows[0]!.n).toBe(1)
    expect(second.rows[0]!.n).toBe(2)

    // Attribution on the sequence row falls back to companies.created_by.
    const seq = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM public.voucher_sequences
       WHERE company_id = $1::uuid AND fiscal_period_id = $2::uuid AND voucher_series = 'A'`,
      [companyId, fiscalPeriodId],
    )
    expect(seq.rows[0]!.user_id).toBe(userId)
  })
})
