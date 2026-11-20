import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  insertBalancedLines,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'

/**
 * Covers 20260619120000_journal_entry_committed_actor:
 *   - commit_journal_entry() gained p_actor_type/p_actor_label (DEFAULT NULL)
 *     and stamps journal_entries.committed_actor_* in the draft→posted UPDATE.
 *   - write_audit_log() reads the transaction-local gnubok.actor_* GUCs the
 *     RPC sets, so the COMMIT audit row carries actor attribution.
 *   - Every pre-existing call shape (2/4-arg) behaves byte-identically:
 *     NULL columns, audit actor_type 'user' (the column's previous effective
 *     DEFAULT), actor_label NULL.
 *   - The GUCs are transaction-local: attribution never leaks into later
 *     statements on the same connection.
 *   - The new columns are frozen by the posted-entry immutability trigger.
 */

async function seedDraft() {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
  await insertBalancedLines(entryId)
  return { companyId, entryId }
}

async function fetchCommitAudit(entryId: string) {
  const { rows } = await getPool().query(
    `SELECT actor_type, actor_label
       FROM public.audit_log
      WHERE record_id = $1 AND action = 'COMMIT'`,
    [entryId],
  )
  return rows
}

describe('commit_journal_entry: actor attribution (committed_actor_* + audit GUCs)', () => {
  it('stamps committed_actor_* and the COMMIT audit row when actor params are passed', async () => {
    const { companyId, entryId } = await seedDraft()

    await getPool().query(
      `SELECT voucher_number FROM public.commit_journal_entry(
         $1::uuid, $2::uuid, 'api_key', NULL, 'api_key', 'Claude Desktop')`,
      [companyId, entryId],
    )

    const { rows } = await getPool().query(
      `SELECT status, commit_method, committed_actor_type, committed_actor_label
         FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(rows[0]).toEqual({
      status: 'posted',
      commit_method: 'api_key',
      committed_actor_type: 'api_key',
      committed_actor_label: 'Claude Desktop',
    })

    const audit = await fetchCommitAudit(entryId)
    expect(audit).toEqual([{ actor_type: 'api_key', actor_label: 'Claude Desktop' }])
  })

  it('keeps the pre-attribution behaviour for callers that omit the new params', async () => {
    const { companyId, entryId } = await seedDraft()

    // 2-arg call: the shape deployed code used before the 6-arg migration.
    await getPool().query(
      `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
      [companyId, entryId],
    )

    const { rows } = await getPool().query(
      `SELECT committed_actor_type, committed_actor_label
         FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(rows[0]).toEqual({ committed_actor_type: null, committed_actor_label: null })

    // Audit row falls back to 'user': the column's previous effective DEFAULT.
    const audit = await fetchCommitAudit(entryId)
    expect(audit).toEqual([{ actor_type: 'user', actor_label: null }])
  })

  it('rejects committed_actor_type values outside the CHECK list', async () => {
    const { companyId, entryId } = await seedDraft()
    await expect(
      getPool().query(
        `SELECT voucher_number FROM public.commit_journal_entry(
           $1::uuid, $2::uuid, NULL, NULL, 'robot', NULL)`,
        [companyId, entryId],
      ),
    ).rejects.toMatchObject({ code: '23514' }) // check_violation
  })

  it('does not leak the actor GUCs into later transactions on the same connection', async () => {
    const a = await seedDraft()
    const b = await seedDraft()

    const client = await getPool().connect()
    try {
      await client.query(
        `SELECT voucher_number FROM public.commit_journal_entry(
           $1::uuid, $2::uuid, NULL, NULL, 'api_key', 'Leaky Key')`,
        [a.companyId, a.entryId],
      )
      // Same connection, next transaction: set_config(..., is_local=true) must
      // have died with the previous transaction.
      await client.query(
        `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
        [b.companyId, b.entryId],
      )
    } finally {
      client.release()
    }

    expect(await fetchCommitAudit(a.entryId)).toEqual([
      { actor_type: 'api_key', actor_label: 'Leaky Key' },
    ])
    expect(await fetchCommitAudit(b.entryId)).toEqual([
      { actor_type: 'user', actor_label: null },
    ])
  })

  it('freezes committed_actor_* after posting (immutability trigger)', async () => {
    const { companyId, entryId } = await seedDraft()
    await getPool().query(
      `SELECT voucher_number FROM public.commit_journal_entry(
         $1::uuid, $2::uuid, NULL, NULL, 'api_key', 'Original')`,
      [companyId, entryId],
    )

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET committed_actor_label = 'tampered' WHERE id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/Cannot modify a posted journal entry/i)
  })

  // The storno paths (reverseEntry, correctEntry) insert their storno and
  // rättelse as unnumbered drafts and post them through this RPC
  // (commitStornoOrCorrectionDraft). The new verifikat carry the correcting
  // actor; the original keeps its own stamp and is never re-stamped.
  it('stamps a storno and its rättelse with the correcting actor and leaves the original alone', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const pool = getPool()
    const originalId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertBalancedLines(originalId)
    await pool.query(`SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`, [
      companyId,
      originalId,
    ])

    async function draft(sourceType: 'storno' | 'correction', link: string): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO public.journal_entries
           (user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
            description, source_type, status, reverses_id, correction_of_id)
         VALUES ($1, $2, $3, 0, 'A', '2026-06-15', $4, $4, 'draft', $5, $6)
         RETURNING id`,
        [userId, companyId, fiscalPeriodId, sourceType,
          sourceType === 'storno' ? link : null, sourceType === 'correction' ? link : null],
      )
      return rows[0]!.id
    }
    async function commitAs(entryId: string) {
      const { rows } = await pool.query<{ voucher_number: number }>(
        `SELECT voucher_number FROM public.commit_journal_entry(
           $1::uuid, $2::uuid, 'api_key', NULL, 'mcp_oauth', 'Claude (Anthropic)')`,
        [companyId, entryId],
      )
      return rows[0]!.voucher_number
    }

    const stornoId = await draft('storno', originalId)
    await pool.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 0, 1000), ($1, '3001', 1000, 0)`,
      [stornoId],
    )
    const stornoNumber = await commitAs(stornoId)
    const correctionId = await draft('correction', originalId)
    await insertBalancedLines(correctionId, 1200)
    const correctionNumber = await commitAs(correctionId)
    await pool.query(
      `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2
        WHERE id = $1 AND status = 'posted'`,
      [originalId, stornoId],
    )

    expect(correctionNumber).toBe(stornoNumber + 1)
    const { rows } = await pool.query(
      `SELECT id, status, commit_method, committed_actor_type, committed_actor_label
         FROM public.journal_entries WHERE id = ANY($1::uuid[])`,
      [[originalId, stornoId, correctionId]],
    )
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId[originalId]).toMatchObject({ status: 'reversed', committed_actor_type: null, commit_method: null })
    for (const id of [stornoId, correctionId]) {
      expect(byId[id]).toMatchObject({
        status: 'posted',
        commit_method: 'api_key',
        committed_actor_type: 'mcp_oauth',
        committed_actor_label: 'Claude (Anthropic)',
      })
      expect(await fetchCommitAudit(id)).toEqual([{ actor_type: 'mcp_oauth', actor_label: 'Claude (Anthropic)' }])
    }
  })

  it('exposes exactly one commit_journal_entry signature (no PostgREST overload ambiguity)', async () => {
    const { rows } = await getPool().query(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'commit_journal_entry'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.args).toContain('p_actor_type')
    expect(rows[0]!.args).toContain('p_actor_label')
  })
})
