import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

/**
 * Chained-correction invariant: a posted entry of source_type='correction'
 * can itself be reversed and corrected: the chain just grows. The UI used
 * to block this; the storno-service never did. This test asserts the DB
 * layer accepts the full two-level chain (CHECK constraint, FK, immutability
 * trigger), so any future migration that accidentally tightens one of those
 * will fail loudly here instead of silently breaking BFL 5 kap. 5 § flows.
 *
 * The flow this mirrors:
 *   1. Original posted (manual)
 *   2. correctEntry → storno-1 + correction-1, original → reversed
 *   3. correctEntry on correction-1 → storno-2 + correction-2,
 *      correction-1 → reversed
 *
 * We drive the SQL directly because correctEntry uses the Supabase JS client
 * which is out of scope for the pg-real harness (see year-end-invariants.pg
 * for the same rationale).
 */
describe('chained correction (pg-real)', () => {
  it('accepts a correction whose original is itself a correction', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const pool = getPool()

    async function insertDraft(opts: {
      sourceType: string
      reversesId?: string | null
      correctionOfId?: string | null
    }): Promise<string> {
      const id = randomUUID()
      await pool.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status, reverses_id, correction_of_id)
         VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-15', $5, $6, 'draft', $7, $8)`,
        [
          id,
          userId,
          companyId,
          fiscalPeriodId,
          `Entry ${opts.sourceType}`,
          opts.sourceType,
          opts.reversesId ?? null,
          opts.correctionOfId ?? null,
        ],
      )
      return id
    }

    async function insertLines(entryId: string, debitAcc: string, creditAcc: string, amount: number) {
      await pool.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
        [entryId, debitAcc, amount, creditAcc],
      )
    }

    async function commit(entryId: string): Promise<number> {
      const { rows } = await pool.query<{ voucher_number: number }>(
        `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
        [companyId, entryId],
      )
      return rows[0]!.voucher_number
    }

    async function markReversed(entryId: string, reversedById: string) {
      await pool.query(
        `UPDATE public.journal_entries
            SET status = 'reversed', reversed_by_id = $2
          WHERE id = $1 AND status = 'posted'`,
        [entryId, reversedById],
      )
    }

    // === Step 1: original posted ===
    const originalId = await insertDraft({ sourceType: 'manual' })
    await insertLines(originalId, '5410', '1930', 1000)
    await commit(originalId)

    // === Step 2: first storno + first correction ===
    const storno1Id = await insertDraft({ sourceType: 'storno', reversesId: originalId })
    await insertLines(storno1Id, '1930', '5410', 1000) // swapped legs
    await commit(storno1Id)
    await markReversed(originalId, storno1Id)

    const correction1Id = await insertDraft({
      sourceType: 'correction',
      correctionOfId: originalId,
    })
    await insertLines(correction1Id, '5420', '1930', 1200)
    await commit(correction1Id)

    // Sanity: original is reversed, correction1 is posted.
    const { rows: midRows } = await pool.query<{ id: string; status: string; source_type: string }>(
      `SELECT id, status, source_type FROM public.journal_entries
        WHERE id = ANY($1::uuid[])`,
      [[originalId, correction1Id]],
    )
    const midState = Object.fromEntries(midRows.map((r) => [r.id, r]))
    expect(midState[originalId]?.status).toBe('reversed')
    expect(midState[correction1Id]?.status).toBe('posted')
    expect(midState[correction1Id]?.source_type).toBe('correction')

    // === Step 3: storno + correction OF the first correction ===
    // This is the new path. The DB must accept reverses_id and correction_of_id
    // pointing at a source_type='correction' entry, and accept a second
    // entry of source_type='correction' in the same period.
    const storno2Id = await insertDraft({ sourceType: 'storno', reversesId: correction1Id })
    await insertLines(storno2Id, '1930', '5420', 1200)
    await commit(storno2Id)
    await markReversed(correction1Id, storno2Id)

    const correction2Id = await insertDraft({
      sourceType: 'correction',
      correctionOfId: correction1Id,
    })
    await insertLines(correction2Id, '5430', '1930', 1500)
    const correction2Voucher = await commit(correction2Id)

    expect(correction2Voucher).toBeGreaterThan(0)

    // === Final assertions: full chain is intact ===
    const { rows: finalRows } = await pool.query<{
      id: string
      status: string
      source_type: string
      reverses_id: string | null
      correction_of_id: string | null
      reversed_by_id: string | null
    }>(
      `SELECT id, status, source_type, reverses_id, correction_of_id, reversed_by_id
         FROM public.journal_entries
        WHERE company_id = $1
        ORDER BY voucher_number`,
      [companyId],
    )

    expect(finalRows).toHaveLength(5)

    const state = Object.fromEntries(finalRows.map((r) => [r.id, r]))
    expect(state[originalId]).toMatchObject({
      status: 'reversed',
      source_type: 'manual',
      reversed_by_id: storno1Id,
    })
    expect(state[storno1Id]).toMatchObject({
      status: 'posted',
      source_type: 'storno',
      reverses_id: originalId,
    })
    expect(state[correction1Id]).toMatchObject({
      status: 'reversed',
      source_type: 'correction',
      correction_of_id: originalId,
      reversed_by_id: storno2Id,
    })
    expect(state[storno2Id]).toMatchObject({
      status: 'posted',
      source_type: 'storno',
      reverses_id: correction1Id,
    })
    expect(state[correction2Id]).toMatchObject({
      status: 'posted',
      source_type: 'correction',
      correction_of_id: correction1Id,
    })
  })
})
