import { randomUUID } from 'node:crypto'
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
import { ACTOR_HEADER, actorHeaderValue } from '@/lib/supabase/actor-header'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'

/**
 * Covers 20261031202000_audit_actor_from_request: a write made for someone
 * through a service-role client (an API key, MCP, the invoicer role's scoped
 * client) is audited under the person it was made for, and the credential,
 * not under the row's creator.
 *
 * Each request is presented the way PostgREST presents it: the service_role
 * role, its JWT claims, and the request's headers in request.headers. The
 * header value is built by the application's own encoder (actorHeaderValue),
 * so these tests also pin that what the server sends is what the database
 * reads. tests/tool-pg/audit-actor-header.tool.test.ts sends it through a
 * real PostgREST.
 */

interface AuditActor {
  action: string
  user_id: string | null
  actor_id: string | null
  actor_type: string | null
  actor_label: string | null
}

async function auditActors(table: string, recordId: string, action: string): Promise<AuditActor[]> {
  const { rows } = await getPool().query<AuditActor>(
    `SELECT action, user_id, actor_id, actor_type, actor_label FROM public.audit_log
      WHERE table_name = $1 AND record_id = $2 AND action = $3
      ORDER BY created_at, id`,
    [table, recordId, action],
  )
  return rows
}

/** A service-role request carrying these headers, as PostgREST runs it (committed). */
function serviceRoleRequest<T>(headers: Record<string, string>, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runAsServiceRole(async (client) => {
    await client.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify(headers)])
    return fn(client)
  })
}

