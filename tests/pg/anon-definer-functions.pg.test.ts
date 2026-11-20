import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'
import { seedCompany, setActiveCompany } from '@/tests/pg/fixtures'

// Ratchet for 20261026210000_revoke_anon_execute_on_definer_readers.sql.
//
// Supabase lint 0028 (anon_security_definer_function_executable): every
// SECURITY DEFINER function in public that the anon role can EXECUTE is
// reachable without signing in as POST /rest/v1/rpc/<name>. The platform
// default ACL grants EXECUTE on each new function to anon, and the builtin
// default adds PUBLIC (anon is a member), so a function stays anon-callable
// unless its migration says `REVOKE EXECUTE ... FROM PUBLIC, anon`.
//
// definer-function-grants.pg.test.ts already holds the definer WRITERS to
// that. This file holds every non-trigger definer function to it, readers
// included, which is the advisor's own predicate. Trigger functions are out:
// PostgREST cannot call them (plpgsql refuses a direct call) and Postgres
// checks EXECUTE on a trigger function only at CREATE TRIGGER.
const DEFINER_FUNCTIONS_SQL = `
  SELECT p.oid::regprocedure::text AS fn,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND p.prokind = 'f'
     AND p.prorettype <> 'trigger'::regtype
   ORDER BY 1
`

// SECURITY DEFINER functions deliberately left callable by anon. There are
// none: an unauthenticated caller has no tenant, and every flow that runs
// before sign-in (public token pages, invite acceptance, the public v1 scope)
// goes through the service client on the server instead. If a function ever
// genuinely belongs here, add it with the anon call site that needs it.
const ANON_CALLABLE_ALLOWLIST: string[] = []

// The 13 production revoked (all keyed on auth.uid(), all with real
// authenticated callers: RLS policies, writer-role triggers, session-client
// RPCs). Each must keep authenticated and service_role.
const REVOKED_FROM_ANON = [
  'user_company_ids()',
  'user_team_ids()',
  'current_active_company_id()',
  'current_user_can_write()',
  'user_role_in_company(uuid)',
  'user_is_company_admin(uuid)',
  'user_is_team_admin(uuid)',
  'caller_can_write_company(uuid)',
  'caller_is_company_owner(uuid)',
  'caller_is_team_owner(uuid)',
  'list_invoice_delivery_summaries(uuid,uuid)',
  'latest_sent_invoice_delivery_document(uuid,uuid)',
  'export_invoice_delivery_evidence(uuid)',
]

interface GrantRow {
  exists: boolean
  anon_can: boolean | null
  public_can: boolean | null
  auth_can: boolean | null
  service_can: boolean | null
}

// Resolve through to_regprocedure() so a signature that drifted out of the
// schema fails on `exists` instead of silently returning NULL privileges.
// public_can reads the ACL itself: has_function_privilege() has no PUBLIC
// pseudo-role, and a leftover PUBLIC grant is exactly the trap.
async function grantsFor(signature: string): Promise<GrantRow> {
  const { rows } = await getPool().query<GrantRow>(
    `SELECT to_regprocedure($1) IS NOT NULL AS exists,
            has_function_privilege('anon', to_regprocedure($1)::oid, 'EXECUTE') AS anon_can,
            EXISTS (
              SELECT 1
                FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE p.oid = to_regprocedure($1)::oid
                 AND a.grantee = 0
                 AND a.privilege_type = 'EXECUTE'
            ) AS public_can,
            has_function_privilege('authenticated', to_regprocedure($1)::oid, 'EXECUTE') AS auth_can,
            has_function_privilege('service_role', to_regprocedure($1)::oid, 'EXECUTE') AS service_can`,
    [`public.${signature}`],
  )
  return rows[0]!
}

