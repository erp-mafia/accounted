/**
 * pg-real test for the GL-line read-RPC tenant guard
 * (20260611120000_gl_lines_rpc_tenant_guard.sql).
 *
 * get_unlinked_gl_lines and get_account_gl_lines_for_matching are SECURITY
 * DEFINER and EXECUTE-able by anon/authenticated, so without the guard any
 * authenticated user could call them directly with another company's id and read
 * its general ledger. The guard enforces membership for anon/authenticated while
 * leaving service_role and direct/superuser access (this harness, migrations,
 * the reconciliation cron) untouched.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

async function insertPostedJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate: string
  voucherNumber: number
  amount?: number
}): Promise<string> {
  const id = randomUUID()
  const amount = params.amount ?? 1500
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', $6, 'Bank tx', 'bank_transaction', 'posted')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber, params.entryDate],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, 0),
            ($1, '2091', 0, $2)`,
    [id, amount],
  )
  return id
}

const UNLINKED = `SELECT journal_entry_id FROM public.get_unlinked_gl_lines($1)`
const MATCHING = `SELECT journal_entry_id FROM public.get_account_gl_lines_for_matching($1, '1930', NULL, NULL, true)`

describe('GL-line read RPCs: tenant-isolation guard', () => {
  it('lets a member read its own company but blocks an authenticated non-member', async () => {
    const a = await seedCompany() // userA is owner-member of companyA
    const b = await seedCompany() // userB belongs to companyB only
    const entryA = await insertPostedJournalEntry({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
      entryDate: '2026-03-15',
      voucherNumber: 1,
    })

    // Direct / superuser connection (no JWT role): the trusted bypass that this
    // harness, migrations and the service-role cron rely on. Data is visible.
    const bare = await getPool().query(UNLINKED, [a.companyId])
    expect(bare.rows.map((r) => r.journal_entry_id)).toContain(entryA)

    // A member of company A sees A's line through both RPCs.
    await withUserContext(a.userId, async (client) => {
      const u = await client.query(UNLINKED, [a.companyId])
      expect(u.rows.map((r) => r.journal_entry_id)).toContain(entryA)
      const m = await client.query(MATCHING, [a.companyId])
      expect(m.rows.map((r) => r.journal_entry_id)).toContain(entryA)
    })

    // A member of company B probing company A gets nothing: the cross-tenant
    // read that SECURITY DEFINER + anon/authenticated EXECUTE used to allow.
    await withUserContext(b.userId, async (client) => {
      const u = await client.query(UNLINKED, [a.companyId])
      expect(u.rows).toHaveLength(0)
      const m = await client.query(MATCHING, [a.companyId])
      expect(m.rows).toHaveLength(0)
    })
  })

  it('rejects an anon (unauthenticated) caller outright: EXECUTE revoked from anon + PUBLIC', async () => {
    const a = await seedCompany()
    await insertPostedJournalEntry({
      userId: a.userId,
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
      entryDate: '2026-03-15',
      voucherNumber: 1,
    })

    // Each probe runs in its own transaction: a permission-denied error aborts
    // the transaction, so the two can't share one. anon has no EXECUTE (revoked
    // from its own grant AND from PUBLIC, of which anon is a member), so the call
    // is rejected at the privilege layer: defense in depth on top of the
    // in-function tenant guard.
    const callAsAnon = async (sql: string): Promise<void> => {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`)
        await client.query('SET LOCAL ROLE anon')
        await client.query(sql, [a.companyId])
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }

    await expect(callAsAnon(UNLINKED)).rejects.toThrow(/permission denied/i)
    await expect(callAsAnon(MATCHING)).rejects.toThrow(/permission denied/i)
  })
})