/** The headers a service-role client sends inside runWithActor(actor). */
function actingFor(actor: CommitActor): Record<string, string> {
  return { [ACTOR_HEADER]: actorHeaderValue(actor)!, 'user-agent': 'supabase-js-node' }
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

describe('audit_log names the person a service-role request acts for (x-accounted-actor)', () => {
  it('an MCP connector moving the lock date for an admin who did not create the settings row names the admin and the connector', async () => {
    const { creatorId, adminId, companyId, settingsId } = await companyWithSettings()

    await serviceRoleRequest(actingFor({ type: 'mcp_oauth', label: 'Claude (Anthropic)', userId: adminId }), async (client) => {
      const res = await client.query(
        `UPDATE public.company_settings SET bookkeeping_locked_through = '2026-03-31' WHERE company_id = $1`,
        [companyId],
      )
      expect(res.rowCount).toBe(1)
    })

    expect(await auditActors('company_settings', settingsId, 'UPDATE')).toEqual([
      { action: 'UPDATE', user_id: adminId, actor_id: adminId, actor_type: 'mcp_oauth', actor_label: 'Claude (Anthropic)' },
    ])
    expect(creatorId).not.toBe(adminId)
  })

  it("an API key's DELETE of a colleague's supplier names the key's owner, with a Swedish key name intact", async () => {
    const { creatorId, adminId, companyId } = await companyWithSettings()
    const supplierId = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Leverantör AB')`,
      [supplierId, creatorId, companyId],
    )

    await serviceRoleRequest(actingFor({ type: 'api_key', label: 'Lagerskript åt Åsa 🚀', userId: adminId }), async (client) => {
      const res = await client.query(`DELETE FROM public.suppliers WHERE id = $1`, [supplierId])
      expect(res.rowCount).toBe(1)
    })

    expect(await auditActors('suppliers', supplierId, 'DELETE')).toEqual([
      { action: 'DELETE', user_id: adminId, actor_id: adminId, actor_type: 'api_key', actor_label: 'Lagerskript åt Åsa 🚀' },
    ])
  })

  it('a service account names its sponsor and the account', async () => {
    const { adminId, companyId, settingsId } = await companyWithSettings()

    await serviceRoleRequest(actingFor({ type: 'service_account', label: 'Nattlig synk', userId: adminId }), (client) =>
      client.query(`UPDATE public.company_settings SET bookkeeping_locked_through = '2026-04-30' WHERE company_id = $1`, [companyId]),
    )

    expect(await auditActors('company_settings', settingsId, 'UPDATE')).toEqual([
      { action: 'UPDATE', user_id: adminId, actor_id: adminId, actor_type: 'service_account', actor_label: 'Nattlig synk' },
    ])
  })

  it('a cron run names itself and keeps the row user_id: it acts for no one', async () => {
    const { creatorId, companyId, settingsId } = await companyWithSettings()

    await serviceRoleRequest(actingFor({ type: 'cron', label: 'bank.sync' }), (client) =>
      client.query(`UPDATE public.company_settings SET bookkeeping_locked_through = '2026-05-31' WHERE company_id = $1`, [companyId]),
    )

    expect(await auditActors('company_settings', settingsId, 'UPDATE')).toEqual([
      { action: 'UPDATE', user_id: creatorId, actor_id: creatorId, actor_type: 'cron', actor_label: 'bank.sync' },
    ])
  })

  it("write_sie_header_audit: an MCP COMMIT of a colleague's draft names the member who approved it", async () => {
    const { userId: creatorId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId: creatorId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId, 1250)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    // The RPC is called the way the engine calls it inside the scope: with
    // the actor pair, so its own GUCs name the credential.
    await serviceRoleRequest(actingFor({ type: 'mcp_oauth', label: 'Claude (Anthropic)', userId: memberId }), async (client) => {
      const committed = await client.query<{ voucher_number: number }>(
        `SELECT * FROM public.commit_journal_entry($1, $2, 'api_key', NULL, 'mcp_oauth', 'Claude (Anthropic)')`,
        [companyId, entryId],
      )
      expect(committed.rows[0]!.voucher_number).toBeGreaterThan(0)
    })

    expect(await auditActors('journal_entries', entryId, 'COMMIT')).toEqual([
      { action: 'COMMIT', user_id: memberId, actor_id: memberId, actor_type: 'mcp_oauth', actor_label: 'Claude (Anthropic)' },
    ])
  })

  it('the credential the RPC was handed wins over the header, the person comes from the header', async () => {
    const { userId: creatorId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId: creatorId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId, 400)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    await serviceRoleRequest(actingFor({ type: 'api_key', label: 'Integration', userId: memberId }), (client) =>
      client.query(`SELECT * FROM public.commit_journal_entry($1, $2, NULL, NULL, 'service_account', 'Lager')`, [companyId, entryId]),
    )

    expect(await auditActors('journal_entries', entryId, 'COMMIT')).toEqual([
      { action: 'COMMIT', user_id: memberId, actor_id: memberId, actor_type: 'service_account', actor_label: 'Lager' },
    ])
  })

  it('an RPC handed no actor takes the credential from the header too', async () => {
    const { userId: creatorId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId: creatorId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryId, 300)
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })

    await serviceRoleRequest(actingFor({ type: 'api_key', label: 'Integration', userId: memberId }), (client) =>
      client.query(`SELECT * FROM public.commit_journal_entry($1, $2)`, [companyId, entryId]),
    )

    expect(await auditActors('journal_entries', entryId, 'COMMIT')).toEqual([
      { action: 'COMMIT', user_id: memberId, actor_id: memberId, actor_type: 'api_key', actor_label: 'Integration' },
    ])
  })

  it("a signed-in user's request cannot name someone else: the session decides", async () => {
    const { adminId, creatorId, companyId, settingsId } = await companyWithSettings()

    await withUserContext(adminId, async (client) => {
      await client.query(`SELECT set_config('request.headers', $1, true)`, [
        JSON.stringify(actingFor({ type: 'service_account', label: 'Förfalskad', userId: creatorId })),
      ])
      await client.query(
        `UPDATE public.company_settings SET bookkeeping_locked_through = '2026-06-30' WHERE company_id = $1`,
        [companyId],
      )
      await client.query('RESET ROLE')
      const { rows } = await client.query<AuditActor>(
        `SELECT action, user_id, actor_id, actor_type, actor_label FROM public.audit_log
          WHERE table_name = 'company_settings' AND record_id = $1 AND action = 'UPDATE'`,
        [settingsId],
      )
      expect(rows).toEqual([{ action: 'UPDATE', user_id: adminId, actor_id: adminId, actor_type: 'user', actor_label: null }])
    })
  })

  it('only the service role may name someone: a request without a session in any other role is ignored', async () => {
    const { creatorId, adminId, companyId, settingsId } = await companyWithSettings()

    // A direct connection (a worker, a migration): no session, and the role
    // PostgREST would have switched to is not service_role. Without the role
    // gate in service_request_actor the header would name the admin here.
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.headers', $1, true)`, [
        JSON.stringify(actingFor({ type: 'api_key', label: 'Integration', userId: adminId })),
      ])
      await client.query(
        `UPDATE public.company_settings SET bookkeeping_locked_through = '2026-08-31' WHERE company_id = $1`,
        [companyId],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }

    expect(await auditActors('company_settings', settingsId, 'UPDATE')).toEqual([
      { action: 'UPDATE', user_id: creatorId, actor_id: creatorId, actor_type: 'user', actor_label: null },
    ])
  })

  it('an unreadable header never blocks the write: nobody is named and the row user_id stands in, as before', async () => {
    const { creatorId, companyId, settingsId } = await companyWithSettings()

    const bad = ['{"type":"api_key","user_id":', '"just a string"', '{"type":"root","user_id":"not-a-uuid","label":"x"}']
    const lockDates = ['2026-01-31', '2026-02-28', '2026-03-31']
    for (const [i, value] of bad.entries()) {
      await serviceRoleRequest({ [ACTOR_HEADER]: value }, (client) =>
        client.query(`UPDATE public.company_settings SET bookkeeping_locked_through = $2 WHERE company_id = $1`, [companyId, lockDates[i]]),
      )
    }

    const rows = await auditActors('company_settings', settingsId, 'UPDATE')
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row).toEqual({ action: 'UPDATE', user_id: creatorId, actor_id: creatorId, actor_type: 'user', actor_label: null })
    }
  })

  it('a service-role request without the header is unchanged: the row user_id stands in', async () => {
    const { creatorId, companyId, settingsId } = await companyWithSettings()

    await serviceRoleRequest({ 'user-agent': 'cron' }, (client) =>
      client.query(`UPDATE public.company_settings SET bookkeeping_locked_through = '2026-07-31' WHERE company_id = $1`, [companyId]),
    )

    expect(await auditActors('company_settings', settingsId, 'UPDATE')).toEqual([
      { action: 'UPDATE', user_id: creatorId, actor_id: creatorId, actor_type: 'user', actor_label: null },
    ])
  })

  it('service_request_actor is not callable by anon or authenticated', async () => {
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service_role: boolean }>(
      `SELECT has_function_privilege('anon', 'public.service_request_actor()', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.service_request_actor()', 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', 'public.service_request_actor()', 'EXECUTE') AS service_role`,
    )
    expect(rows[0]).toEqual({ anon: false, authenticated: false, service_role: true })
  })
})
