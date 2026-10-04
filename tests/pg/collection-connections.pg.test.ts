import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Collections connection (migration 20261004051856_collection_connections.sql):
 * one live row per company, an append-only event trail written by trigger,
 * the lifecycle guard (an ended connection stays ended and cannot end while
 * work is open at the provider), the behandlingshistorik audit trigger, the
 * grants, and the sandbox teardown.
 */

interface ConnectionSeed {
  companyId: string
  userId: string
  state?: string
  subStatus?: string | null
  route?: 'connect' | 'fake'
}

async function insertConnection(params: ConnectionSeed, client: Pick<PoolClient, 'query'> = getPool()): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.collection_connections
       (company_id, user_id, route, provider_ref, display_name, state, sub_status,
        catalogue_terms_version, consented_by, consented_at, ended_at)
     VALUES ($1, $2, $3, 'acme-inkasso', 'Acme Inkasso', $4, $5, 'v1', $2, now(),
             CASE WHEN $4 = 'disconnected' THEN now() END)
     RETURNING id`,
    [
      params.companyId,
      params.userId,
      params.route ?? 'connect',
      params.state ?? 'connecting',
      params.subStatus === undefined ? 'not_started' : params.subStatus,
    ],
  )
  return rows[0]!.id
}

async function events(connectionId: string) {
  const { rows } = await getPool().query<{
    from_state: string | null
    to_state: string
    sub_status: string | null
    health: string | null
    reason: string | null
    actor_user_id: string | null
  }>(
    `SELECT from_state, to_state, sub_status, health, reason, actor_user_id
       FROM public.collection_connection_events WHERE connection_id = $1 ORDER BY created_at, id`,
    [connectionId],
  )
  return rows
}

async function auditRows(connectionId: string) {
  const { rows } = await getPool().query<{ action: string; user_id: string | null; actor_type: string }>(
    `SELECT action, user_id, actor_type FROM public.audit_log
      WHERE table_name = 'collection_connections' AND record_id = $1 ORDER BY created_at, id`,
    [connectionId],
  )
  return rows
}

/** Run `fn` in a transaction that is always rolled back. */
async function inRollback(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('collection_connections (pg)', () => {
  it('lets members read their own company only, and write nothing', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const idA = await insertConnection(a)
    await insertConnection(b)

    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: member, role: 'member' })

    await withUserContext(member, async (client) => {
      const { rows } = await client.query<{ id: string }>(`SELECT id FROM public.collection_connections`)
      expect(rows.map((r) => r.id)).toEqual([idA])
      const trail = await client.query(`SELECT 1 FROM public.collection_connection_events`)
      expect(trail.rowCount).toBe(1)
      await expect(
        client.query(`UPDATE public.collection_connections SET minimum_amount = 5 WHERE id = $1`, [idA]),
      ).rejects.toThrow(/permission denied/)
    })
    await withUserContext(member, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.collection_connections (company_id, route, provider_ref, display_name, catalogue_terms_version, consented_by, consented_at)
           VALUES ($1, 'fake', 'x', 'x', 'v1', $2, now())`,
          [a.companyId, member],
        ),
      ).rejects.toThrow(/permission denied/)
    })
    await withUserContext(member, async (client) => {
      await expect(client.query(`DELETE FROM public.collection_connections WHERE id = $1`, [idA])).rejects.toThrow(
        /permission denied/,
      )
    })
  })

  it('grants: authenticated reads, service_role writes, anon nothing; the sync state is service-role only', async () => {
    const { rows } = await getPool().query<{ grantee: string; table_name: string; privilege_type: string }>(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public'
          AND table_name IN ('collection_connections', 'collection_connection_events', 'collection_sync_state')
          AND grantee IN ('anon', 'authenticated', 'service_role')`,
    )
    const of = (table: string, grantee: string) =>
      rows
        .filter((r) => r.table_name === table && r.grantee === grantee)
        .map((r) => r.privilege_type)
        .sort()
    for (const table of ['collection_connections', 'collection_connection_events']) {
      expect(of(table, 'authenticated')).toEqual(['SELECT'])
      expect(of(table, 'service_role')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
      expect(of(table, 'anon')).toEqual([])
    }
    expect(of('collection_sync_state', 'authenticated')).toEqual([])
    expect(of('collection_sync_state', 'anon')).toEqual([])
    expect(of('collection_sync_state', 'service_role')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])

    const state = await getPool().query(`SELECT id FROM public.collection_sync_state`)
    expect(state.rows).toEqual([{ id: 1 }])
    await expect(getPool().query(`INSERT INTO public.collection_sync_state (id) VALUES (2)`)).rejects.toThrow(/check/)

    const fn = await getPool().query<{ authenticated: boolean; anon: boolean }>(
      `SELECT has_function_privilege('authenticated', 'public.collection_obligation_counts(uuid)', 'EXECUTE') AS authenticated,
              has_function_privilege('anon', 'public.collection_obligation_counts(uuid)', 'EXECUTE') AS anon`,
    )
    expect(fn.rows[0]).toEqual({ authenticated: true, anon: false })
  })

  it('keeps one live connection per company; an ended one makes room for a new activation', async () => {
    const { companyId, userId } = await seedCompany()
    const first = await insertConnection({ companyId, userId })
    await expect(insertConnection({ companyId, userId })).rejects.toThrow(/collection_connections_one_live/)

    await getPool().query(
      `UPDATE public.collection_connections SET state = 'disconnected', sub_status = NULL, ended_at = now(), ended_by = $2
        WHERE id = $1`,
      [first, userId],
    )
    const second = await insertConnection({ companyId, userId })
    expect(second).not.toBe(first)
  })

  it('enforces the row shape', async () => {
    const { companyId, userId } = await seedCompany()
    await expect(insertConnection({ companyId, userId, state: 'active', subStatus: 'in_review' })).rejects.toThrow(
      /collection_connections_sub_status_shape/,
    )
    const id = await insertConnection({ companyId, userId })
    await expect(
      getPool().query(`UPDATE public.collection_connections SET late_interest_percent = 8 WHERE id = $1`, [id]),
    ).rejects.toThrow(/collection_connections_late_interest_pair/)
    await expect(
      getPool().query(`UPDATE public.collection_connections SET ladder_mode = 'staged' WHERE id = $1`, [id]),
    ).rejects.toThrow(/collection_connections_ladder_enabled_by/)
    await expect(
      getPool().query(`UPDATE public.collection_connections SET clearing_account = '168' WHERE id = $1`, [id]),
    ).rejects.toThrow(/clearing_account/)
    await expect(
      getPool().query(`UPDATE public.collection_connections SET state = 'disconnected', sub_status = NULL WHERE id = $1`, [id]),
    ).rejects.toThrow(/collection_connections_ended_shape/)
    await expect(
      getPool().query(`UPDATE public.collection_connections SET route = 'fake' WHERE id = $1`, [id]),
    ).rejects.toThrow(/keeps its company and route/)
  })

  it('writes one event per change of state, sub_status or health, in the same transaction', async () => {
    const { companyId, userId } = await seedCompany()
    const id = await insertConnection({ companyId, userId })
    expect(await events(id)).toEqual([
      { from_state: null, to_state: 'connecting', sub_status: 'not_started', health: null, reason: null, actor_user_id: userId },
    ])

    // Not a state change: no event.
    await getPool().query(
      `UPDATE public.collection_connections SET minimum_amount = 250, provider_status = 'raw', user_id = NULL WHERE id = $1`,
      [id],
    )
    expect(await events(id)).toHaveLength(1)

    // The system (user_id NULL) moves the activation on.
    await getPool().query(
      `UPDATE public.collection_connections SET sub_status = 'awaiting_terms', user_id = NULL WHERE id = $1`,
      [id],
    )
    await getPool().query(
      `UPDATE public.collection_connections SET health = 'degraded', health_cause = 'CONNECTOR_UNREACHABLE' WHERE id = $1`,
      [id],
    )
    await getPool().query(
      `UPDATE public.collection_connections SET state = 'active', sub_status = NULL, health = 'ok', activated_at = now() WHERE id = $1`,
      [id],
    )
    expect((await events(id)).slice(1)).toEqual([
      { from_state: 'connecting', to_state: 'connecting', sub_status: 'awaiting_terms', health: null, reason: null, actor_user_id: null },
      { from_state: 'connecting', to_state: 'connecting', sub_status: 'awaiting_terms', health: 'degraded', reason: 'CONNECTOR_UNREACHABLE', actor_user_id: null },
      { from_state: 'connecting', to_state: 'active', sub_status: null, health: 'ok', reason: null, actor_user_id: null },
    ])

    // Same transaction: a rolled-back change leaves no event behind.
    await inRollback(async (client) => {
      await client.query(`UPDATE public.collection_connections SET health = 'action_required' WHERE id = $1`, [id])
      const inside = await client.query(`SELECT 1 FROM public.collection_connection_events WHERE connection_id = $1`, [id])
      expect(inside.rowCount).toBe(5)
    })
    expect(await events(id)).toHaveLength(4)
  })

  it('keeps the event trail append-only, also under the teardown flag for a real company', async () => {
    const { companyId, userId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, false)`,
      [userId, companyId],
    )
    const id = await insertConnection({ companyId, userId })
    await expect(
      getPool().query(`UPDATE public.collection_connection_events SET reason = 'x' WHERE connection_id = $1`, [id]),
    ).rejects.toThrow(/append-only/)
    await expect(
      getPool().query(`DELETE FROM public.collection_connection_events WHERE connection_id = $1`, [id]),
    ).rejects.toThrow(/append-only/)
    await inRollback(async (client) => {
      await client.query(`SELECT set_config('gnubok.sandbox_cleanup', 'true', true)`)
      await client.query(`SELECT set_config('gnubok.allow_delete', 'true', true)`)
      await expect(
        client.query(`DELETE FROM public.collection_connection_events WHERE connection_id = $1`, [id]),
      ).rejects.toThrow(/append-only/)
    })
  })

  it('an ended connection stays ended', async () => {
    const { companyId, userId } = await seedCompany()
    const id = await insertConnection({ companyId, userId, state: 'disconnected', subStatus: null })
    await expect(
      getPool().query(
        `UPDATE public.collection_connections SET state = 'connecting', sub_status = 'not_started', ended_at = NULL WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/cannot be reopened/)
  })

  it('refuses to end a connection while collection_obligation_counts reports open work', async () => {
    const { companyId, userId } = await seedCompany()
    const id = await insertConnection({ companyId, userId, state: 'active', subStatus: null })
    const end = `UPDATE public.collection_connections SET state = 'disconnected', ended_at = now(), ended_by = $2 WHERE id = $1`

    const counts = await getPool().query(`SELECT * FROM public.collection_obligation_counts($1)`, [companyId])
    expect(counts.rows).toEqual([{ open_cases: 0, unbooked_collected_payments: 0, unbooked_settlements: 0 }])

    // The tables that hold obligations arrive with later migrations, each of
    // which replaces the function. Stand one in, inside a rolled-back
    // transaction, to prove the trigger reads it.
    for (const [cases, payments, settlements] of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]) {
      await inRollback(async (client) => {
        await client.query(
          `CREATE OR REPLACE FUNCTION public.collection_obligation_counts(p_company_id uuid)
           RETURNS TABLE (open_cases integer, unbooked_collected_payments integer, unbooked_settlements integer)
           LANGUAGE sql STABLE SET search_path = public AS $$ SELECT ${cases}, ${payments}, ${settlements} $$`,
        )
        await expect(client.query(end, [id, userId])).rejects.toThrow(/COLLECTIONS_DISCONNECT_BLOCKED/)
      })
    }

    await getPool().query(end, [id, userId])
    const { rows } = await getPool().query<{ state: string }>(`SELECT state FROM public.collection_connections WHERE id = $1`, [id])
    expect(rows[0]!.state).toBe('disconnected')
  })

  it('audits the rules and the lifecycle in behandlingshistorik, not the status poll', async () => {
    const { companyId, userId } = await seedCompany()
    const id = await insertConnection({ companyId, userId })
    expect(await auditRows(id)).toEqual([{ action: 'INSERT', user_id: userId, actor_type: 'user' }])

    // Status poll churn: not audited.
    await getPool().query(
      `UPDATE public.collection_connections
          SET provider_status = 'WaitingForApproval', sub_status = 'in_review', health = 'ok',
              last_success_at = now(), failures_in_row = 0, user_id = NULL
        WHERE id = $1`,
      [id],
    )
    expect(await auditRows(id)).toHaveLength(1)

    // A rule an admin changes: audited and attributed to them.
    const admin = await insertAuthUser()
    await getPool().query(
      `UPDATE public.collection_connections SET clearing_account = '1688', user_id = $2 WHERE id = $1`,
      [id, admin],
    )
    // Activation by the status poll: audited, no person behind it.
    await getPool().query(
      `UPDATE public.collection_connections SET state = 'active', sub_status = NULL, activated_at = now(), user_id = NULL WHERE id = $1`,
      [id],
    )
    // The poll's NULL is the system's, never the last admin's.
    expect(await auditRows(id)).toEqual([
      { action: 'INSERT', user_id: userId, actor_type: 'user' },
      { action: 'UPDATE', user_id: admin, actor_type: 'user' },
      { action: 'UPDATE', user_id: null, actor_type: 'system' },
    ])
  })

  it('tears down with a sandbox company and leaves a real one next to it alone', async () => {
    const sandbox = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, true)`,
      [sandbox.userId, sandbox.companyId],
    )
    const sandboxConnection = await insertConnection({ ...sandbox, route: 'fake' })
    await getPool().query(
      `UPDATE public.collection_connections SET sub_status = 'awaiting_terms', health = 'degraded', health_cause = 'x' WHERE id = $1`,
      [sandboxConnection],
    )

    const real = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, is_sandbox) VALUES ($1, $2, false)`,
      [real.userId, real.companyId],
    )
    const realConnection = await insertConnection(real)

    await getPool().query(`SELECT public.cleanup_sandbox_user($1)`, [sandbox.userId])

    const left = await getPool().query<{ n: string }>(
      `SELECT (SELECT count(*) FROM public.collection_connections WHERE company_id = $1)
            + (SELECT count(*) FROM public.collection_connection_events WHERE company_id = $1) AS n`,
      [sandbox.companyId],
    )
    expect(Number(left.rows[0]!.n)).toBe(0)
    expect(await events(realConnection)).toHaveLength(1)
    const user = await getPool().query(`SELECT 1 FROM auth.users WHERE id = $1`, [sandbox.userId])
    expect(user.rowCount).toBe(0)
  })
})
