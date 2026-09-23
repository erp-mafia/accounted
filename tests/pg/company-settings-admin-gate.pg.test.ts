import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real contract for the owner/admin gate on company_settings
// (20260422120000_fix_rls_role_gates_on_membership_tables, policy
// company_settings_update = user_is_company_admin(company_id)).
//
// Why this exists: PATCH /api/onboarding/state was gated with requireWrite
// (any non-viewer role) while the row is writable by owner/admin only. A
// `member` passed the route gate, could read the row, and the UPDATE then
// matched zero rows WITHOUT raising, which the route turned into a 500. The
// route now asks public.user_is_company_admin() through withRouteContext's
// requireAdmin. This file pins the two halves to each other: for every role,
// the predicate the route asks and the write the policy allows give the same
// answer. If someone changes the policy or the function alone, this fails.

type Role = 'owner' | 'admin' | 'member' | 'viewer'

async function seedSettings(companyId: string, ownerId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [ownerId, companyId],
  )
}

async function probe(userId: string, companyId: string) {
  return withUserContext(userId, async (client) => {
    const gate = await client.query<{ is_admin: boolean }>(
      `SELECT public.user_is_company_admin($1) AS is_admin`,
      [companyId],
    )
    const read = await client.query(
      `SELECT company_id FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    // The exact statement the route runs: UPDATE ... RETURNING.
    const write = await client.query(
      `UPDATE public.company_settings
          SET initial_setup_path = 'fresh',
              initial_setup_completed_at = NULL,
              initial_setup_dismissed_at = NULL
        WHERE company_id = $1
        RETURNING initial_setup_path`,
      [companyId],
    )
    return {
      isAdmin: gate.rows[0].is_admin,
      canRead: read.rows.length === 1,
      rowsWritten: write.rowCount ?? 0,
    }
  })
}

async function seedWithRole(role: Role) {
  const { userId: owner, companyId } = await seedCompany()
  await seedSettings(companyId, owner)
  if (role === 'owner') return { userId: owner, companyId }
  const userId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId, role })
  return { userId, companyId }
}

describe('company_settings: the route gate and the row policy are one definition', () => {
  it.each(['owner', 'admin'] as const)('%s: the predicate says yes and the write lands', async (role) => {
    const { userId, companyId } = await seedWithRole(role)
    expect(await probe(userId, companyId)).toEqual({ isAdmin: true, canRead: true, rowsWritten: 1 })
  })

  it('member: reads the row, the predicate says no, and the write matches zero rows without raising', async () => {
    const { userId, companyId } = await seedWithRole('member')
    // This is the production defect in one line: canRead true, rowsWritten 0,
    // no error. A route that only checked "non-viewer" got here and then
    // treated the empty RETURNING as an internal error.
    expect(await probe(userId, companyId)).toEqual({ isAdmin: false, canRead: true, rowsWritten: 0 })
  })

  it('viewer: reads the row, the predicate says no, the write matches zero rows', async () => {
    const { userId, companyId } = await seedWithRole('viewer')
    expect(await probe(userId, companyId)).toEqual({ isAdmin: false, canRead: true, rowsWritten: 0 })
  })

  it('a stranger sees nothing, is refused by the predicate and writes nothing', async () => {
    const { companyId } = await seedWithRole('owner')
    const stranger = await insertAuthUser()
    expect(await probe(stranger, companyId)).toEqual({ isAdmin: false, canRead: false, rowsWritten: 0 })
  })

  it("an admin of ANOTHER company is not an admin here: the predicate is per company, not per user", async () => {
    const { companyId } = await seedWithRole('owner')
    const other = await seedWithRole('admin')
    expect(await probe(other.userId, companyId)).toEqual({ isAdmin: false, canRead: false, rowsWritten: 0 })
  })

  it('the predicate stays callable by the authenticated role (the route calls it over PostgREST)', async () => {
    const { rows } = await getPool().query<{ ok: boolean }>(
      `SELECT has_function_privilege('authenticated', 'public.user_is_company_admin(uuid)', 'EXECUTE') AS ok`,
    )
    expect(rows[0].ok).toBe(true)
  })
})
