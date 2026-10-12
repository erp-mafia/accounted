/**
 * pg-real test for the SECURITY DEFINER write-RPC tenant guards
 * (20260619130100_securitydefiner_write_rpc_tenant_guards.sql).
 *
 * Four SECURITY DEFINER write RPCs were EXECUTE-able by `authenticated` and so,
 * without an in-function tenant guard, an authenticated user could call them via
 * PostgREST with ANOTHER company's p_company_id. Two of them,
 * reserve/release_voucher_range, had no caller left and were dropped in
 * 20261012100300 (tests/pg/drop-dead-callable-functions.pg.test.ts); the two
 * covered here remain. The migration adds the canonical
 * claims-based guard (mirrors 20260615120000_link_voucher_rpcs_tenant_guard.sql):
 * for anon/authenticated callers, membership of p_company_id is required, else
 * RAISE 42501; service_role / no-claims callers bypass BY DESIGN (MCP / API-key /
 * migration / pg-harness paths whose company scoping happens elsewhere).
 *
 * bulk_book_transactions and match_batch_allocate are deliberately NOT guarded:
 * they already enforce membership in-function and return structured domain
 * errors (BULK_BOOK_UNAUTHORIZED / BATCH_UNAUTHORIZED) that routes, MCP tools,
 * and their existing pg tests branch on: see the migration header.
 *
 * What each case asserts:
 *   - cross-tenant (userA's session, companyB's id) → RAISE with SQLSTATE 42501.
 *   - own company (userA's session, companyA's id) → the guard does NOT fire;
 *     the call either succeeds or fails with a NON-42501 domain error; for both
 *     RPCs here the own-company call fully succeeds.
 *   - no-claims bare-pool cross-tenant → guard bypassed (no 42501), proving the
 *     MCP / service-role paths are unaffected.
 *
 * The role-claim simulation technique (set request.jwt.claims + SET LOCAL ROLE)
 * follows tests/pg/gl_lines_rpc_tenant_guard.pg.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

interface PgError extends Error {
  code?: string
}

/**
 * Run `sql` as an authenticated user session (request.jwt.claims role =
 * authenticated + SET LOCAL ROLE authenticated) in its own transaction, always
 * rolling back. Returns the thrown PgError (or null if it succeeded). A 42501
 * guard rejection aborts the transaction, so each probe gets a fresh one.
 */
async function callAsUser(
  userId: string,
  sql: string,
  params: unknown[],
): Promise<PgError | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    await client.query(sql, params)
    return null
  } catch (err) {
    return err as PgError
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

/**
 * Run `sql` on the bare superuser pool with NO request.jwt.claims: the trusted
 * bypass that migrations, this harness and the service-role / MCP API paths rely
 * on. Wrapped in a rolled-back transaction so writes don't persist. Returns the
 * thrown PgError or null.
 */
async function callBare(sql: string, params: unknown[]): Promise<PgError | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(sql, params)
    return null
  } catch (err) {
    return err as PgError
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

// Posted bank-account IB usable by mark_entry_as_opening_balance.
async function insertPostedManualIb(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-01-01', 'Ingående balanser 2026', 'manual', 'draft')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, Math.floor(Math.random() * 100000) + 1],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', 5000, 0),
            ($1, '2099', 0, 5000)`,
    [id],
  )
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
  return id
}

const MARK_OB = `SELECT public.mark_entry_as_opening_balance($1, $2)`
const ROTATE = `SELECT public.rotate_company_inbox($1)`

describe('SECURITY DEFINER write RPCs: tenant-isolation guard', () => {
  it('mark_entry_as_opening_balance: blocks cross-company, passes own, bypasses for no-claims', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const entryA = await insertPostedManualIb({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
    })

    // userA (member of A only) targeting companyB → 42501 before any work.
    const cross = await callAsUser(a.userId, MARK_OB, [b.companyId, entryA])
    expect(cross?.code).toBe('42501')

    // Own company, owner of A, valid posted manual IB → full success (no raise).
    const own = await callAsUser(a.userId, MARK_OB, [a.companyId, entryA])
    expect(own).toBeNull()

    // No-claims bare pool cross-referencing companyB with A's entry: guard
    // bypassed. It then raises a NON-guard domain error ("Journal entry not
    // found": the entry is not in companyB), proving the bypass is real.
    const bare = await callBare(MARK_OB, [b.companyId, entryA])
    expect(bare?.code).not.toBe('42501')
  })

  it('rotate_company_inbox: blocks cross-company, passes own, bypasses for no-claims', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    const cross = await callAsUser(a.userId, ROTATE, [b.companyId])
    expect(cross?.code).toBe('42501')

    // Own company, owner of A → succeeds (creates an active inbox row).
    const own = await callAsUser(a.userId, ROTATE, [a.companyId])
    expect(own).toBeNull()

    // No-claims bare pool cross-tenant → the NEW claims-based tenant guard is
    // bypassed (role is not anon/authenticated). rotate_company_inbox is only
    // ever called from a user session (auth.uid() present), so unlike the other
    // five it has no service-role caller; the pre-existing owner/admin check
    // (auth.uid() NULL → no membership) still raises 42501 here. Disambiguate by
    // message: the bypass is proven by the new guard's message NOT appearing.
    const bare = await callBare(ROTATE, [b.companyId])
    expect(bare?.message ?? '').not.toMatch(/caller is not a member of company/i)
  })
})
