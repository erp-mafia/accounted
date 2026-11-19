import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getClient, getPool, runAsServiceRole, withUserContext } from '@/tests/pg/setup'

/**
 * replace_period_opening_balance_link with the acting user from the service
 * role (20261018200000). The v1 door and the MCP staged correction of an IB
 * run on the cookieless service-role client, where auth.uid() is NULL: the
 * owner/admin gate used to match nobody, so the relink always raised and the
 * year was left without a live IB. Pinned here:
 *
 *   - a service-role caller naming an owner or admin in p_user_id relinks;
 *   - the role required is unchanged: a member, a viewer, a non-member or no
 *     p_user_id at all is refused from the service role (42501);
 *   - p_user_id is ignored for every other caller: a signed-in member or
 *     outsider naming an owner is refused, a signed-in owner still relinks
 *     without it (the dashboard door);
 *   - the entry checks are unchanged: a draft, an entry of another year or of
 *     another company is refused;
 *   - anon cannot execute it.
 */

async function insertPostedOpeningBalance(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  entryDate?: string
  status?: 'posted' | 'draft'
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Ingående balanser', 'opening_balance', 'draft')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber, params.entryDate ?? '2026-01-01'],
  )
  for (const [account, debit, credit] of [
    ['1930', 5000, 0],
    ['2099', 0, 5000],
  ] as const) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [id, account, debit, credit],
    )
  }
  if ((params.status ?? 'posted') === 'posted') {
    await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
  }
  return id
}

interface World {
  ownerId: string
  companyId: string
  periodId: string
  oldEntry: string
  newEntry: string
}

/** A company whose year is linked to one posted IB, with a second posted IB ready to take its place. */
async function seed(): Promise<World> {
  const ownerId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  const periodId = await insertFiscalPeriod({ userId: ownerId, companyId })
  const oldEntry = await insertPostedOpeningBalance({ userId: ownerId, companyId, fiscalPeriodId: periodId, voucherNumber: 1 })
  // First-time link: OLD.opening_balances_set is false, so the immutability
  // trigger lets the FK and the flag be set together.
  await getPool().query(
    `UPDATE public.fiscal_periods SET opening_balance_entry_id = $2, opening_balances_set = true WHERE id = $1`,
    [periodId, oldEntry],
  )
  const newEntry = await insertPostedOpeningBalance({ userId: ownerId, companyId, fiscalPeriodId: periodId, voucherNumber: 2 })
  return { ownerId, companyId, periodId, oldEntry, newEntry }
}

async function userWithRole(companyId: string, role: 'admin' | 'member' | 'viewer'): Promise<string> {
  const userId = await insertAuthUser()
  await insertCompanyMember({ companyId, userId, role })
  return userId
}

async function pointer(periodId: string): Promise<{ entry: string | null; set: boolean }> {
  const { rows } = await getPool().query<{ entry: string | null; set: boolean }>(
    `SELECT opening_balance_entry_id::text AS entry, opening_balances_set AS set FROM public.fiscal_periods WHERE id = $1`,
    [periodId],
  )
  return rows[0]!
}

const RELINK = `SELECT public.replace_period_opening_balance_link($1, $2, $3, $4)`
const RELINK_3 = `SELECT public.replace_period_opening_balance_link($1, $2, $3)`

/** The RPC as the service role (PostgREST with the service key), naming `userId`. */
function asService(w: World, entryId: string, userId: string | null) {
  return runAsServiceRole((client) => client.query(RELINK, [w.companyId, w.periodId, entryId, userId]))
}

/** The error code a refused call raises. */
async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call
  } catch (err) {
    return (err as { code?: string }).code
  }
  throw new Error('expected the relink to be refused')
}

