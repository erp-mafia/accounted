import { describe, expect, it } from 'vitest'
import {
  seedCompany,
  insertDraftJournalEntry,
  insertBalancedLines,
} from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Covers 20260618120001_commit_method_agent_provenance:
 *   - journal_entries.commit_method accepts the new 'agent' and 'api_key'
 *     values (MCP-relayed approvals: agent_first_vision.md §8 P0-1).
 *   - The pre-existing values are still accepted.
 *   - Unknown values are still rejected by the CHECK constraint.
 *   - Exactly one commit_method constraint exists (guards against the
 *     DROP CONSTRAINT IF EXISTS missing a differently-named original, which
 *     would leave the old, narrower CHECK in force).
 */

async function postWithCommitMethod(commitMethod: string): Promise<string> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
  await insertBalancedLines(entryId)
  // draft → posted with commit metadata: same transition the commit RPC does.
  await getPool().query(
    `UPDATE public.journal_entries
       SET status = 'posted', voucher_number = 1, commit_method = $2
     WHERE id = $1`,
    [entryId, commitMethod],
  )
  return entryId
}

describe('journal_entries.commit_method: agent provenance values', () => {
  it.each(['agent', 'api_key', 'user_accept', 'bulk_accept'])(
    'accepts commit_method=%s',
    async (method) => {
      const entryId = await postWithCommitMethod(method)
      const { rows } = await getPool().query(
        `SELECT commit_method, status FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      expect(rows[0]).toEqual({ commit_method: method, status: 'posted' })
    },
  )

  it('rejects values outside the CHECK list', async () => {
    await expect(postWithCommitMethod('robot')).rejects.toMatchObject({
      // 23514 = check_violation
      code: '23514',
    })
  })

  it('exactly one commit_method CHECK constraint exists, under the canonical name', async () => {
    const { rows } = await getPool().query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'public.journal_entries'::regclass
          AND conname LIKE '%commit_method%'`,
    )
    expect(rows.map((r) => r.conname)).toEqual(['journal_entries_commit_method_check'])
  })
})
