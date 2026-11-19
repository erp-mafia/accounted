import { describe, it, expect } from 'vitest'
import { getClient, getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, setActiveCompany } from './fixtures'

// Validates migration 20261012101000_resolve_active_company_role: both
// resolvers also return the caller's role in the company they resolve, so
// the write guard (lib/auth/require-write.ts) needs no second
// company_members read.
//   1. The role is the one on the SAME membership row as company_id, for
//      every role, on the preference path and on the fallback path.
//   2. No company, no role: a non-member, a user whose only companies are
//      archived, and a non-owner frozen by the seat gate all get NULL.
//   3. Archived companies are skipped exactly as before.
//   4. NULL auth.uid() still returns zero rows; company_id still agrees with
//      current_active_company_id(); grants, SECURITY DEFINER and the pinned
//      search_path are what they were.

type Role = 'owner' | 'admin' | 'member' | 'viewer'
type Row = { company_id: string | null; role: string | null; used_fallback: boolean }

const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer']
const GRACE_DAYS = 20

const RESOLVERS = {
  resolve_active_company: `SELECT r.company_id::text AS company_id, r.role, r.used_fallback
                           FROM public.resolve_active_company() r`,
  resolve_active_company_gated: `SELECT r.company_id::text AS company_id, r.role, r.used_fallback
                                 FROM public.resolve_active_company_gated(${GRACE_DAYS}) r`,
} as const

async function resolveAs(userId: string, sql: string): Promise<Row[]> {
  return withUserContext(userId, async (client) => (await client.query<Row>(sql)).rows)
}

/** A new company where the user holds `role` (someone else owns it unless the user does). */
async function memberOf(userId: string, role: Role): Promise<string> {
  const ownerId = role === 'owner' ? userId : await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  if (role !== 'owner') await insertCompanyMember({ companyId, userId, role })
  return companyId
}

describe.each(Object.entries(RESOLVERS))('%s() role column', (_name, sql) => {
  it.each(ROLES)('returns %s for a member with that role in the preferred company', async (role) => {
    const userId = await insertAuthUser()
    const companyId = await memberOf(userId, role)
    await setActiveCompany(userId, companyId)

    const rows = await resolveAs(userId, sql)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ company_id: companyId, role, used_fallback: false })
  })

  it.each(ROLES)('returns %s on the fallback path (no preference row)', async (role) => {
    const userId = await insertAuthUser()
    const companyId = await memberOf(userId, role)

    const rows = await resolveAs(userId, sql)
    expect(rows[0]).toMatchObject({ company_id: companyId, role, used_fallback: true })
  })

  it('pairs the role with the preferred company, not with the first membership', async () => {
    const userId = await insertAuthUser()
    // Owner of the earliest membership (the fallback), viewer in the preferred one.
    const owned = await memberOf(userId, 'owner')
    await getPool().query(
      `UPDATE public.company_members SET created_at = now() - interval '1 day'
       WHERE company_id = $1 AND user_id = $2`,
      [owned, userId],
    )
    const viewing = await memberOf(userId, 'viewer')
    await setActiveCompany(userId, viewing)

    const rows = await resolveAs(userId, sql)
    expect(rows[0]).toMatchObject({ company_id: viewing, role: 'viewer', used_fallback: false })
  })

  it('returns no role for a non-member, whatever the preference points at', async () => {
    const userId = await insertAuthUser()
    const foreign = await memberOf(await insertAuthUser(), 'owner')
    await setActiveCompany(userId, foreign)

    const rows = await resolveAs(userId, sql)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ company_id: null, role: null, used_fallback: true })
  })

  it('skips an archived preferred company and takes the role from the live fallback', async () => {
    const userId = await insertAuthUser()
    const archived = await memberOf(userId, 'viewer')
    const alive = await memberOf(userId, 'admin')
    await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [archived])
    await setActiveCompany(userId, archived)

    const rows = await resolveAs(userId, sql)
    expect(rows[0]).toMatchObject({ company_id: alive, role: 'admin', used_fallback: true })
  })

  it('returns no role when every membership is in an archived company', async () => {
    const userId = await insertAuthUser()
    const archived = await memberOf(userId, 'owner')
    await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [archived])
    await setActiveCompany(userId, archived)

    const rows = await resolveAs(userId, sql)
    expect(rows[0]).toMatchObject({ company_id: null, role: null })
  })

  it('returns zero rows when auth.uid() is NULL (service-role clients)', async () => {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: 'authenticated' }),
      ])
      await client.query('SET LOCAL ROLE authenticated')
      expect((await client.query(sql)).rows).toHaveLength(0)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('still agrees with current_active_company_id() on the company', async () => {
    const userId = await insertAuthUser()
    await memberOf(userId, 'member')
    await setActiveCompany(userId, await memberOf(await insertAuthUser(), 'owner')) // stale

    await withUserContext(userId, async (client) => {
      const res = await client.query<{ agrees: boolean }>(
        `SELECT (SELECT r.company_id::text FROM (${sql}) r)
                IS NOT DISTINCT FROM public.current_active_company_id()::text AS agrees`,
      )
      expect(res.rows[0].agrees).toBe(true)
    })
  })
})

