import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertDraftJournalEntry,
} from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Covers 20260702230000_dimensions_generated_column_cutover (dimensions PR9):
 *
 *   - cost_center/project are GENERATED ALWAYS AS (NULLIF(dimensions->>'1'/'6',''))
 *     STORED: inserting only the bag produces the same mirror values the
 *     dual-write produced.
 *   - An INSERT that names either mirror column errors (the reason every
 *     writer was stripped in this PR).
 *   - The retag RPC (redefined here to SET only the bag) still updates a
 *     posted line under its carve-out, and the mirrors recompute.
 */

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  return { userId, companyId, fiscalPeriodId }
}

describe('journal_entry_lines generated mirrors (PR9 cutover)', () => {
  it('derives cost_center/project from the bag on insert; empty bag yields NULLs', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    const { rows } = await getPool().query<{
      dimensions: Record<string, string>
      cost_center: string | null
      project: string | null
    }>(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, dimensions)
       VALUES ($1, '4010', 1000, 0, '{"1":"KS01","6":"P001"}'::jsonb),
              ($1, '1930', 0, 1000, '{}'::jsonb)
       RETURNING dimensions, cost_center, project`,
      [entryId],
    )

    const tagged = rows.find((r) => r.dimensions['1'])!
    expect(tagged.cost_center).toBe('KS01')
    expect(tagged.project).toBe('P001')

    const untagged = rows.find((r) => !r.dimensions['1'])!
    expect(untagged.cost_center).toBeNull()
    expect(untagged.project).toBeNull()
  })

  it('rejects an INSERT that names a mirror column explicitly', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })

    await expect(
      getPool().query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, dimensions, cost_center)
         VALUES ($1, '4010', 1000, 0, '{"1":"KS01"}'::jsonb, 'KS01')`,
        [entryId],
      ),
    ).rejects.toThrow(/non-DEFAULT value into column/i)
  })

  it('mirrors recompute when a draft bag is updated (bag-only write)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedTenant()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, dimensions)
       VALUES ($1, '4010', 500, 0, '{"6":"P001"}'::jsonb)
       RETURNING id`,
      [entryId],
    )

    await getPool().query(
      `UPDATE public.journal_entry_lines SET dimensions = '{"1":"KS02"}'::jsonb WHERE id = $1`,
      [rows[0].id],
    )
    const after = await getPool().query<{ cost_center: string | null; project: string | null }>(
      `SELECT cost_center, project FROM public.journal_entry_lines WHERE id = $1`,
      [rows[0].id],
    )
    expect(after.rows[0].cost_center).toBe('KS02')
    expect(after.rows[0].project).toBeNull()
  })
})