// Run `fn` as the anon DB role with the claims an anon-key PostgREST request
// carries: role 'anon' and no `sub`, so auth.uid() is NULL. Both GUC styles,
// for the reason runAsServiceRole() sets both. Always rolls back.
async function withAnonRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`)
    await client.query(`SELECT set_config('request.jwt.claim.role', 'anon', true)`)
    // Checked before the role switch: the claims are session GUCs, so the
    // answer is the same, and the check does not depend on anon's grants in
    // the auth schema of whatever image runs this.
    const claims = await client.query<{ uid: string | null }>(`SELECT auth.uid()::text AS uid`)
    await client.query('SET LOCAL ROLE anon')
    const who = await client.query<{ who: string }>(`SELECT current_user::text AS who`)
    if (claims.rows[0]?.uid !== null || who.rows[0]?.who !== 'anon') {
      throw new Error(
        `withAnonRole: auth.uid()=${claims.rows[0]?.uid ?? 'NULL'}, ` +
          `current_user=${who.rows[0]?.who ?? 'NULL'}; expected NULL/anon.`,
      )
    }
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('SECURITY DEFINER functions: none callable by anon.pg', () => {
  it('leaves no non-trigger SECURITY DEFINER function in public executable by anon', async () => {
    const { rows } = await getPool().query<{ fn: string; anon_can: boolean }>(
      DEFINER_FUNCTIONS_SQL,
    )

    // Sanity: the sweep has to match the schema's definer functions,
    // otherwise an empty offender list proves nothing.
    expect(rows.length).toBeGreaterThan(50)

    const offenders = rows
      .filter((r) => r.anon_can)
      .map((r) => r.fn)
      .filter((fn) => !ANON_CALLABLE_ALLOWLIST.includes(fn))

    // If this fails, the named function shipped without a revoke. Add
    // `REVOKE EXECUTE ON FUNCTION <sig> FROM PUBLIC, anon;` (PUBLIC included:
    // revoking anon alone is a no-op while PUBLIC holds EXECUTE) and GRANT
    // authenticated / service_role what their callers need.
    expect(offenders).toEqual([])
  })

  it.each(REVOKED_FROM_ANON)('%s: anon and PUBLIC revoked, authenticated and service_role kept', async (sig) => {
    const grants = await grantsFor(sig)
    expect(grants.exists).toBe(true)
    expect(grants.anon_can).toBe(false)
    expect(grants.public_can).toBe(false)
    expect(grants.auth_can).toBe(true)
    expect(grants.service_can).toBe(true)
  })
})

describe('anon role is refused, not answered.pg', () => {
  it('refuses a direct call to a revoked helper with 42501', async () => {
    const { companyId } = await seedCompany()

    // Before the revoke these two answered an empty set and false: the error
    // is the grant, not the body.
    await withAnonRole(async (client) => {
      await expect(client.query('SELECT public.user_company_ids()')).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/permission denied for function user_company_ids/),
      })
    })
    await withAnonRole(async (client) => {
      await expect(
        client.query('SELECT public.user_is_company_admin($1)', [companyId]),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/permission denied for function user_is_company_admin/),
      })
    })
    // This one also raises 42501 from its own body for a NULL auth.uid(), so
    // the message is what proves the grant refused it first.
    await withAnonRole(async (client) => {
      await expect(
        client.query('SELECT * FROM public.list_invoice_delivery_summaries($1, $2)', [
          companyId,
          randomUUID(),
        ]),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/permission denied for function list_invoice_delivery_summaries/),
      })
    })
  })

  it('refuses an anon read of a table whose RLS policy calls user_company_ids()', async () => {
    // company_settings_select applies to every role (no TO clause) and reads
    // user_company_ids(). Before the revoke anon got an empty 200 here; now
    // the policy itself is refused at executor start, before any row is read.
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id) VALUES ($1, $2)
       ON CONFLICT (company_id) DO NOTHING`,
      [userId, companyId],
    )

    await withAnonRole(async (client) => {
      await expect(
        client.query('SELECT company_id FROM public.company_settings WHERE company_id = $1', [
          companyId,
        ]),
      ).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/permission denied for function user_company_ids/),
      })
    })
  })

  it('still lets anon run the PostgREST pre-request hook', async () => {
    // pgrst.db_pre_request runs public.pre_request_statement_timeout() as the
    // request role on EVERY call, anon included. It is not SECURITY DEFINER,
    // so the migration's sweep must leave it alone: losing it would turn every
    // anon-key request (sign-in screens included) into an error.
    await withAnonRole(async (client) => {
      await expect(
        client.query('SELECT public.pre_request_statement_timeout()'),
      ).resolves.toBeDefined()
    })
  })
})

describe('signed-in and service callers keep working.pg', () => {
  it('answers a member through the helpers and the RLS they back', async () => {
    const { userId, companyId } = await seedCompany()
    // list_invoice_delivery_summaries requires the active company, and
    // current_active_company_id() reads the preference first.
    await setActiveCompany(userId, companyId)

    const result = await withUserContext(userId, async (client) => {
      const ids = await client.query<{ id: string }>('SELECT public.user_company_ids() AS id')
      const active = await client.query<{ id: string | null }>(
        'SELECT public.current_active_company_id() AS id',
      )
      const admin = await client.query<{ ok: boolean }>(
        'SELECT public.user_is_company_admin($1) AS ok',
        [companyId],
      )
      const writer = await client.query<{ ok: boolean }>(
        'SELECT public.caller_can_write_company($1) AS ok',
        [companyId],
      )
      const role = await client.query<{ role: string | null }>(
        'SELECT public.user_role_in_company($1) AS role',
        [companyId],
      )
      const visible = await client.query<{ id: string }>(
        'SELECT id FROM public.companies WHERE id = $1',
        [companyId],
      )
      const deliveries = await client.query(
        'SELECT * FROM public.list_invoice_delivery_summaries($1, $2)',
        [companyId, randomUUID()],
      )
      return {
        ids: ids.rows.map((r) => r.id),
        active: active.rows[0]!.id,
        admin: admin.rows[0]!.ok,
        writer: writer.rows[0]!.ok,
        role: role.rows[0]!.role,
        visible: visible.rows.length,
        deliveries: deliveries.rows.length,
      }
    })

    expect(result.ids).toContain(companyId)
    expect(result.active).toBe(companyId)
    expect(result.admin).toBe(true)
    expect(result.writer).toBe(true)
    expect(result.role).toBe('owner')
    expect(result.visible).toBe(1)
    expect(result.deliveries).toBe(0)
  })

  it('still lets the service role export delivery evidence', async () => {
    const { companyId } = await seedCompany()

    const rows = await runAsServiceRole(async (client) => {
      const res = await client.query(
        'SELECT * FROM public.export_invoice_delivery_evidence($1)',
        [companyId],
      )
      return res.rows
    })
    expect(rows).toEqual([])
  })
})
