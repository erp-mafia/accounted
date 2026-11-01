import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompanyMember,
  insertDraftJournalEntry,
  insertPostedJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { ACTOR_HEADER, actorHeaderValue } from '@/lib/supabase/actor-header'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'

/**
 * Covers 20261101003500_skattekonto_link_audit (accounted#50, PH 171): who
 * linked a skattekonto row to a verifikat, unlinked it, ignored or restored
 * it, and when, lands in audit_log through write_audit_log(); the sync's own
 * updates of the mirror (status, amounts, texts, proposals) and inserts write
 * nothing; a deleted draft that unlinks its rows is logged under the person
 * who deleted it; the actor is resolved like every write_audit_log row.
 */

interface AuditRow {
  action: string
  company_id: string | null
  user_id: string | null
  actor_id: string | null
  actor_type: string | null
  actor_label: string | null
  old_state: Record<string, unknown> | null
  new_state: Record<string, unknown> | null
}

const SELECT_AUDIT = `SELECT action, company_id, user_id, actor_id, actor_type, actor_label, old_state, new_state
                        FROM public.audit_log
                       WHERE table_name = 'skattekonto_transactions' AND record_id = $1
                       ORDER BY created_at, id`

/** The row's audit rows: on the given client (inside its transaction), else committed. */
async function auditRows(rowId: string, client?: PoolClient): Promise<AuditRow[]> {
  const { rows } = client
    ? await client.query<AuditRow>(SELECT_AUDIT, [rowId])
    : await getPool().query<AuditRow>(SELECT_AUDIT, [rowId])
  return rows
}

/** The link transition each audit row records: "old -> new" of journal_entry_id and is_ignored. */
function transitions(rows: AuditRow[]): Array<{ entry: [unknown, unknown]; ignored: [unknown, unknown] }> {
  return rows.map((r) => ({
    entry: [r.old_state?.journal_entry_id ?? null, r.new_state?.journal_entry_id ?? null],
    ignored: [r.old_state?.is_ignored ?? null, r.new_state?.is_ignored ?? null],
  }))
}

