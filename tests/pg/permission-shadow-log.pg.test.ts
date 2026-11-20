import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'
import { getClient, getPool, withUserContext } from './setup'

/**
 * The permission shadow log (migration 20261030100000).
 *
 * Locks in:
 *   - the service role writes, reads and deletes rows (the shadow's insert
 *     and the cleanup cron's sweep);
 *   - no session reaches it: RLS is on with no policy, and neither
 *     authenticated nor anon holds a privilege, so a member of the company
 *     can neither read nor write its rows;
 *   - the outcome and principal columns take only the values the
 *     application writes, and expected carries its reason;
 *   - it never blocks account erasure or sandbox teardown: deleting the user
 *     and the company succeeds, and the rows age out by the sweep;
 *   - created_at is indexed for the 7-day sweep.
 */

async function seedOwner() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

async function insertRow(params: {
  companyId: string
  userId: string
  createdAt?: string
  todayOutcome?: string
  expected?: boolean
  expectedReason?: string | null
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.permission_shadow_log
       (company_id, user_id, agent_identity_id, api_key_id, principal_kind, door, method,
        today_outcome, today_code, decide_outcome, decide_reason, permission, expected, expected_reason,
        created_at)
     VALUES ($1, $2, NULL, $3, 'agent', 'v1:invoices.create', 'POST',
             $4, NULL, 'stage', 'PROPOSE_STAGES', 'invoicing', $5, $6, coalesce($7::timestamptz, now()))
     RETURNING id`,
    [
      params.companyId,
      params.userId,
      randomUUID(),
      params.todayOutcome ?? 'allow',
      params.expected ?? false,
      params.expectedReason ?? null,
      params.createdAt ?? null,
    ],
  )
  return rows[0]!.id
}

describe('permission shadow log (pg)', () => {
  it('is for the service role alone: RLS on, no policy, no grant to a session role', async () => {
    const { rows: rls } = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.permission_shadow_log'::regclass`,
    )
    expect(rls[0]?.relrowsecurity).toBe(true)
    const { rows: policies } = await getPool().query(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'permission_shadow_log'`,
    )
    expect(policies).toHaveLength(0)

    const { rows: privileges } = await getPool().query<{ role: string; sel: boolean; ins: boolean; del: boolean }>(
      `SELECT r AS role,
              has_table_privilege(r, 'public.permission_shadow_log', 'SELECT') AS sel,
              has_table_privilege(r, 'public.permission_shadow_log', 'INSERT') AS ins,
              has_table_privilege(r, 'public.permission_shadow_log', 'DELETE') AS del
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r`,
    )
    const byRole = Object.fromEntries(privileges.map((p) => [p.role, p]))
    expect(byRole.anon).toMatchObject({ sel: false, ins: false, del: false })
    expect(byRole.authenticated).toMatchObject({ sel: false, ins: false, del: false })
    expect(byRole.service_role).toMatchObject({ sel: true, ins: true, del: true })
  })

  it('refuses a member of the company both reading and writing', async () => {
    const { userId, companyId } = await seedOwner()
    await insertRow({ companyId, userId })

    await expect(
      withUserContext(userId, (client) =>
        client.query(`SELECT id FROM public.permission_shadow_log WHERE company_id = $1`, [companyId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `INSERT INTO public.permission_shadow_log
             (company_id, user_id, principal_kind, door, today_outcome, decide_outcome, decide_reason, permission, expected)
           VALUES ($1, $2, 'person', 'session:x', 'allow', 'deny', 'PERMISSION_MISSING', 'settings', false)`,
          [companyId, userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('lets the service role write, read and sweep rows', async () => {
    const { userId, companyId } = await seedOwner()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE service_role')
      await client.query(
        `INSERT INTO public.permission_shadow_log
           (company_id, user_id, principal_kind, door, method, today_outcome, today_code,
            decide_outcome, decide_reason, permission, expected, expected_reason)
         VALUES ($1, $2, 'person', 'session:company.members.invite', 'POST', 'deny', 'HANDLER_FORBIDDEN',
                 'allow', 'PERSON_HAS_PERMISSION', 'members', true, 'HANDLER_CHECK')`,
        [companyId, userId],
      )
      const { rows } = await client.query(`SELECT door FROM public.permission_shadow_log WHERE company_id = $1`, [
        companyId,
      ])
      expect(rows).toEqual([{ door: 'session:company.members.invite' }])
      const swept = await client.query(
        `DELETE FROM public.permission_shadow_log WHERE company_id = $1 AND created_at < now() + interval '1 minute'`,
        [companyId],
      )
      expect(swept.rowCount).toBe(1)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('takes only the outcomes the application writes, and expected with its reason', async () => {
    const { userId, companyId } = await seedOwner()
    await expect(insertRow({ companyId, userId, todayOutcome: 'maybe' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow({ companyId, userId, expected: true, expectedReason: null })).rejects.toMatchObject({
      code: '23514',
    })
    await expect(insertRow({ companyId, userId, expected: false, expectedReason: 'HANDLER_CHECK' })).rejects.toMatchObject({
      code: '23514',
    })
    await expect(insertRow({ companyId, userId, expected: true, expectedReason: 'AGENT_NEVER_HOLDS' })).resolves.toBeTruthy()
  })

  it('never blocks account erasure or sandbox teardown', async () => {
    const { userId, companyId } = await seedOwner()
    const id = await insertRow({ companyId, userId })

    await getPool().query(`DELETE FROM public.companies WHERE id = $1`, [companyId])
    await getPool().query(`DELETE FROM auth.users WHERE id = $1`, [userId])

    // The row outlives them by design (no foreign key) and ages out with the sweep.
    const { rows } = await getPool().query(`SELECT id FROM public.permission_shadow_log WHERE id = $1`, [id])
    expect(rows).toHaveLength(1)
    await getPool().query(`DELETE FROM public.permission_shadow_log WHERE id = $1`, [id])
  })

  it('indexes created_at for the 7-day sweep', async () => {
    const { rows } = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'permission_shadow_log'`,
    )
    expect(rows.some((r) => /\(created_at\)/.test(r.indexdef))).toBe(true)
  })
})
