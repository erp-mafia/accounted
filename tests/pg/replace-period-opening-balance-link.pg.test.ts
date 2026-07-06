import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers replace_period_opening_balance_link (20260528120200), the RPC the
 * opening-balance correction flow (app/api/import/opening-balance/correct) uses
 * to repoint fiscal_periods.opening_balance_entry_id from the stornoed IB to the
 * corrected one.
 *
 * The critical property: enforce_opening_balance_immutability blocks any direct
 * UPDATE that changes opening_balance_entry_id while opening_balances_set is
 * true. The RPC's two-step (flip the flag off, change the FK, flip it on) must
 * therefore be the sanctioned path: a plain UPDATE must still be rejected.
 */

async function insertPostedOpeningBalance(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  lines?: Array<{ account: string; debit: number; credit: number }>
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2026-01-01', 'Ingående balanser', 'opening_balance', 'draft')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber],
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

async function linkOpeningBalance(companyId: string, periodId: string, entryId: string) {
  // First-time link: OLD.opening_balances_set is false, so the immutability
  // trigger permits setting the FK + flag together.
  await getPool().query(
    `UPDATE public.fiscal_periods
       SET opening_balance_entry_id = $3, opening_balances_set = true
     WHERE id = $2 AND company_id = $1`,
    [companyId, periodId, entryId],
  )
}

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  return { userId, companyId, fiscalPeriodId }
}

describe('replace_period_opening_balance_link RPC', () => {
  it('repoints the period to a new posted IB entry while opening_balances_set is true', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const oldEntry = await insertPostedOpeningBalance({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    await linkOpeningBalance(companyId, fiscalPeriodId, oldEntry)
    const newEntry = await insertPostedOpeningBalance({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })

    await withUserContext(userId, async (client) => {
      await client.query(`SELECT replace_period_opening_balance_link($1, $2, $3)`, [
        companyId,
        fiscalPeriodId,
        newEntry,
      ])

      const after = await client.query<{ opening_balance_entry_id: string; opening_balances_set: boolean }>(
        `SELECT opening_balance_entry_id, opening_balances_set
           FROM public.fiscal_periods WHERE id = $1`,
        [fiscalPeriodId],
      )
      expect(after.rows[0]!.opening_balance_entry_id).toBe(newEntry)
      expect(after.rows[0]!.opening_balances_set).toBe(true)
    })
  })

  it('still blocks a plain UPDATE of the link while set=true (trigger intact)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const oldEntry = await insertPostedOpeningBalance({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    await linkOpeningBalance(companyId, fiscalPeriodId, oldEntry)
    const newEntry = await insertPostedOpeningBalance({ userId, companyId, fiscalPeriodId, voucherNumber: 2 })

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `UPDATE public.fiscal_periods SET opening_balance_entry_id = $2 WHERE id = $1`,
          [fiscalPeriodId, newEntry],
        ),
      ).rejects.toThrow()
    })
  })

  it('rejects a non-posted replacement entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const oldEntry = await insertPostedOpeningBalance({ userId, companyId, fiscalPeriodId, voucherNumber: 1 })
    await linkOpeningBalance(companyId, fiscalPeriodId, oldEntry)

    // Draft (non-posted) candidate entry.
    const draftId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 3, 'A', '2026-01-01', 'Draft IB', 'opening_balance', 'draft')`,
      [draftId, userId, companyId, fiscalPeriodId],
    )

    await withUserContext(userId, async (client) => {
      await expect(
        client.query(`SELECT replace_period_opening_balance_link($1, $2, $3)`, [
          companyId,
          fiscalPeriodId,
          draftId,
        ]),
      ).rejects.toThrow()
    })
  })
})
