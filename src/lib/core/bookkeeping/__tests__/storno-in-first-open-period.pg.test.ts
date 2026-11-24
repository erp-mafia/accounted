import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from '@/tests/pg/setup'
import { insertFiscalPeriod, seedCompany } from '@/tests/pg/fixtures'

/**
 * A verifikat in a locked or closed year, or dated on or before the company
 * lock date, is corrected by a storno and a corrected verifikat dated in the
 * first open, unlocked period (correctEntry with inFirstOpenPeriodWhenLocked,
 * storno-target.ts). The service runs through the Supabase JS client (out of
 * scope for pg-real, see correct-entry-locked-year.tool.test.ts), so this
 * drives the SQL it writes and proves what the database guarantees:
 *
 *   1. the storno and the corrected verifikat post in the open year, linked to
 *      the locked original by reverses_id / correction_of_id and numbered in
 *      the open year's series, while the original stays as it was booked;
 *   2. the triggers still refuse every write into the locked stretch: the
 *      original's own status flip (which the moved path never asks for), a
 *      storno in the locked year, a storno dated in the locked year but
 *      booked in the open one, and one dated on or before the lock date.
 */
describe('storno of a locked verifikat in the first open period (pg-real)', () => {
  async function insertDraft(opts: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    entryDate: string
    sourceType: string
    description?: string
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
        opts.description ?? `Entry ${opts.sourceType}`,
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

  async function entry(id: string) {
    const { rows } = await getPool().query<{
      status: string
      fiscal_period_id: string
      entry_date: string
      voucher_number: number
      reverses_id: string | null
      reversed_by_id: string | null
      correction_of_id: string | null
    }>(
      `SELECT status, fiscal_period_id, entry_date::text, voucher_number, reverses_id, reversed_by_id, correction_of_id
         FROM public.journal_entries WHERE id = $1`,
      [id],
    )
    return rows[0]!
  }

  /** A posted verifikat in 2025 (6110 / 1930), then 2025 locked or closed; 2026 open. */
  async function lockedOriginal(lock: 'locked' | 'closed') {
    const { userId, companyId, fiscalPeriodId: fp2026 } = await seedCompany()
    const fp2025 = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    const originalId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId: fp2025,
      entryDate: '2025-11-15',
      sourceType: 'manual',
      description: 'Kontorsmaterial',
    })
    await insertLines(originalId, '6110', '1930', 1250)
    const originalVoucher = await commit(companyId, originalId)
    await getPool().query(
      lock === 'closed'
        ? `UPDATE public.fiscal_periods SET is_closed = true, closed_at = now(), locked_at = now() WHERE id = $1`
        : `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
      [fp2025],
    )
    return { userId, companyId, fp2025, fp2026, originalId, originalVoucher }
  }

  it.each(['locked', 'closed'] as const)(
    'posts the storno and the corrected verifikat in the open year and leaves the %s original as booked',
    async (lock) => {
      const { userId, companyId, fp2026, fp2025, originalId, originalVoucher } = await lockedOriginal(lock)

      const stornoId = await insertDraft({
        userId,
        companyId,
        fiscalPeriodId: fp2026,
        entryDate: '2026-11-24',
        sourceType: 'storno',
        description: `Storno av verifikat A${originalVoucher} (2025-11-15): Kontorsmaterial`,
        reversesId: originalId,
      })
      await insertLines(stornoId, '1930', '6110', 1250) // the original's sides swapped
      const stornoVoucher = await commit(companyId, stornoId)

      const correctedId = await insertDraft({
        userId,
        companyId,
        fiscalPeriodId: fp2026,
        entryDate: '2026-11-24',
        sourceType: 'correction',
        description: `Rättelse av verifikat A${originalVoucher} (2025-11-15): Kontorsmaterial`,
        correctionOfId: originalId,
      })
      await insertLines(correctedId, '5460', '1930', 1250)
      const correctedVoucher = await commit(companyId, correctedId)

      // Numbered in 2026's own series, one after the other.
      expect(stornoVoucher).toBeGreaterThan(0)
      expect(correctedVoucher).toBe(stornoVoucher + 1)
      expect(await entry(stornoId)).toMatchObject({
        status: 'posted',
        fiscal_period_id: fp2026,
        entry_date: '2026-11-24',
        reverses_id: originalId,
      })
      expect(await entry(correctedId)).toMatchObject({
        status: 'posted',
        fiscal_period_id: fp2026,
        entry_date: '2026-11-24',
        correction_of_id: originalId,
      })
      // The original stands in its year exactly as it was booked.
      expect(await entry(originalId)).toMatchObject({
        status: 'posted',
        fiscal_period_id: fp2025,
        entry_date: '2025-11-15',
        voucher_number: originalVoucher,
        reversed_by_id: null,
      })

      // 2025 still holds the original alone; 2026 holds the difference.
      const { rows: balances } = await getPool().query<{ fiscal_period_id: string; account_number: string; net: string }>(
        `SELECT e.fiscal_period_id, l.account_number, sum(l.debit_amount - l.credit_amount)::text AS net
           FROM public.journal_entry_lines l
           JOIN public.journal_entries e ON e.id = l.journal_entry_id
          WHERE e.company_id = $1 AND e.status IN ('posted', 'reversed')
          GROUP BY 1, 2`,
        [companyId],
      )
      const net = (period: string, account: string) =>
        Number(balances.find((b) => b.fiscal_period_id === period && b.account_number === account)?.net ?? 0)
      expect(net(fp2025, '6110')).toBe(1250)
      expect(net(fp2025, '1930')).toBe(-1250)
      expect(net(fp2026, '6110')).toBe(-1250)
      expect(net(fp2026, '5460')).toBe(1250)
      expect(net(fp2026, '1930')).toBe(0)
    },
  )

  it('still refuses every write into the locked year', async () => {
    const { userId, companyId, fp2025, fp2026, originalId } = await lockedOriginal('locked')

    // A storno booked in the open year first, so the flip below is the one
    // the open-year path makes.
    const stornoId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId: fp2026,
      entryDate: '2026-11-24',
      sourceType: 'storno',
      reversesId: originalId,
    })
    await insertLines(stornoId, '1930', '6110', 1250)
    await commit(companyId, stornoId)

    // The original's own status flip, which the moved path never makes.
    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
        [originalId, stornoId],
      ),
    ).rejects.toThrow(/locked\/closed fiscal period/)

    // A storno booked in the locked year: refused on insert.
    await expect(
      insertDraft({
        userId,
        companyId,
        fiscalPeriodId: fp2025,
        entryDate: '2025-11-15',
        sourceType: 'storno',
        reversesId: originalId,
      }),
    ).rejects.toThrow(/locked\/closed fiscal period/)

    // Numbered in the open year but dated in the locked one: refused, so a
    // moved storno can only carry a date of the year it is booked in.
    await expect(
      insertDraft({
        userId,
        companyId,
        fiscalPeriodId: fp2026,
        entryDate: '2025-11-15',
        sourceType: 'storno',
        reversesId: originalId,
      }),
    ).rejects.toThrow(/ENTRY_DATE_OUTSIDE_FISCAL_PERIOD/)

    expect(await entry(originalId)).toMatchObject({ status: 'posted', reversed_by_id: null })
  })

  it('refuses a storno dated on or before the company lock date and takes one dated after it', async () => {
    const { userId, companyId, fiscalPeriodId: fp2026 } = await seedCompany()
    const originalId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId: fp2026,
      entryDate: '2026-03-15',
      sourceType: 'manual',
    })
    await insertLines(originalId, '6110', '1930', 400)
    await commit(companyId, originalId)
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, bookkeeping_locked_through)
       VALUES ($1, $2, '2026-06-30'::date)
       ON CONFLICT (company_id) DO UPDATE SET bookkeeping_locked_through = '2026-06-30'::date`,
      [userId, companyId],
    )

    await expect(
      insertDraft({
        userId,
        companyId,
        fiscalPeriodId: fp2026,
        entryDate: '2026-03-15',
        sourceType: 'storno',
        reversesId: originalId,
      }),
    ).rejects.toThrow(/Bokföringen är låst/)

    const stornoId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId: fp2026,
      entryDate: '2026-07-01',
      sourceType: 'storno',
      reversesId: originalId,
    })
    await insertLines(stornoId, '1930', '6110', 400)
    await commit(companyId, stornoId)

    expect(await entry(stornoId)).toMatchObject({ status: 'posted', entry_date: '2026-07-01', reverses_id: originalId })
    expect(await entry(originalId)).toMatchObject({ status: 'posted', reversed_by_id: null })
  })
})
