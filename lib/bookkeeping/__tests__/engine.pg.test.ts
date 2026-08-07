import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  insertBalancedLines,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'

describe('engine.pg: triggers & RPCs that mocks cannot catch', () => {
  it('rejects a directly inserted posted journal entry with no lines', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    await expect(
      getPool().query(
        `INSERT INTO public.journal_entries
           (user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status)
         VALUES ($1, $2, $3, 1, 'A', '2026-06-01', 'Direct posted insert', 'manual', 'posted')`,
        [userId, companyId, fiscalPeriodId],
      ),
    ).rejects.toThrow(/has zero total/i)
  })

  it('rejects an unbalanced directly inserted posted journal entry at constraint time', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const client = await getPool().connect()

    try {
      await client.query('BEGIN')
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.journal_entries
           (user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status)
         VALUES ($1, $2, $3, 1, 'A', '2026-06-01', 'Direct posted insert', 'manual', 'posted')
         RETURNING id`,
        [userId, companyId, fiscalPeriodId],
      )
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, '1930', 100, 0)`,
        [inserted.rows[0]!.id],
      )

      await expect(
        client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE'),
      ).rejects.toThrow(/not balanced/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('allows balanced lines to follow a posted header in the same transaction', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const client = await getPool().connect()

    try {
      await client.query('BEGIN')
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.journal_entries
           (user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status)
         VALUES ($1, $2, $3, 1, 'A', '2026-06-01', 'Direct posted insert', 'manual', 'posted')
         RETURNING id`,
        [userId, companyId, fiscalPeriodId],
      )
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, '1930', 100, 0),
                ($1, '3001', 0, 100)`,
        [inserted.rows[0]!.id],
      )

      await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
      const persisted = await client.query<{ status: string }>(
        `SELECT status FROM public.journal_entries WHERE id = $1`,
        [inserted.rows[0]!.id],
      )
      expect(persisted.rows[0]!.status).toBe('posted')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

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

    // Bypass commit_journal_entry with the direct-posted fixture. It inserts
    // balanced lines in the same transaction so the deferred insert balance
    // trigger accepts the setup before immutability is exercised below.
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

  // reverseEntry() clears the period's IB link when it stornos an
  // opening_balance entry. enforce_opening_balance_immutability dictates the
  // shape of that write, and only a real Postgres can prove the ordering: a
  // mocked client accepts the single-statement version that the trigger
  // rejects, which is how a "fixed" storno can still leave the period pinned
  // to a cancelled IB (blocking year-end forever).
  it('enforce_opening_balance_immutability forces a two-step IB unlink', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const ibEntryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      voucherNumber: 1,
    })

    // Linking is legal: the trigger only guards the pointer once it is set.
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET opening_balance_entry_id = $2::uuid, opening_balances_set = true
        WHERE id = $1::uuid`,
      [fiscalPeriodId, ibEntryId],
    )

    // Clearing both columns at once still reads OLD.opening_balances_set =
    // true, so the trigger rejects it. This is the write reverseEntry must
    // never emit.
    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods
            SET opening_balance_entry_id = NULL, opening_balances_set = false
          WHERE id = $1::uuid`,
        [fiscalPeriodId],
      ),
    ).rejects.toThrow(/opening balances are immutable once set/i)

    // Flag first, pointer second: the order reverseEntry uses.
    await getPool().query(
      `UPDATE public.fiscal_periods SET opening_balances_set = false WHERE id = $1::uuid`,
      [fiscalPeriodId],
    )
    await getPool().query(
      `UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL WHERE id = $1::uuid`,
      [fiscalPeriodId],
    )

    const period = await getPool().query<{
      opening_balance_entry_id: string | null
      opening_balances_set: boolean
    }>(
      `SELECT opening_balance_entry_id, opening_balances_set
         FROM public.fiscal_periods WHERE id = $1::uuid`,
      [fiscalPeriodId],
    )
    expect(period.rows[0]!.opening_balance_entry_id).toBeNull()
    expect(period.rows[0]!.opening_balances_set).toBe(false)
  })
})
