import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from '@/tests/pg/setup'
import { seedCompany, insertFiscalPeriod } from '@/tests/pg/fixtures'

/**
 * Recordate (wrong-year fix) DB-layer invariants. recordateEntry moves a posted
 * verifikation to a different fiscal year via storno + re-book: the original is
 * reversed in its own period and an identical corrected entry is posted in the
 * target period with the new date. The service runs through the Supabase JS
 * client (out of scope for pg-real, see correct-correction.pg), so we drive the
 * SQL directly to prove the guarantees the service depends on:
 *
 *   1. A correction can be posted into a DIFFERENT open period than the
 *      original, drawing its voucher number from that period's sequence, while
 *      the storno + original stay in the original period.
 *   2. enforce_period_lock rejects any write into a locked target period — the
 *      DB backstop behind recordateEntry's pre-flight TargetPeriodLockedError.
 */
describe('recordate (pg-real)', () => {
  async function insertDraft(opts: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    entryDate: string
    sourceType: string
    reversesId?: string | null
    correctionOfId?: string | null
  }): Promise<string> {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id, correction_of_id)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, $6, $7, 'draft', $8, $9)`,
      [
        id,
        opts.userId,
        opts.companyId,
        opts.fiscalPeriodId,
        opts.entryDate,
        `Entry ${opts.sourceType}`,
        opts.sourceType,
        opts.reversesId ?? null,
        opts.correctionOfId ?? null,
      ],
    )
    return id
  }

  async function insertLines(entryId: string, debitAcc: string, creditAcc: string, amount: number) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
      [entryId, debitAcc, amount, creditAcc],
    )
  }

  async function commit(companyId: string, entryId: string): Promise<number> {
    const { rows } = await getPool().query<{ voucher_number: number }>(
      `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
      [companyId, entryId],
    )
    return rows[0]!.voucher_number
  }

  async function markReversed(entryId: string, reversedById: string) {
    await getPool().query(
      `UPDATE public.journal_entries
          SET status = 'reversed', reversed_by_id = $2
        WHERE id = $1 AND status = 'posted'`,
      [entryId, reversedById],
    )
  }

  it('books the corrected entry in the target year while storno + original stay in the original year', async () => {
    const { userId, companyId, fiscalPeriodId: fp2026 } = await seedCompany() // 2026, open
    const fp2025 = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })

    // Original booked on the wrong year (2026-07-03, should be 2025-07-03).
    const originalId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId: fp2026,
      entryDate: '2026-07-03',
      sourceType: 'manual',
    })
    await insertLines(originalId, '6230', '1930', 1008.75)
    await commit(companyId, originalId)

    // Storno in the original period (nets 2026 to zero for this entry).
    const stornoId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId: fp2026,
      entryDate: '2026-07-03',
      sourceType: 'storno',
      reversesId: originalId,
    })
    await insertLines(stornoId, '1930', '6230', 1008.75) // swapped legs
    await commit(companyId, stornoId)
    await markReversed(originalId, stornoId)

    // Corrected re-booking in the *target* year with the right date.
    const correctedId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId: fp2025,
      entryDate: '2025-07-03',
      sourceType: 'correction',
      correctionOfId: originalId,
    })
    await insertLines(correctedId, '6230', '1930', 1008.75)
    const correctedVoucher = await commit(companyId, correctedId)

    expect(correctedVoucher).toBeGreaterThan(0)

    const { rows } = await getPool().query<{
      id: string
      status: string
      fiscal_period_id: string
      entry_date: string
      correction_of_id: string | null
      reverses_id: string | null
      reversed_by_id: string | null
    }>(
      `SELECT id, status, fiscal_period_id, entry_date::text, correction_of_id, reverses_id, reversed_by_id
         FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )
    const state = Object.fromEntries(rows.map((r) => [r.id, r]))

    expect(state[originalId]).toMatchObject({
      status: 'reversed',
      fiscal_period_id: fp2026,
      reversed_by_id: stornoId,
    })
    expect(state[stornoId]).toMatchObject({
      status: 'posted',
      fiscal_period_id: fp2026,
      reverses_id: originalId,
    })
    expect(state[correctedId]).toMatchObject({
      status: 'posted',
      fiscal_period_id: fp2025,
      entry_date: '2025-07-03',
      correction_of_id: originalId,
    })
  })

  it('enforce_period_lock rejects re-booking into a locked target period', async () => {
    const { userId, companyId } = await seedCompany() // 2026, open
    const fp2025 = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
      [fp2025],
    )

    // The trigger fires on INSERT, so even staging the corrected draft fails.
    await expect(
      insertDraft({
        userId,
        companyId,
        fiscalPeriodId: fp2025,
        entryDate: '2025-07-03',
        sourceType: 'correction',
      }),
    ).rejects.toThrow(/locked\/closed fiscal period/)
  })
})
