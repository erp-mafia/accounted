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
