import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getClient, getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260613120000_mark_entry_as_opening_balance:
 *   - the enforce_journal_entry_immutability carve-out (GUC-gated, source_type
 *     manual/import -> opening_balance only), and
 *   - the mark_entry_as_opening_balance() SECURITY DEFINER RPC and its guards.
 *
 * Why this matters: bank reconciliation excludes an opening balance from the
 * period movement only when source_type='opening_balance'. A migrated IB booked
 * as an ordinary voucher (manual/import) is otherwise immutable, so this is the
 * only sanctioned path to re-tag it. The carve-out must NOT open any other edit.
 */

// Posted entry with explicit source_type and lines, created via draft so the
// balance + line-immutability triggers are satisfied. Default lines are a
// realistic bank-account IB (1930 debit / 2099 equity credit).
async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  sourceType?: string
  lines?: Array<{ account: string; debit: number; credit: number }>
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-01-01', 'Ingående balanser 2026', $6, 'draft')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber, params.sourceType ?? 'manual'],
  )
  const lines = params.lines ?? [
    { account: '1930', debit: 5000, credit: 0 },
    { account: '2099', debit: 0, credit: 5000 },
  ]
  for (const l of lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [id, l.account, l.debit, l.credit],
    )
  }
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
  return id
}

describe('mark_entry_as_opening_balance RPC', () => {
  it('re-tags a manual bank-account IB to opening_balance and writes an audit row', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })

    // withUserContext rolls back, so observe the RPC's effects inside the tx.
    await withUserContext(userId, async (client) => {
      const r = await client.query<{ mark_entry_as_opening_balance: { retagged: boolean; previous_source_type: string } }>(
        `SELECT mark_entry_as_opening_balance($1, $2)`,
        [companyId, entryId],
      )
      const result = r.rows[0]!.mark_entry_as_opening_balance
      expect(result.retagged).toBe(true)
      expect(result.previous_source_type).toBe('manual')

      const after = await client.query<{ source_type: string; status: string }>(
        `SELECT source_type, status FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      expect(after.rows[0]!.source_type).toBe('opening_balance')
      expect(after.rows[0]!.status).toBe('posted')

      const audit = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.audit_log
           WHERE table_name = 'journal_entries' AND record_id = $1
             AND description LIKE '%-> opening_balance%'`,
        [entryId],
      )
      expect(Number(audit.rows[0]!.count)).toBeGreaterThanOrEqual(1)
    })
  })

  it('re-tags an import-sourced IB as well', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'admin' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const entryId = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, sourceType: 'import',
    })

    await withUserContext(userId, async (client) => {
      await client.query(`SELECT mark_entry_as_opening_balance($1, $2)`, [companyId, entryId])
      const after = await client.query<{ source_type: string }>(
        `SELECT source_type FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      expect(after.rows[0]!.source_type).toBe('opening_balance')
    })
  })

  it('refuses callers who are not owner/admin', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'viewer' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT mark_entry_as_opening_balance($1, $2)`, [companyId, entryId]),
      ).rejects.toThrow(/owners and admins/i)
    })
  })

  it('refuses an entry that does not touch a bank/cash account', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    // 1510 receivable / 2440 payable: balance-sheet only, no 19xx bank line.
    const entryId = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1,
      lines: [
        { account: '1510', debit: 5000, credit: 0 },
        { account: '2440', debit: 0, credit: 5000 },
      ],
    })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT mark_entry_as_opening_balance($1, $2)`, [companyId, entryId]),
      ).rejects.toThrow(/bank\/cash account/i)
    })
  })

  it('refuses an entry whose source_type is not manual/import', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const entryId = await insertPostedEntry({
      userId, companyId, fiscalPeriodId, voucherNumber: 1, sourceType: 'bank_transaction',
    })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT mark_entry_as_opening_balance($1, $2)`, [companyId, entryId]),
      ).rejects.toThrow(/manual\/import/i)
    })
  })

  it('refuses re-tagging in a locked fiscal period', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [fiscalPeriodId])

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT mark_entry_as_opening_balance($1, $2)`, [companyId, entryId]),
      ).rejects.toThrow(/locked fiscal period/i)
    })
  })
})

describe('enforce_journal_entry_immutability: source_type retag carve-out', () => {
  it('blocks a bare source_type UPDATE when the bypass flag is NOT set', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedOwner()
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET source_type = 'opening_balance' WHERE id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/Committed entries are immutable/i)
  })

  it('allows a source_type-only retag when the bypass flag IS set (in one tx)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedOwner()
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_source_type_retag', 'true', true)`)
      await client.query(
        `UPDATE public.journal_entries SET source_type = 'opening_balance' WHERE id = $1`,
        [entryId],
      )
      const after = await client.query<{ source_type: string }>(
        `SELECT source_type FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      expect(after.rows[0]!.source_type).toBe('opening_balance')
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('blocks even with the flag when another field also changes', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedOwner()
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_source_type_retag', 'true', true)`)
      await expect(
        client.query(
          `UPDATE public.journal_entries
             SET source_type = 'opening_balance', description = 'tampered'
           WHERE id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/Committed entries are immutable/i)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('blocks even with the flag when the target source_type is not opening_balance', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedOwner()
    const entryId = await insertPostedEntry({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('gnubok.allow_source_type_retag', 'true', true)`)
      await expect(
        client.query(
          `UPDATE public.journal_entries SET source_type = 'system' WHERE id = $1`,
          [entryId],
        ),
      ).rejects.toThrow(/Committed entries are immutable/i)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})

// Local owner seed (company + owner membership + open period).
async function seedOwner(): Promise<{ userId: string; companyId: string; fiscalPeriodId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  return { userId, companyId, fiscalPeriodId }
}
