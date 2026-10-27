import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany, setActiveCompany } from './fixtures'

// pg-real coverage for 20261027060817_rls_initplan_hot_tables (O08, run
// t1027). The migration only wraps auth.uid() as (SELECT auth.uid()) so the
// planner evaluates it once per statement instead of once per row. These
// tests pin that (1) every rewritten policy now has the initplan form and
// kept its command and roles, and (2) access is unchanged on a sample of
// the rewritten tables: own rows vs another user's rows, member vs
// non-member, and the role lists (viewer, member, owner) the policies carry.

const REWRITTEN: Array<{ table: string; policy: string; cmd: string; roles: string }> = [
  { table: 'company_inboxes', policy: 'company_inboxes_insert', cmd: 'INSERT', roles: '{public}' },
  { table: 'company_inboxes', policy: 'company_inboxes_update', cmd: 'UPDATE', roles: '{public}' },
  { table: 'notice_dismissals', policy: 'Users see their own notice dismissals', cmd: 'SELECT', roles: '{public}' },
  { table: 'notice_dismissals', policy: 'Users insert their own notice dismissals', cmd: 'INSERT', roles: '{public}' },
  { table: 'notice_dismissals', policy: 'Users update their own notice dismissals', cmd: 'UPDATE', roles: '{public}' },
  { table: 'notice_dismissals', policy: 'Users delete their own notice dismissals', cmd: 'DELETE', roles: '{public}' },
  { table: 'company_skills', policy: 'company_skills_read', cmd: 'SELECT', roles: '{authenticated}' },
  { table: 'company_skills', policy: 'company_skills_insert', cmd: 'INSERT', roles: '{authenticated}' },
  { table: 'company_skills', policy: 'company_skills_update', cmd: 'UPDATE', roles: '{authenticated}' },
  { table: 'company_skills', policy: 'company_skills_delete', cmd: 'DELETE', roles: '{authenticated}' },
  { table: 'idempotency_keys', policy: 'idempotency_keys_select_own', cmd: 'SELECT', roles: '{public}' },
  { table: 'account_reconciliation_settlements', policy: 'account_reconciliation_settlements_insert', cmd: 'INSERT', roles: '{public}' },
  { table: 'account_reconciliation_settlements', policy: 'account_reconciliation_settlements_update', cmd: 'UPDATE', roles: '{public}' },
  { table: 'account_reconciliations', policy: 'account_reconciliations_insert', cmd: 'INSERT', roles: '{public}' },
  { table: 'account_reconciliations', policy: 'account_reconciliations_update', cmd: 'UPDATE', roles: '{public}' },
  { table: 'profiles', policy: 'profiles_select', cmd: 'SELECT', roles: '{public}' },
  { table: 'profiles', policy: 'profiles_insert', cmd: 'INSERT', roles: '{public}' },
  { table: 'profiles', policy: 'profiles_update', cmd: 'UPDATE', roles: '{public}' },
  { table: 'expense_payout_batches', policy: 'expense_payout_batches_insert', cmd: 'INSERT', roles: '{public}' },
  { table: 'expense_payout_batches', policy: 'expense_payout_batches_update', cmd: 'UPDATE', roles: '{public}' },
  { table: 'expense_payout_batches', policy: 'expense_payout_batches_delete', cmd: 'DELETE', roles: '{public}' },
  { table: 'expense_claims', policy: 'expense_claims_insert', cmd: 'INSERT', roles: '{public}' },
  { table: 'expense_claims', policy: 'expense_claims_update', cmd: 'UPDATE', roles: '{public}' },
  { table: 'expense_claims', policy: 'expense_claims_delete', cmd: 'DELETE', roles: '{public}' },
  { table: 'invoice_deliveries', policy: 'invoice_deliveries_select', cmd: 'SELECT', roles: '{authenticated}' },
  { table: 'api_keys', policy: 'api_keys_insert', cmd: 'INSERT', roles: '{public}' },
  { table: 'api_keys', policy: 'api_keys_select', cmd: 'SELECT', roles: '{public}' },
  { table: 'user_preferences', policy: 'user_preferences_insert', cmd: 'INSERT', roles: '{public}' },
  { table: 'user_preferences', policy: 'user_preferences_select', cmd: 'SELECT', roles: '{public}' },
  { table: 'user_preferences', policy: 'user_preferences_update', cmd: 'UPDATE', roles: '{public}' },
]