describe('resolve_active_company_gated() role under the seat gate', () => {
  async function freeze(companyId: string): Promise<void> {
    await getPool().query(
      `UPDATE public.capability_grants SET expires_at = now() - interval '25 days' WHERE company_id = $1`,
      [companyId],
    )
  }

  it('a frozen non-owner gets no company and no role', async () => {
    const userId = await insertAuthUser()
    const companyId = await memberOf(userId, 'member')
    await freeze(companyId)
    await setActiveCompany(userId, companyId)

    const rows = await resolveAs(userId, RESOLVERS.resolve_active_company_gated)
    expect(rows[0]).toMatchObject({ company_id: null, role: null })
  })

  it('a frozen non-owner falls back to an accessible company with that membership role', async () => {
    const userId = await insertAuthUser()
    const frozen = await memberOf(userId, 'admin')
    await freeze(frozen)
    const owned = await memberOf(userId, 'owner')
    await setActiveCompany(userId, frozen)

    const rows = await resolveAs(userId, RESOLVERS.resolve_active_company_gated)
    expect(rows[0]).toMatchObject({ company_id: owned, role: 'owner', used_fallback: true })
  })

  it('an owner of a frozen company still resolves it as owner', async () => {
    const userId = await insertAuthUser()
    const companyId = await memberOf(userId, 'owner')
    await freeze(companyId)
    await setActiveCompany(userId, companyId)

    const rows = await resolveAs(userId, RESOLVERS.resolve_active_company_gated)
    expect(rows[0]).toMatchObject({ company_id: companyId, role: 'owner', used_fallback: false })
  })
})

describe('resolver definitions after the drop and re-create', () => {
  it.each(['public.resolve_active_company()', 'public.resolve_active_company_gated(integer)'])(
    '%s keeps its grants, SECURITY DEFINER and pinned search_path',
    async (signature) => {
      const res = await getPool().query<{
        anon_can: boolean
        authenticated_can: boolean
        service_role_can: boolean
        public_grant: boolean
        secdef: boolean
        volatility: string
        config: string[] | null
      }>(
        `SELECT
           has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon_can,
           has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated_can,
           has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') AS service_role_can,
           EXISTS (
             SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0
           ) AS public_grant,
           p.prosecdef AS secdef,
           p.provolatile::text AS volatility,
           p.proconfig AS config
         FROM pg_proc p
         WHERE p.oid = $1::regprocedure`,
        [signature],
      )
      expect(res.rows[0]).toEqual({
        anon_can: false,
        authenticated_can: true,
        service_role_can: true,
        public_grant: false,
        secdef: true,
        volatility: 's',
        config: ['search_path=public'],
      })
    },
  )
})
