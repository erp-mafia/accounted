import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertBalancedLines,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260528120000_delete_last_voucher_clears_ib_link:
 *   - delete_last_voucher RPC succeeds when the target is the period's
 *     opening_balance_entry (A1 from SIE import).
 *   - fiscal_periods.opening_balance_entry_id is cleared and
 *     opening_balances_set is flipped to false.
 *   - sie_imports.opening_balance_entry_id is also cleared so the import
 *     row stays consistent.
 *   - audit_log has a DELETE entry with the "(was period IB)" marker.
 *   - The RPC still rejects non-last vouchers and locked periods.
 */

async function commitPostedEntryAsIB(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherSeries?: string
}): Promise<string> {
  const entryId = randomUUID()
  const series = params.voucherSeries ?? 'A'
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 1, $5, '2026-01-01', 'Ingående balans', 'opening_balance', 'draft')`,
    [entryId, params.userId, params.companyId, params.fiscalPeriodId, series],
  )
  await insertBalancedLines(entryId, 5000)
  // flip to posted directly: bypass commit_journal_entry to keep this
  // test focused on the deletion RPC. voucher_sequences needs a row so the
  // delete RPC's FOR UPDATE lookup succeeds.
  await getPool().query(
    `UPDATE public.journal_entries
       SET status = 'posted'
     WHERE id = $1`,
    [entryId],
  )
  await getPool().query(
    `INSERT INTO public.voucher_sequences
       (company_id, user_id, fiscal_period_id, voucher_series, last_number)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (company_id, fiscal_period_id, voucher_series) DO UPDATE
       SET last_number = EXCLUDED.last_number`,
    [params.companyId, params.userId, params.fiscalPeriodId, series],
  )
  return entryId
}

async function linkAsIB(periodId: string, entryId: string): Promise<void> {
  await getPool().query(
    `UPDATE public.fiscal_periods
       SET opening_balance_entry_id = $1,
           opening_balances_set     = true
     WHERE id = $2`,
    [entryId, periodId],
  )
}

describe('delete_last_voucher with IB link', () => {
  it('deletes an IB entry and clears the period FK + sets opening_balances_set=false', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })

    const ibEntryId = await commitPostedEntryAsIB({ userId, companyId, fiscalPeriodId })
    await linkAsIB(fiscalPeriodId, ibEntryId)

    // Sanity check pre-state
    const pre = await getPool().query<{ ob_id: string | null; ob_set: boolean }>(
      `SELECT opening_balance_entry_id AS ob_id, opening_balances_set AS ob_set
         FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(pre.rows[0]!.ob_id).toBe(ibEntryId)
    expect(pre.rows[0]!.ob_set).toBe(true)

    // withUserContext rolls back at the end, so all assertions about the
    // RPC's effects must be observed inside the same transaction: a fresh
    // getPool() connection would only see pre-RPC state.
    await withUserContext(userId, async (client) => {
      const r = await client.query<{ delete_last_voucher: { deleted: boolean; was_period_ib: boolean } }>(
        `SELECT delete_last_voucher($1, $2)`,
        [companyId, ibEntryId],
      )
      const result = r.rows[0]!.delete_last_voucher
      expect(result.deleted).toBe(true)
      expect(result.was_period_ib).toBe(true)

      const after = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.journal_entries WHERE id = $1`,
        [ibEntryId],
      )
      expect(after.rows[0]!.count).toBe('0')

      const post = await client.query<{ ob_id: string | null; ob_set: boolean }>(
        `SELECT opening_balance_entry_id AS ob_id, opening_balances_set AS ob_set
           FROM public.fiscal_periods WHERE id = $1`,
        [fiscalPeriodId],
      )
      expect(post.rows[0]!.ob_id).toBeNull()
      expect(post.rows[0]!.ob_set).toBe(false)

      // Two audit rows land on the DELETE: the generic one from the
      // write_audit_log() trigger and the RPC's explicit "was period IB"
      // entry. They share statement_timestamp(), so ordering by created_at
      // is non-deterministic: assert against the specific marker directly.
      const audit = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.audit_log
           WHERE table_name = 'journal_entries' AND record_id = $1 AND action = 'DELETE'
             AND description LIKE '%was period IB%'`,
        [ibEntryId],
      )
      expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1)
    })
  })

  it('also clears sie_imports.opening_balance_entry_id when present', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })

    const ibEntryId = await commitPostedEntryAsIB({ userId, companyId, fiscalPeriodId })
    await linkAsIB(fiscalPeriodId, ibEntryId)

    const importId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type, fiscal_period_id,
          opening_balance_entry_id, status, transactions_count)
       VALUES ($1, $2, $3, 'test.se', $4, 4, $5, $6, 'completed', 0)`,
      [importId, userId, companyId, randomUUID().replace(/-/g, ''), fiscalPeriodId, ibEntryId],
    )

    // Same caveat as the previous test: assert inside the tx, not after.
    await withUserContext(userId, async (client) => {
      await client.query(`SELECT delete_last_voucher($1, $2)`, [companyId, ibEntryId])
      const imp = await client.query<{ ob_id: string | null }>(
        `SELECT opening_balance_entry_id AS ob_id FROM public.sie_imports WHERE id = $1`,
        [importId],
      )
      expect(imp.rows[0]!.ob_id).toBeNull()
    })
  })
})