/** auth.uid() calls left after removing the initplan-wrapped ones. */
function bareUidCalls(expr: string | null): number {
  if (!expr) return 0
  const stripped = expr.replace(/\(\s*SELECT\s+auth\.uid\(\)(\s+AS\s+uid)?\s*\)/gi, '')
  return (stripped.match(/auth\.uid\(\)/gi) ?? []).length
}

async function rowCount(userId: string, sql: string, params: unknown[]): Promise<number> {
  return withUserContext(userId, async (client) => (await client.query(sql, params)).rowCount ?? 0)
}

async function ensureProfile(userId: string): Promise<void> {
  await getPool().query(`INSERT INTO public.profiles (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [userId])
}

describe('O08 initplan form', () => {
  it('every rewritten policy calls auth.uid() only through (SELECT auth.uid()) and kept its command and roles', async () => {
    const { rows } = await getPool().query<{
      tablename: string
      policyname: string
      cmd: string
      roles: string
      qual: string | null
      with_check: string | null
    }>(
      `SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [[...new Set(REWRITTEN.map((p) => p.table))]],
    )
    for (const expected of REWRITTEN) {
      const live = rows.find((r) => r.tablename === expected.table && r.policyname === expected.policy)
      expect(live, `${expected.table}.${expected.policy} exists`).toBeDefined()
      expect(live!.cmd).toBe(expected.cmd)
      expect(live!.roles).toBe(expected.roles)
      expect(bareUidCalls(live!.qual), `${expected.policy} USING`).toBe(0)
      expect(bareUidCalls(live!.with_check), `${expected.policy} WITH CHECK`).toBe(0)
      // The rewrite must not have dropped the user check altogether.
      expect(`${live!.qual ?? ''} ${live!.with_check ?? ''}`).toMatch(/auth\.uid\(\)/)
    }
  })
})

