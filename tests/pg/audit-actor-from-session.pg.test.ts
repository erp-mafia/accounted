import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertBalancedLines,
  insertCompany,
  insertCompanyMember,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20261029110000_audit_actor_from_session (issue #126): the audit row
 * names the person who made the change, not the person who created the row.
 *
 *   - write_audit_log: an admin who did not create the company_settings row
 *     moves the lock date (bookkeeping_locked_through); the audit row names
 *     the admin. Before the migration it named the row's creator.
 *   - write_sie_header_audit (journal_entries): a member posts a colleague's
 *     draft; the COMMIT row names the member, the same person
 *     journal_entries.committed_by names.
 *   - a service-role write has no session, so the row's user_id still stands
 *     in, as it did before.
 */

interface AuditActor {
  action: string
  user_id: string | null
  actor_id: string | null
  actor_type: string | null
}

async function auditActors(
  db: Pick<PoolClient, 'query'>,
  table: string,
  recordId: string,
  action: string,
): Promise<AuditActor[]> {
  const { rows } = await db.query<AuditActor>(
    `SELECT action, user_id, actor_id, actor_type FROM public.audit_log
      WHERE table_name = $1 AND record_id = $2 AND action = $3
      ORDER BY created_at, id`,
    [table, recordId, action],
  )
  return rows
}

/** A company whose settings row was created by its owner, plus an admin who did not create it. */
async function companyWithSettings(): Promise<{ creatorId: string; adminId: string; companyId: string; settingsId: string }> {
  const creatorId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: creatorId })
  await insertCompanyMember({ companyId, userId: creatorId, role: 'owner' })
  const adminId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2) RETURNING id`,
    [creatorId, companyId],
  )
  return { creatorId, adminId, companyId, settingsId: rows[0]!.id }
}

describe('audit_log names the actor from the session (issue #126)', () => {
  it('names the admin, not the settings row creator, when an admin moves the lock date', async () => {
    const { creatorId, adminId, companyId, settingsId } = await companyWithSettings()

    // Asserted inside the session's transaction: withUserContext rolls back,
    // and the audit row is written in the same transaction as the update.
    const { updated, audit, state } = await withUserContext(adminId, async (client) => {
      const res = await client.query<{ id: string }>(
        `UPDATE public.company_settings SET bookkeeping_locked_through = '2026-03-31'
          WHERE company_id = $1 RETURNING id`,
        [companyId],
      )
      await client.query('RESET ROLE')
      const changed = await client.query<{ old_lock: string | null; new_lock: string | null }>(
        `SELECT old_state->>'bookkeeping_locked_through' AS old_lock,
                new_state->>'bookkeeping_locked_through' AS new_lock
           FROM public.audit_log
          WHERE table_name = 'company_settings' AND record_id = $1 AND action = 'UPDATE'`,
        [settingsId],
      )
      return {
        updated: res.rows.map((r) => r.id),
        audit: await auditActors(client, 'company_settings', settingsId, 'UPDATE'),
        state: changed.rows,
      }
    })

    expect(updated).toEqual([settingsId])
    expect(audit).toEqual([{ action: 'UPDATE', user_id: adminId, actor_id: adminId, actor_type: 'user' }])
    expect(audit[0]!.user_id).not.toBe(creatorId)
    expect(state).toEqual([{ old_lock: null, new_lock: '2026-03-31' }])
  })

  it('keeps the row user_id for a service-role write, which has no session', async () => {
    const { creatorId, companyId, settingsId } = await companyWithSettings()

    await runAsServiceRole(async (client) => {
      const res = await client.query(
        `UPDATE public.company_settings SET bookkeeping_locked_through = '2026-06-30'
          WHERE company_id = $1`,
        [companyId],
      )
      expect(res.rowCount).toBe(1)
    })

    expect(await auditActors(getPool(), 'company_settings', settingsId, 'UPDATE')).toEqual([
      { action: 'UPDATE', user_id: creatorId, actor_id: creatorId, actor_type: 'user' },
    ])
  })

  it("names the member who posts a colleague's draft on the COMMIT row (write_sie_header_audit)", async () => {
    const { userId: creatorId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId: creatorId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId, 1250)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    const { audit, entry } = await withUserContext(memberId, async (client) => {
      const committed = await client.query<{ voucher_number: number }>(
        `SELECT * FROM public.commit_journal_entry($1, $2)`,
        [companyId, entryId],
      )
      expect(committed.rows[0]!.voucher_number).toBeGreaterThan(0)
      await client.query('RESET ROLE')
      const row = await client.query<{ user_id: string; committed_by: string | null }>(
        `SELECT user_id, committed_by FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      return {
        audit: await auditActors(client, 'journal_entries', entryId, 'COMMIT'),
        entry: row.rows[0],
      }
    })

    // The verifikat still belongs to its creator; the commit is the member's.
    expect(entry).toEqual({ user_id: creatorId, committed_by: memberId })
    expect(audit).toEqual([{ action: 'COMMIT', user_id: memberId, actor_id: memberId, actor_type: 'user' }])
  })
})
