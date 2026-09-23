import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

describe('commit_asset_disposal (pg-real)', () => {
  async function insertAsset(userId: string, companyId: string): Promise<string> {
    const assetId = randomUUID()
    await getPool().query(
      `INSERT INTO public.assets (
         id, user_id, company_id, name, category, acquisition_date,
         acquisition_cost, salvage_value, useful_life_months,
         depreciation_method, bas_asset_account, bas_accumulated_account,
         bas_expense_account
       ) VALUES ($1, $2, $3, 'Machine', 'equipment', '2025-01-01',
                 100000, 0, 60, 'linear', '1220', '1229', '7832')`,
      [assetId, userId, companyId],
    )
    return assetId
  }

  async function insertDraft(args: {
    userId: string
    companyId: string
    fiscalPeriodId: string
    debitLines: Array<[string, number]>
    creditLines: Array<[string, number]>
  }): Promise<string> {
    const entryId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries (
         id, user_id, company_id, fiscal_period_id, voucher_number,
         voucher_series, entry_date, description, source_type, status
       ) VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-30',
                 'Asset disposal', 'system', 'draft')`,
      [entryId, args.userId, args.companyId, args.fiscalPeriodId],
    )
    for (const [account, amount] of args.debitLines) {
      await getPool().query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, $3, 0)`,
        [entryId, account, amount],
      )
    }
    for (const [account, amount] of args.creditLines) {
      await getPool().query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, 0, $3)`,
        [entryId, account, amount],
      )
    }
    return entryId
  }

  async function commit(args: {
    companyId: string
    assetId: string
    entryId: string
    fiscalPeriodId: string
    disposalType?: string
    currentDepreciation?: number
  }) {
    return getPool().query(
      `SELECT * FROM public.commit_asset_disposal(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text,
         '2026-06-30'::date, 80000::numeric, 0::numeric, 'exempt'::text,
         $6::numeric, 0::numeric, 'none'::text, 4::integer, 5::integer,
         0::numeric, 0::numeric, 0::numeric, NULL::text, NULL::text
       )`,
      [
        args.companyId,
        args.assetId,
        args.entryId,
        args.fiscalPeriodId,
        args.disposalType ?? 'sale',
        args.currentDepreciation ?? 0,
      ],
    )
  }

  it('posts the voucher, schedule, and register state in one transaction', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const assetId = await insertAsset(userId, companyId)
    const entryId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId,
      debitLines: [['7832', 10_000], ['1229', 30_000], ['1930', 80_000]],
      creditLines: [['1229', 10_000], ['1220', 100_000], ['3973', 10_000]],
    })

    await commit({ companyId, assetId, entryId, fiscalPeriodId, currentDepreciation: 10_000 })

    const entry = await getPool().query(
      `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    const asset = await getPool().query(
      `SELECT disposed_at::text, disposal_type, disposal_journal_entry_id
         FROM public.assets WHERE id = $1`,
      [assetId],
    )
    const schedule = await getPool().query(
      `SELECT planned_depreciation::numeric, journal_entry_id
         FROM public.depreciation_schedules
        WHERE asset_id = $1 AND fiscal_period_id = $2`,
      [assetId, fiscalPeriodId],
    )

    expect(entry.rows[0]).toMatchObject({ status: 'posted' })
    expect(entry.rows[0].voucher_number).toBeGreaterThan(0)
    expect(asset.rows[0]).toMatchObject({
      disposed_at: '2026-06-30',
      disposal_type: 'sale',
      disposal_journal_entry_id: entryId,
    })
    expect(Number(schedule.rows[0].planned_depreciation)).toBe(10_000)
    expect(schedule.rows[0].journal_entry_id).toBe(entryId)

    await expect(
      getPool().query(`UPDATE public.assets SET disposed_proceeds = 1 WHERE id = $1`, [assetId]),
    ).rejects.toThrow(/Cannot modify financial or disposal attributes/)

    await expect(
      getPool().query(`UPDATE public.assets SET notes = 'Audit note' WHERE id = $1`, [assetId]),
    ).resolves.toBeDefined()
  })

  it('rolls the voucher commit back when the register update fails', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const assetId = await insertAsset(userId, companyId)
    const entryId = await insertDraft({
      userId,
      companyId,
      fiscalPeriodId,
      debitLines: [['1930', 80_000], ['7973', 20_000]],
      creditLines: [['1220', 100_000]],
    })

    await expect(
      commit({
        companyId,
        assetId,
        entryId,
        fiscalPeriodId,
        disposalType: 'invalid',
      }),
    ).rejects.toThrow()

    const entry = await getPool().query(
      `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    const asset = await getPool().query(
      `SELECT disposed_at FROM public.assets WHERE id = $1`,
      [assetId],
    )
    expect(entry.rows[0]).toMatchObject({ status: 'draft', voucher_number: 0 })
    expect(asset.rows[0].disposed_at).toBeNull()
  })
})