describe('O08 access is unchanged', () => {
  it('profiles: a user reads and updates only their own profile', async () => {
    const a = await insertAuthUser()
    const b = await insertAuthUser()
    await ensureProfile(a)
    await ensureProfile(b)

    expect(await rowCount(a, `SELECT id FROM public.profiles WHERE id = $1`, [a])).toBe(1)
    expect(await rowCount(a, `SELECT id FROM public.profiles WHERE id = $1`, [b])).toBe(0)
    expect(await rowCount(a, `UPDATE public.profiles SET full_name = 'X' WHERE id = $1`, [a])).toBe(1)
    expect(await rowCount(a, `UPDATE public.profiles SET full_name = 'X' WHERE id = $1`, [b])).toBe(0)
  })

  it('user_preferences: a user reads and updates only their own row and cannot insert one for someone else', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await setActiveCompany(a.userId, a.companyId)
    await setActiveCompany(b.userId, b.companyId)

    expect(await rowCount(a.userId, `SELECT id FROM public.user_preferences WHERE user_id = $1`, [a.userId])).toBe(1)
    expect(await rowCount(a.userId, `SELECT id FROM public.user_preferences WHERE user_id = $1`, [b.userId])).toBe(0)
    expect(await rowCount(a.userId, `UPDATE public.user_preferences SET updated_at = now() WHERE user_id = $1`, [a.userId])).toBe(1)
    expect(await rowCount(a.userId, `UPDATE public.user_preferences SET updated_at = now() WHERE user_id = $1`, [b.userId])).toBe(0)

    const stranger = await insertAuthUser()
    await expect(
      rowCount(a.userId, `INSERT INTO public.user_preferences (user_id) VALUES ($1)`, [stranger]),
    ).rejects.toThrow(/row-level security/i)
  })

  it('notice_dismissals: own rows in own companies only', async () => {
    const owner = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId: member, role: 'member' })
    const outsider = await seedCompany()
    for (const userId of [owner.userId, member]) {
      await getPool().query(
        `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id) VALUES ($1, $2, 'o08-notice')`,
        [owner.companyId, userId],
      )
    }

    const sel = `SELECT user_id FROM public.notice_dismissals WHERE company_id = $1`
    expect(await rowCount(owner.userId, sel, [owner.companyId])).toBe(1)
    expect(await rowCount(member, sel, [owner.companyId])).toBe(1)
    expect(await rowCount(outsider.userId, sel, [owner.companyId])).toBe(0)

    expect(
      await rowCount(owner.userId, `DELETE FROM public.notice_dismissals WHERE company_id = $1 AND user_id = $2`, [
        owner.companyId,
        member,
      ]),
    ).toBe(0)
    expect(
      await rowCount(owner.userId, `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id) VALUES ($1, $2, 'o08-new')`, [
        owner.companyId,
        owner.userId,
      ]),
    ).toBe(1)
    await expect(
      rowCount(owner.userId, `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id) VALUES ($1, $2, 'o08-new')`, [
        owner.companyId,
        member,
      ]),
    ).rejects.toThrow(/row-level security/i)
    await expect(
      rowCount(outsider.userId, `INSERT INTO public.notice_dismissals (company_id, user_id, notice_id) VALUES ($1, $2, 'o08-new')`, [
        owner.companyId,
        outsider.userId,
      ]),
    ).rejects.toThrow(/row-level security/i)
  })

  it('expense_claims: owners and members write, viewers and other companies do not (role check)', async () => {
    const owner = await seedCompany()
    const member = await insertAuthUser()
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId: member, role: 'member' })
    await insertCompanyMember({ companyId: owner.companyId, userId: viewer, role: 'viewer' })
    const outsider = await seedCompany()
    const claimId = randomUUID()
    await getPool().query(
      `INSERT INTO public.expense_claims
         (id, company_id, user_id, claimant_name, description, expense_date, amount_sek, vat_sek, expense_account)
       VALUES ($1, $2, $3, 'Ägare', 'USB-hubb', '2026-08-25', 500, 100, '5410')`,
      [claimId, owner.companyId, owner.userId],
    )

    const upd = `UPDATE public.expense_claims SET description = 'Taxi' WHERE id = $1`
    expect(await rowCount(owner.userId, upd, [claimId])).toBe(1)
    expect(await rowCount(member, upd, [claimId])).toBe(1)
    expect(await rowCount(viewer, upd, [claimId])).toBe(0)
    expect(await rowCount(outsider.userId, upd, [claimId])).toBe(0)

    const ins = `INSERT INTO public.expense_claims
                   (company_id, user_id, claimant_name, description, expense_date, amount_sek, expense_account)
                 VALUES ($1, $2, 'Ägare', 'USB-hubb', '2026-08-25', 500, '5410')`
    expect(await rowCount(member, ins, [owner.companyId, member])).toBe(1)
    await expect(rowCount(viewer, ins, [owner.companyId, viewer])).rejects.toThrow(/row-level security/i)
    await expect(rowCount(outsider.userId, ins, [owner.companyId, outsider.userId])).rejects.toThrow(
      /row-level security/i,
    )

    const del = `DELETE FROM public.expense_claims WHERE id = $1`
    expect(await rowCount(viewer, del, [claimId])).toBe(0)
    expect(await rowCount(outsider.userId, del, [claimId])).toBe(0)
    expect(await rowCount(member, del, [claimId])).toBe(1)
  })

  it('company_inboxes: only owners and admins update the address (role check)', async () => {
    const owner = await seedCompany()
    const admin = await insertAuthUser()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId: admin, role: 'admin' })
    await insertCompanyMember({ companyId: owner.companyId, userId: member, role: 'member' })
    const outsider = await seedCompany()
    const existing = await getPool().query(`SELECT id FROM public.company_inboxes WHERE company_id = $1`, [
      owner.companyId,
    ])
    if (existing.rowCount === 0) {
      await getPool().query(
        `INSERT INTO public.company_inboxes (company_id, local_part, slug_seed) VALUES ($1, $2, 'o08')`,
        [owner.companyId, `o08-${randomUUID().slice(0, 8)}`],
      )
    }

    const upd = `UPDATE public.company_inboxes SET updated_at = now() WHERE company_id = $1`
    expect(await rowCount(owner.userId, upd, [owner.companyId])).toBeGreaterThan(0)
    expect(await rowCount(admin, upd, [owner.companyId])).toBeGreaterThan(0)
    expect(await rowCount(member, upd, [owner.companyId])).toBe(0)
    expect(await rowCount(outsider.userId, upd, [owner.companyId])).toBe(0)
  })

  it('idempotency_keys: a user sees only their own keys', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const key = randomUUID()
    await getPool().query(
      `INSERT INTO public.idempotency_keys (user_id, company_id, key, request_hash, state)
       VALUES ($1, $2, $3, 'h', 'in_progress')`,
      [a.userId, a.companyId, key],
    )
    const sel = `SELECT id FROM public.idempotency_keys WHERE key = $1`
    expect(await rowCount(a.userId, sel, [key])).toBe(1)
    expect(await rowCount(b.userId, sel, [key])).toBe(0)
  })
})
