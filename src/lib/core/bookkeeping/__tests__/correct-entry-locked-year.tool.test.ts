/**
 * correctEntry on a verifikat in a locked year, against a real PostgREST and
 * the real lock triggers: with inFirstOpenPeriodWhenLocked (the person's
 * correction doors) the storno and the corrected verifikat are posted in the
 * first open year, naming the original, and nothing is written to the
 * original or its year. Without it the correction is refused as before.
 */
import { describe, expect, it } from 'vitest'
import { correctEntry } from '@/lib/core/bookkeeping/storno-service'
import { correctionDateInFirstOpenPeriod } from '@/lib/core/bookkeeping/storno-target'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { EntryAlreadyReversedError, TargetPeriodLockedError } from '@/lib/bookkeeping/errors'
import { insertFiscalPeriod, insertPostedJournalEntry, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from '@/tests/tool-pg/client'

async function lockedOriginal() {
  const { userId, companyId, fiscalPeriodId: fp2026 } = await seedCompany()
  const fp2025 = await insertFiscalPeriod({
    userId,
    companyId,
    name: '2025',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
  })
  const originalId = await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId: fp2025,
    entryDate: '2025-11-15',
    voucherNumber: 4,
    description: 'Kontorsmaterial',
    lines: [
      { accountNumber: '6110', debitAmount: 1250, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 1250 },
    ],
  })
  await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [fp2025])
  return { userId, companyId, fp2025, fp2026, originalId }
}

const correctedLines = [
  { account_number: '5460', debit_amount: 1250, credit_amount: 0 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
]

describe('correctEntry of a verifikat in a locked year (real PostgREST)', () => {
  it('posts the storno and the corrected verifikat in the first open year and leaves the original as booked', async () => {
    const { userId, companyId, fp2026, originalId } = await lockedOriginal()
    // Today held inside 2026 (the seeded open year), whenever the suite runs.
    const expected = correctionDateInFirstOpenPeriod('2025-11-15', todayIsoStockholm(), null, [
      { id: 'fp-2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: false, locked_at: 'locked' },
      { id: fp2026, period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null },
    ])

    const { reversal, corrected } = await correctEntry(
      createToolPgClient(),
      companyId,
      userId,
      originalId,
      correctedLines,
      { inFirstOpenPeriodWhenLocked: true },
    )

    expect(reversal).toMatchObject({
      status: 'posted',
      source_type: 'storno',
      reverses_id: originalId,
      fiscal_period_id: fp2026,
      entry_date: expected.date,
      description: 'Storno av verifikat A4 (2025-11-15): Kontorsmaterial',
    })
    expect(corrected).toMatchObject({
      status: 'posted',
      source_type: 'correction',
      correction_of_id: originalId,
      fiscal_period_id: fp2026,
      entry_date: expected.date,
      description: 'Rättelse av verifikat A4 (2025-11-15): Kontorsmaterial',
    })

    const { rows } = await getPool().query<{ status: string; reversed_by_id: string | null; entry_date: string }>(
      `SELECT status, reversed_by_id, entry_date::text FROM public.journal_entries WHERE id = $1`,
      [originalId],
    )
    expect(rows[0]).toEqual({ status: 'posted', reversed_by_id: null, entry_date: '2025-11-15' })

    // Done once: a second correction or a storno of the original is refused.
    await expect(
      correctEntry(createToolPgClient(), companyId, userId, originalId, correctedLines, {
        inFirstOpenPeriodWhenLocked: true,
      }),
    ).rejects.toBeInstanceOf(EntryAlreadyReversedError)
    await expect(reverseEntry(createToolPgClient(), companyId, userId, originalId)).rejects.toBeInstanceOf(
      EntryAlreadyReversedError,
    )
  })

  it('refuses without the option and writes nothing', async () => {
    const { userId, companyId, originalId } = await lockedOriginal()

    await expect(
      correctEntry(createToolPgClient(), companyId, userId, originalId, correctedLines),
    ).rejects.toBeInstanceOf(TargetPeriodLockedError)

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )
    expect(rows[0]!.count).toBe('1')
  })
})
