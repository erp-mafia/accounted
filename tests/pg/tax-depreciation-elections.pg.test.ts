import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertFiscalPeriod, seedCompany } from './fixtures'

interface SnapshotInput {
  method: 'rakenskapsenlig' | 'restvarde'
  rule: 'huvudregel_30' | 'kompletteringsregel_20' | null
  opening: number
  basis: number
  deduction: number
  closing: number
}

const SNAPSHOT: SnapshotInput = {
  method: 'rakenskapsenlig',
  rule: 'huvudregel_30',
  opening: 100_000,
  basis: 130_000,
  deduction: 39_000,
  closing: 91_000,
}

async function saveSnapshot(
  periodId: string,
  overrides: Partial<SnapshotInput> = {},
): Promise<void> {
  const snapshot = { ...SNAPSHOT, ...overrides }
  await getPool().query(
    `UPDATE public.fiscal_periods
     SET tax_depreciation_method = $2,
         tax_depreciation_rule = $3,
         tax_depreciation_opening_value = $4,
         tax_depreciation_base = $5,
         tax_depreciation_deduction = $6,
         tax_depreciation_closing_value = $7,
         tax_depreciation_calculation = $8::jsonb
     WHERE id = $1`,
    [
      periodId,
      snapshot.method,
      snapshot.rule,
      snapshot.opening,
      snapshot.basis,
      snapshot.deduction,
      snapshot.closing,
      JSON.stringify({
        version: 2,
        elected_deduction: snapshot.deduction,
        maximum_deduction: Math.max(snapshot.deduction, SNAPSHOT.deduction),
        book_conformity_confirmed: snapshot.method === 'rakenskapsenlig' ? true : null,
      }),
    ],
  )
}

describe('tax depreciation election constraints', () => {
  it('accepts a complete räkenskapsenlig annual snapshot', async () => {
    const owner = await seedCompany()
    await expect(saveSnapshot(owner.fiscalPeriodId)).resolves.toBeUndefined()
  })

  it('rejects an incomplete or incoherent annual snapshot', async () => {
    const owner = await seedCompany()
    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods
         SET tax_depreciation_method = 'restvarde',
             tax_depreciation_rule = 'huvudregel_30',
             tax_depreciation_opening_value = 100000,
             tax_depreciation_base = 100000,
             tax_depreciation_deduction = 25000,
             tax_depreciation_closing_value = 75000,
             tax_depreciation_calculation = '{
               "version": 2,
               "elected_deduction": 25000,
               "maximum_deduction": 25000,
               "book_conformity_confirmed": null
             }'::jsonb
         WHERE id = $1`,
        [owner.fiscalPeriodId],
      ),
    ).rejects.toThrow()
  })

  it('rejects deduction above the base or a closing value that does not reconcile', async () => {
    const owner = await seedCompany()
    await expect(saveSnapshot(owner.fiscalPeriodId, {
      basis: 10_000,
      deduction: 11_000,
      closing: 0,
    })).rejects.toThrow()
    await expect(saveSnapshot(owner.fiscalPeriodId, {
      basis: 100_000,
      deduction: 30_000,
      closing: 60_000,
    })).rejects.toThrow()
  })

  it('enforces predecessor method and opening value for direct writes', async () => {
    const owner = await seedCompany()
    const previousPeriodId = await insertFiscalPeriod({
      userId: owner.userId,
      companyId: owner.companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    await getPool().query(
      'UPDATE public.fiscal_periods SET previous_period_id = $2 WHERE id = $1',
      [owner.fiscalPeriodId, previousPeriodId],
    )
    await saveSnapshot(previousPeriodId)

    await expect(saveSnapshot(owner.fiscalPeriodId, {
      opening: 90_000,
      basis: 100_000,
      deduction: 30_000,
      closing: 70_000,
    })).rejects.toThrow(/opening value must equal/i)
    await expect(saveSnapshot(owner.fiscalPeriodId, {
      method: 'restvarde',
      rule: null,
      opening: SNAPSHOT.closing,
      basis: 100_000,
      deduction: 25_000,
      closing: 75_000,
    })).rejects.toThrow(/method must match/i)
  })

  it('blocks an earlier snapshot change after a successor snapshot is saved', async () => {
    const owner = await seedCompany()
    const previousPeriodId = await insertFiscalPeriod({
      userId: owner.userId,
      companyId: owner.companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    await getPool().query(
      'UPDATE public.fiscal_periods SET previous_period_id = $2 WHERE id = $1',
      [owner.fiscalPeriodId, previousPeriodId],
    )
    await saveSnapshot(previousPeriodId)
    await saveSnapshot(owner.fiscalPeriodId, {
      opening: SNAPSHOT.closing,
      basis: SNAPSHOT.closing,
      deduction: 20_000,
      closing: 71_000,
    })

    await expect(saveSnapshot(previousPeriodId, {
      deduction: 38_000,
      closing: 92_000,
    })).rejects.toThrow(/later fiscal period already has/i)
  })

  it('blocks snapshot changes after the fiscal period is locked', async () => {
    const owner = await seedCompany()
    await saveSnapshot(owner.fiscalPeriodId)
    await getPool().query(
      'UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1',
      [owner.fiscalPeriodId],
    )

    await expect(
      getPool().query(
        `UPDATE public.fiscal_periods
         SET tax_depreciation_deduction = 38000,
             tax_depreciation_closing_value = 92000
         WHERE id = $1`,
        [owner.fiscalPeriodId],
      ),
    ).rejects.toThrow(/locked for tax depreciation elections/i)
  })

  it('rejects new per-asset tax depreciation methods', async () => {
    const owner = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.assets
           (user_id, company_id, name, category, acquisition_date,
            acquisition_cost, salvage_value, useful_life_months,
            depreciation_method, bas_asset_account,
            bas_accumulated_account, bas_expense_account)
         VALUES ($1, $2, 'Legacy tax method', 'equipment', CURRENT_DATE,
                 100000, 0, 60, 'declining_balance_30', '1220', '1229', '7832')`,
        [owner.userId, owner.companyId],
      ),
    ).rejects.toThrow(/must be linear/i)
  })

})