describe('replace_period_opening_balance_link: the acting user from the service role', () => {
  it('relinks from the service role for an owner and for an admin named in p_user_id', async () => {
    const w = await seed()
    await asService(w, w.newEntry, w.ownerId)
    expect(await pointer(w.periodId)).toEqual({ entry: w.newEntry, set: true })

    const admin = await userWithRole(w.companyId, 'admin')
    await asService(w, w.oldEntry, admin)
    expect(await pointer(w.periodId)).toEqual({ entry: w.oldEntry, set: true })
  })

  it('refuses the service role for a member, a viewer, a non-member and without p_user_id, leaving the year as it was', async () => {
    const w = await seed()
    const member = await userWithRole(w.companyId, 'member')
    const viewer = await userWithRole(w.companyId, 'viewer')
    const outsider = await insertAuthUser()
    for (const userId of [member, viewer, outsider, null]) {
      expect(await refusal(asService(w, w.newEntry, userId)), String(userId)).toBe('42501')
    }
    // The 3-argument call (the deploy-window fallback) is the same as no p_user_id.
    expect(await refusal(runAsServiceRole((c) => c.query(RELINK_3, [w.companyId, w.periodId, w.newEntry])))).toBe('42501')
    expect(await pointer(w.periodId)).toEqual({ entry: w.oldEntry, set: true })
  })

  it('ignores p_user_id for a signed-in caller: a member or an outsider naming the owner is refused', async () => {
    const w = await seed()
    const member = await userWithRole(w.companyId, 'member')
    const outsider = await insertAuthUser()
    for (const caller of [member, outsider]) {
      const code = await refusal(
        withUserContext(caller, (client) => client.query(RELINK, [w.companyId, w.periodId, w.newEntry, w.ownerId])),
      )
      expect(code, caller).toBe('42501')
    }
    expect(await pointer(w.periodId)).toEqual({ entry: w.oldEntry, set: true })
  })

  it('still relinks for a signed-in owner without p_user_id (the dashboard door)', async () => {
    const w = await seed()
    await withUserContext(w.ownerId, async (client) => {
      await client.query(RELINK_3, [w.companyId, w.periodId, w.newEntry])
      const { rows } = await client.query<{ entry: string; set: boolean }>(
        `SELECT opening_balance_entry_id::text AS entry, opening_balances_set AS set FROM public.fiscal_periods WHERE id = $1`,
        [w.periodId],
      )
      expect(rows[0]).toEqual({ entry: w.newEntry, set: true })
    })
  })

  it('still refuses a draft, an entry of another year and an entry of another company, for an owner on the service role', async () => {
    const w = await seed()
    const draft = await insertPostedOpeningBalance({
      userId: w.ownerId,
      companyId: w.companyId,
      fiscalPeriodId: w.periodId,
      voucherNumber: 3,
      status: 'draft',
    })
    const nextYear = await insertFiscalPeriod({
      userId: w.ownerId,
      companyId: w.companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })
    const otherYear = await insertPostedOpeningBalance({
      userId: w.ownerId,
      companyId: w.companyId,
      fiscalPeriodId: nextYear,
      voucherNumber: 1,
      entryDate: '2027-01-01',
    })
    const other = await seed()

    for (const entryId of [draft, otherYear, other.newEntry]) {
      await expect(asService(w, entryId, w.ownerId), entryId).rejects.toThrow(/is not a posted entry in period/)
    }
    expect(await pointer(w.periodId)).toEqual({ entry: w.oldEntry, set: true })
  })

  it('is executable by authenticated and service_role only, not by anon', async () => {
    const { rows } = await getPool().query<{ anon: boolean; authenticated: boolean; service_role: boolean; public_: boolean }>(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
              EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_
         FROM pg_proc p
        WHERE p.oid = 'public.replace_period_opening_balance_link(uuid, uuid, uuid, uuid)'::regprocedure`,
    )
    expect(rows).toEqual([{ anon: false, authenticated: true, service_role: true, public_: false }])
    // One signature only: PostgREST resolves the RPC without ambiguity.
    const overloads = await getPool().query(`SELECT 1 FROM pg_proc WHERE proname = 'replace_period_opening_balance_link'`)
    expect(overloads.rowCount).toBe(1)

    const w = await seed()
    const client: PoolClient = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL ROLE anon')
      expect(await refusal(client.query(RELINK, [w.companyId, w.periodId, w.newEntry, w.ownerId]))).toBe('42501')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
