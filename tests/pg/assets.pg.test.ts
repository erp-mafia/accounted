/**
 * pg-real tests for the assets and depreciation_schedules tables introduced
 * in 20260516120000_assets_and_depreciation.sql.
 *
 * Verifies:
 *   - enforce_asset_post_disposal_immutability blocks financial-field edits
 *     after disposal, but lets notes/name through.
 *   - assets_disposal_atomic CHECK requires both disposed_at and disposed_proceeds.
 *   - enforce_depreciation_schedule_immutability blocks edits after a journal
 *     entry has been linked.
 *   - The depreciation_schedules delete RLS policy refuses to delete rows
 *     that have a journal_entry_id set (posted) but allows it before posting.
 *   - RLS scopes both tables to user_company_ids() — a user in company A
 *     cannot see / edit company B's rows.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from './fixtures'

async function insertAsset(params: {
  userId: string
  companyId: string
  disposedAt?: string | null
  disposedProceeds?: number | null
  category?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.assets
       (id, user_id, company_id, name, category, acquisition_date, acquisition_cost,
        useful_life_months, bas_asset_account, bas_accumulated_account, bas_expense_account,
        disposed_at, disposed_proceeds)
     VALUES ($1, $2, $3, 'Test Asset', $4, '2025-01-01', 60000, 60,
             '1220', '1229', '7832', $5, $6)`,
    [
      id,
      params.userId,
      params.companyId,
      params.category ?? 'equipment',
      params.disposedAt ?? null,
      params.disposedProceeds ?? null,
    ],
  )
  return id
}

async function insertDepreciationSchedule(params: {
  userId: string
  companyId: string
  assetId: string
  fiscalPeriodId: string
  journalEntryId?: string | null
  amount?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.depreciation_schedules
       (id, user_id, company_id, asset_id, fiscal_period_id,
        planned_depreciation, journal_entry_id, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      params.userId,
      params.companyId,
      params.assetId,
      params.fiscalPeriodId,
      params.amount ?? 12_000,
      params.journalEntryId ?? null,
      params.journalEntryId ? new Date().toISOString() : null,
    ],
  )
  return id
}

// Insert a real posted journal entry we can FK-link a depreciation_schedule
// to (the FK has ON DELETE RESTRICT so we need a genuine row).
async function insertPostedEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, $5, 'A', '2025-12-31', 'Test', 'year_end', 'posted')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, params.voucherNumber ?? 1],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '7832', 12000, 0), ($1, '1229', 0, 12000)`,
    [id],
  )
  return id
}

let companyA: { userId: string; companyId: string; fiscalPeriodId: string }
let companyB: { userId: string; companyId: string; fiscalPeriodId: string }

beforeAll(async () => {
  for (const slot of ['A', 'B'] as const) {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    if (slot === 'A') companyA = { userId, companyId, fiscalPeriodId }
    else companyB = { userId, companyId, fiscalPeriodId }
  }
})

describe('assets table — immutability after disposal', () => {
  it('allows changing notes/name on a disposed asset', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
      disposedAt: '2025-12-31',
      disposedProceeds: 5_000,
    })
    await getPool().query(
      `UPDATE public.assets SET notes = 'updated', name = 'renamed' WHERE id = $1`,
      [assetId],
    )
    const { rows } = await getPool().query(
      `SELECT notes, name FROM public.assets WHERE id = $1`,
      [assetId],
    )
    expect(rows[0]?.notes).toBe('updated')
    expect(rows[0]?.name).toBe('renamed')
  })

  it('blocks acquisition_cost edit on a disposed asset', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
      disposedAt: '2025-12-31',
      disposedProceeds: 5_000,
    })
    await expect(
      getPool().query(
        `UPDATE public.assets SET acquisition_cost = 99999 WHERE id = $1`,
        [assetId],
      ),
    ).rejects.toThrow(/disposed asset/i)
  })

  it('blocks useful_life_months and depreciation_method edits on a disposed asset', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
      disposedAt: '2025-12-31',
      disposedProceeds: 5_000,
    })
    await expect(
      getPool().query(
        `UPDATE public.assets SET useful_life_months = 120 WHERE id = $1`,
        [assetId],
      ),
    ).rejects.toThrow(/disposed asset/i)
    await expect(
      getPool().query(
        `UPDATE public.assets SET depreciation_method = 'declining_balance_30' WHERE id = $1`,
        [assetId],
      ),
    ).rejects.toThrow(/disposed asset/i)
  })

  it('blocks BAS account edits on a disposed asset', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
      disposedAt: '2025-12-31',
      disposedProceeds: 5_000,
    })
    await expect(
      getPool().query(
        `UPDATE public.assets SET bas_expense_account = '7831' WHERE id = $1`,
        [assetId],
      ),
    ).rejects.toThrow(/disposed asset/i)
  })

  it('allows the same edits while not yet disposed', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
    })
    await getPool().query(
      `UPDATE public.assets SET acquisition_cost = 70000, useful_life_months = 72 WHERE id = $1`,
      [assetId],
    )
    const { rows } = await getPool().query(
      `SELECT acquisition_cost, useful_life_months FROM public.assets WHERE id = $1`,
      [assetId],
    )
    expect(Number(rows[0]?.acquisition_cost)).toBe(70_000)
    expect(rows[0]?.useful_life_months).toBe(72)
  })

  it('disposal CHECK requires both disposed_at and disposed_proceeds', async () => {
    await expect(
      insertAsset({
        userId: companyA.userId,
        companyId: companyA.companyId,
        disposedAt: '2025-12-31',
        disposedProceeds: null,
      }),
    ).rejects.toThrow(/assets_disposal_atomic|check constraint/i)
  })
})

describe('depreciation_schedules — immutability after posting', () => {
  it('blocks planned_depreciation edits once a journal entry is linked', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
    })
    const entryId = await insertPostedEntry({
      userId: companyA.userId,
      companyId: companyA.companyId,
      fiscalPeriodId: companyA.fiscalPeriodId,
      voucherNumber: 100,
    })
    const scheduleId = await insertDepreciationSchedule({
      userId: companyA.userId,
      companyId: companyA.companyId,
      assetId,
      fiscalPeriodId: companyA.fiscalPeriodId,
      journalEntryId: entryId,
    })
    await expect(
      getPool().query(
        `UPDATE public.depreciation_schedules SET planned_depreciation = 99999 WHERE id = $1`,
        [scheduleId],
      ),
    ).rejects.toThrow(/posted depreciation schedule/i)
  })

  it('allows planned_depreciation edits BEFORE a journal entry is linked', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
    })
    const scheduleId = await insertDepreciationSchedule({
      userId: companyA.userId,
      companyId: companyA.companyId,
      assetId,
      fiscalPeriodId: companyA.fiscalPeriodId,
    })
    await getPool().query(
      `UPDATE public.depreciation_schedules SET planned_depreciation = 8888 WHERE id = $1`,
      [scheduleId],
    )
    const { rows } = await getPool().query(
      `SELECT planned_depreciation FROM public.depreciation_schedules WHERE id = $1`,
      [scheduleId],
    )
    expect(Number(rows[0]?.planned_depreciation)).toBe(8_888)
  })
})

describe('depreciation_schedules — delete RLS policy', () => {
  it('user can DELETE a draft schedule (no journal_entry_id)', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
    })
    const scheduleId = await insertDepreciationSchedule({
      userId: companyA.userId,
      companyId: companyA.companyId,
      assetId,
      fiscalPeriodId: companyA.fiscalPeriodId,
    })
    const deletedCount = await withUserContext(companyA.userId, async (client) => {
      const result = await client.query(
        `DELETE FROM public.depreciation_schedules WHERE id = $1 RETURNING id`,
        [scheduleId],
      )
      return result.rowCount
    })
    expect(deletedCount).toBe(1)
  })

  it('user CANNOT DELETE a posted schedule (RLS policy filters it out)', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
    })
    const entryId = await insertPostedEntry({
      userId: companyA.userId,
      companyId: companyA.companyId,
      fiscalPeriodId: companyA.fiscalPeriodId,
      voucherNumber: 101,
    })
    const scheduleId = await insertDepreciationSchedule({
      userId: companyA.userId,
      companyId: companyA.companyId,
      assetId,
      fiscalPeriodId: companyA.fiscalPeriodId,
      journalEntryId: entryId,
    })
    // RLS-filtered DELETE returns 0 affected rows rather than raising — the
    // row is invisible to the DELETE statement under the authenticated role.
    const deletedCount = await withUserContext(companyA.userId, async (client) => {
      const result = await client.query(
        `DELETE FROM public.depreciation_schedules WHERE id = $1 RETURNING id`,
        [scheduleId],
      )
      return result.rowCount
    })
    expect(deletedCount).toBe(0)
    // And the row still exists when checked as superuser.
    const { rows } = await getPool().query(
      `SELECT id FROM public.depreciation_schedules WHERE id = $1`,
      [scheduleId],
    )
    expect(rows).toHaveLength(1)
  })
})

describe('RLS — cross-company isolation', () => {
  it('company A user cannot SELECT company B assets', async () => {
    const bAssetId = await insertAsset({
      userId: companyB.userId,
      companyId: companyB.companyId,
    })
    const visibleToA = await withUserContext(companyA.userId, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM public.assets WHERE id = $1`,
        [bAssetId],
      )
      return result.rowCount ?? 0
    })
    expect(visibleToA).toBe(0)
  })

  it('company A user can SELECT their own assets', async () => {
    const aAssetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
    })
    const visibleToA = await withUserContext(companyA.userId, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM public.assets WHERE id = $1`,
        [aAssetId],
      )
      return result.rowCount ?? 0
    })
    expect(visibleToA).toBe(1)
  })

  it('company A user cannot INSERT a depreciation_schedule into company B', async () => {
    const bAssetId = await insertAsset({
      userId: companyB.userId,
      companyId: companyB.companyId,
    })
    await expect(
      withUserContext(companyA.userId, async (client) => {
        await client.query(
          `INSERT INTO public.depreciation_schedules
             (user_id, company_id, asset_id, fiscal_period_id, planned_depreciation)
           VALUES ($1, $2, $3, $4, 1000)`,
          [companyA.userId, companyB.companyId, bAssetId, companyB.fiscalPeriodId],
        )
      }),
    ).rejects.toThrow(/row-level security|new row violates/i)
  })
})

// Asset disposal VAT + jämkning constraints (migration 20260526120300).
// The columns are populated by disposeAsset() after the journal entry posts;
// these pg tests cover the CHECK constraints directly so future schema changes
// can't loosen them without us noticing.
describe('assets — disposal VAT + jämkning constraints', () => {
  it('accepts a disposed_vat_treatment from the allowed enum', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
      disposedAt: '2025-12-31',
      disposedProceeds: 100_000,
    })
    await getPool().query(
      `UPDATE public.assets
         SET disposed_proceeds_vat = 20000, disposed_vat_treatment = 'standard_25'
       WHERE id = $1`,
      [assetId],
    )
    const { rows } = await getPool().query(
      `SELECT disposed_proceeds_vat, disposed_vat_treatment FROM public.assets WHERE id = $1`,
      [assetId],
    )
    expect(Number(rows[0]?.disposed_proceeds_vat)).toBe(20_000)
    expect(rows[0]?.disposed_vat_treatment).toBe('standard_25')
  })

  it('rejects a disposed_vat_treatment outside the enum', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
      disposedAt: '2025-12-31',
      disposedProceeds: 100_000,
    })
    await expect(
      getPool().query(
        `UPDATE public.assets SET disposed_vat_treatment = 'reduced_999' WHERE id = $1`,
        [assetId],
      ),
    ).rejects.toThrow(/check/i)
  })

  it('rejects disposed_proceeds_vat > 0 without a disposed_vat_treatment', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
      disposedAt: '2025-12-31',
      disposedProceeds: 100_000,
    })
    // Treatment NULL + VAT > 0 must violate the consistency CHECK.
    await expect(
      getPool().query(
        `UPDATE public.assets
           SET disposed_proceeds_vat = 20000, disposed_vat_treatment = NULL
         WHERE id = $1`,
        [assetId],
      ),
    ).rejects.toThrow(/check|consistency/i)
  })

  it('accepts zero VAT with null treatment (legacy / non-VAT disposal)', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
      disposedAt: '2025-12-31',
      disposedProceeds: 50_000,
    })
    // Default values from the migration — should already pass on insert.
    const { rows } = await getPool().query(
      `SELECT disposed_proceeds_vat, disposed_vat_treatment FROM public.assets WHERE id = $1`,
      [assetId],
    )
    expect(Number(rows[0]?.disposed_proceeds_vat)).toBe(0)
    expect(rows[0]?.disposed_vat_treatment).toBeNull()
  })

  it('persists jämkning audit metadata on the row', async () => {
    const assetId = await insertAsset({
      userId: companyA.userId,
      companyId: companyA.companyId,
      disposedAt: '2025-12-31',
      disposedProceeds: 60_000,
    })
    await getPool().query(
      `UPDATE public.assets
         SET jamkning_amount = 8000,
             jamkning_remaining_months = 24,
             jamkning_total_months = 60,
             jamkning_original_input_vat = 20000
       WHERE id = $1`,
      [assetId],
    )
    const { rows } = await getPool().query(
      `SELECT jamkning_amount, jamkning_remaining_months, jamkning_total_months,
              jamkning_original_input_vat
         FROM public.assets
        WHERE id = $1`,
      [assetId],
    )
    expect(Number(rows[0]?.jamkning_amount)).toBe(8_000)
    expect(rows[0]?.jamkning_remaining_months).toBe(24)
    expect(rows[0]?.jamkning_total_months).toBe(60)
    expect(Number(rows[0]?.jamkning_original_input_vat)).toBe(20_000)
  })
})