/** A settled Skatteverket event as the sync writes it: unlinked, not ignored. */
async function insertSkattekontoRow(companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.skattekonto_transactions
       (id, company_id, dedup_key, transaktionsdatum, transaktionstext, belopp_skatteverket, status)
     VALUES ($1, $2, $3, '2026-06-15', 'Debiterad preliminärskatt', -1000, 'booked')`,
    [id, companyId, `pg-real-${id}`],
  )
  return id
}

/** A company with its owner, an admin who did not create anything, a posted verifikat on 1630 and an open skattekonto row. */
async function companyWithRow(): Promise<{
  ownerId: string
  adminId: string
  companyId: string
  fiscalPeriodId: string
  entryId: string
  rowId: string
}> {
  const { userId: ownerId, companyId, fiscalPeriodId } = await seedCompany()
  const adminId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
  const entryId = await insertPostedJournalEntry({
    userId: ownerId,
    companyId,
    fiscalPeriodId,
    voucherNumber: 1,
    entryDate: '2026-06-15',
    description: 'Preliminärskatt juni',
    lines: [
      { accountNumber: '2510', debitAmount: 1000, creditAmount: 0 },
      { accountNumber: '1630', debitAmount: 0, creditAmount: 1000 },
    ],
  })
  const rowId = await insertSkattekontoRow(companyId)
  return { ownerId, adminId, companyId, fiscalPeriodId, entryId, rowId }
}

/** A service-role request carrying these headers, as PostgREST runs it (committed). */
function serviceRoleRequest<T>(headers: Record<string, string>, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runAsServiceRole(async (client) => {
    await client.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify(headers)])
    return fn(client)
  })
}

function actingFor(actor: CommitActor): Record<string, string> {
  return { [ACTOR_HEADER]: actorHeaderValue(actor)!, 'user-agent': 'supabase-js-node' }
}

describe('audit_skattekonto_transactions_link', () => {
  it('a signed-in admin linking a row is logged under the admin, with the link before and after', async () => {
    const { adminId, companyId, entryId, rowId } = await companyWithRow()

    const rows = await withUserContext(adminId, async (client) => {
      const res = await client.query(
        `UPDATE public.skattekonto_transactions
            SET journal_entry_id = $2, suggested_journal_entry_id = NULL, suggested_at = NULL
          WHERE id = $1 AND journal_entry_id IS NULL`,
        [rowId, entryId],
      )
      expect(res.rowCount).toBe(1)
      return auditRows(rowId, client)
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'UPDATE',
      company_id: companyId,
      user_id: adminId,
      actor_id: adminId,
      actor_type: 'user',
      actor_label: null,
    })
    expect(transitions(rows)).toEqual([{ entry: [null, entryId], ignored: [false, false] }])
    // write_audit_log keeps the whole row: the report names the event from it.
    expect(rows[0].new_state).toMatchObject({ transaktionsdatum: '2026-06-15', transaktionstext: 'Debiterad preliminärskatt', status: 'booked' })
    expect(Number(rows[0].new_state?.belopp_skatteverket)).toBe(-1000)
  })

  it('link, unlink, ignore and restore are each one row', async () => {
    const { adminId, entryId, rowId } = await companyWithRow()

    const rows = await withUserContext(adminId, async (client) => {
      await client.query(`UPDATE public.skattekonto_transactions SET journal_entry_id = $2 WHERE id = $1`, [rowId, entryId])
      await client.query(`UPDATE public.skattekonto_transactions SET journal_entry_id = NULL WHERE id = $1`, [rowId])
      await client.query(
        `UPDATE public.skattekonto_transactions SET is_ignored = true, suggested_journal_entry_id = NULL, suggested_at = NULL WHERE id = $1`,
        [rowId],
      )
      await client.query(`UPDATE public.skattekonto_transactions SET is_ignored = false WHERE id = $1`, [rowId])
      return auditRows(rowId, client)
    })

    expect(rows.map((r) => r.action)).toEqual(['UPDATE', 'UPDATE', 'UPDATE', 'UPDATE'])
    expect(rows.every((r) => r.user_id === adminId && r.actor_type === 'user')).toBe(true)
    // One transaction: the four rows share created_at, so their read order is
    // not defined. Compare them as a set.
    const canonical = (list: unknown[]) => list.map((t) => JSON.stringify(t)).sort()
    expect(canonical(transitions(rows))).toEqual(
      canonical([
        { entry: [null, entryId], ignored: [false, false] },
        { entry: [entryId, null], ignored: [false, false] },
        { entry: [null, null], ignored: [false, true] },
        { entry: [null, null], ignored: [true, false] },
      ]),
    )
  })

  it('the sync writes nothing: inserts, conflict updates of the mirror and proposals, and a no-op link', async () => {
    const { companyId, entryId, rowId } = await companyWithRow()

    await serviceRoleRequest(actingFor({ type: 'cron', label: 'skattekonto-sync' }), async (client) => {
      // The sync's upsert: every fetched row, conflict-updated in place.
      await client.query(
        `INSERT INTO public.skattekonto_transactions
           (company_id, dedup_key, transaktionsdatum, transaktionstext, belopp_skatteverket, status)
         SELECT company_id, dedup_key, transaktionsdatum, 'Debiterad preliminärskatt juni', belopp_skatteverket, 'booked'
           FROM public.skattekonto_transactions WHERE id = $1
         ON CONFLICT (company_id, dedup_key) DO UPDATE
           SET transaktionstext = EXCLUDED.transaktionstext, status = EXCLUDED.status, ranteberakningsdatum = '2026-06-20'`,
        [rowId],
      )
      // The proposal refresh.
      await client.query(
        `UPDATE public.skattekonto_transactions SET suggested_journal_entry_id = $2, suggested_at = now() WHERE id = $1`,
        [rowId, entryId],
      )
      await client.query(
        `UPDATE public.skattekonto_transactions SET suggested_journal_entry_id = NULL, suggested_at = NULL WHERE id = $1`,
        [rowId],
      )
    })
    // A new row arriving.
    const fresh = await insertSkattekontoRow(companyId)

    expect(await auditRows(rowId)).toEqual([])
    expect(await auditRows(fresh)).toEqual([])

    // Writing the link it already has, or the ignored flag it already has, is no change either.
    await getPool().query(`UPDATE public.skattekonto_transactions SET journal_entry_id = $2 WHERE id = $1`, [rowId, entryId])
    const afterLink = (await auditRows(rowId)).length
    await getPool().query(`UPDATE public.skattekonto_transactions SET journal_entry_id = $2, status = 'booked' WHERE id = $1`, [rowId, entryId])
    await getPool().query(`UPDATE public.skattekonto_transactions SET is_ignored = false WHERE id = $1`, [fresh])
    expect(await auditRows(rowId)).toHaveLength(afterLink)
    expect(afterLink).toBe(1)
    expect(await auditRows(fresh)).toEqual([])
  })

  it('an MCP connector linking for an admin names the admin and the connector', async () => {
    const { adminId, entryId, rowId } = await companyWithRow()

    await serviceRoleRequest(actingFor({ type: 'mcp_oauth', label: 'Claude (Anthropic)', userId: adminId }), async (client) => {
      const res = await client.query(`UPDATE public.skattekonto_transactions SET journal_entry_id = $2 WHERE id = $1`, [rowId, entryId])
      expect(res.rowCount).toBe(1)
    })

    const rows = await auditRows(rowId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: adminId, actor_id: adminId, actor_type: 'mcp_oauth', actor_label: 'Claude (Anthropic)' })
    expect(transitions(rows)).toEqual([{ entry: [null, entryId], ignored: [false, false] }])
  })

  it('a service-role write that names no person keeps the credential and no user (the row has no user_id)', async () => {
    const { rowId } = await companyWithRow()

    await serviceRoleRequest(actingFor({ type: 'api_key', label: 'Integration' }), (client) =>
      client.query(`UPDATE public.skattekonto_transactions SET is_ignored = true WHERE id = $1`, [rowId]),
    )
    await serviceRoleRequest({ 'user-agent': 'supabase-js-node' }, (client) =>
      client.query(`UPDATE public.skattekonto_transactions SET is_ignored = false WHERE id = $1`, [rowId]),
    )

    const rows = await auditRows(rowId)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ user_id: null, actor_id: null, actor_type: 'api_key', actor_label: 'Integration' })
    expect(rows[1]).toMatchObject({ user_id: null, actor_id: null, actor_type: 'user', actor_label: null })
  })

  it('deleting a linked draft unlinks the row (ON DELETE SET NULL) and logs it under the person who deleted it', async () => {
    const { ownerId, adminId, companyId, fiscalPeriodId, rowId } = await companyWithRow()
    const draftId = await insertDraftJournalEntry({ userId: ownerId, companyId, fiscalPeriodId, entryDate: '2026-06-15' })
    await getPool().query(`UPDATE public.skattekonto_transactions SET journal_entry_id = $2 WHERE id = $1`, [rowId, draftId])

    const client = await getPool().connect()
    let rows: AuditRow[]
    let linkAfter: string | null
    try {
      await client.query('BEGIN')
      // The admin as auth.uid() sees them (no role claim, so the writer-role
      // gates stay out of it); the BFL escape hatch every deletion door sets.
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: adminId })])
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [adminId])
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      const res = await client.query(`DELETE FROM public.journal_entries WHERE id = $1`, [draftId])
      expect(res.rowCount).toBe(1)
      linkAfter = (await client.query<{ journal_entry_id: string | null }>(
        `SELECT journal_entry_id FROM public.skattekonto_transactions WHERE id = $1`, [rowId],
      )).rows[0].journal_entry_id
      rows = await auditRows(rowId, client)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }

    expect(linkAfter).toBeNull()
    // The setup link (no session: no user), then the unlink by the admin.
    expect(transitions(rows)).toEqual([
      { entry: [null, draftId], ignored: [false, false] },
      { entry: [draftId, null], ignored: [false, false] },
    ])
    expect(rows[1]).toMatchObject({ user_id: adminId, actor_type: 'user' })
  })

  it('stays out of the sandbox teardown', async () => {
    const { entryId, rowId } = await companyWithRow()

    const client = await getPool().connect()
    let rows: AuditRow[]
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
      await client.query(`UPDATE public.skattekonto_transactions SET journal_entry_id = $2 WHERE id = $1`, [rowId, entryId])
      rows = await auditRows(rowId, client)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    expect(rows).toEqual([])
  })

  it('behandlingshistorik_sources hands the rows to the report', async () => {
    const { ownerId, companyId, fiscalPeriodId, entryId, rowId } = await companyWithRow()
    await getPool().query(`UPDATE public.skattekonto_transactions SET journal_entry_id = $2 WHERE id = $1`, [rowId, entryId])
    await getPool().query(`UPDATE public.skattekonto_transactions SET journal_entry_id = NULL WHERE id = $1`, [rowId])

    const audit = await withUserContext(ownerId, async (client) => {
      const { rows } = await client.query<{ audit: Array<{ table_name: string; record_id: string; action: string }> }>(
        `SELECT audit FROM public.behandlingshistorik_sources($1, $2, now() - interval '1 hour', now() + interval '1 hour', false)`,
        [companyId, fiscalPeriodId],
      )
      return rows[0].audit
    })

    expect(
      audit.filter((r) => r.table_name === 'skattekonto_transactions' && r.record_id === rowId).map((r) => r.action),
    ).toEqual(['UPDATE', 'UPDATE'])
  })
})
