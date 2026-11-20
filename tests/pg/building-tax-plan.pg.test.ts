import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertFiscalPeriod, seedCompany } from './fixtures'

/**
 * Migration 20261031200901_building_tax_depreciation: the tax plan of a
 * building or markanläggning (IL 19 kap. 5-5 a §§, 20 kap. 5 §).
 *
 * Pinned here (assets_tax_depreciation_check):
 *   - a rate is above 0 and at most 100 percent, and only on a building or
 *     a markanläggning; a markanläggning at most 10 percent;
 *   - the primäravdrag only on a building;
 *   - the plan never starts before the acquisition;
 *   - no rate at all is allowed (no tax plan stated);
 *   - set_asset_tax_plan_applies_from: a stated plan reaches the years from
 *     the day after the last closed or locked year (every year when none
 *     is); once a year it reached is closed or locked, the plan cannot be
 *     changed or cleared (TAX_PLAN_USED_BY_CLOSED_YEAR); the date is never
 *     set by a caller.
 */

type Seed = { userId: string; companyId: string }

async function insertAsset(
  seed: Seed,
  values: { category: string; rate?: number | null; from?: string | null; primary?: boolean },
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.assets (
       id, user_id, company_id, name, category, acquisition_date,
       acquisition_cost, salvage_value, useful_life_months,
       depreciation_method, bas_asset_account, bas_accumulated_account,
       bas_expense_account, tax_depreciation_rate, tax_depreciation_from,
       tax_primary_allowance
     ) VALUES ($1, $2, $3, 'Tillgång', $4, '2026-01-01', 1000000, 0, 600, 'linear',
               '1110', '1119', '7821', $5, $6, $7)`,
    [
      randomUUID(),
      seed.userId,
      seed.companyId,
      values.category,
      values.rate ?? null,
      values.from ?? null,
      values.primary ?? false,
    ],
  )
}

describe('assets_tax_depreciation_check', () => {
  it('takes a tax plan on a building and a markanläggning, and none at all', async () => {
    const seed = await seedCompany()
    await expect(insertAsset(seed, { category: 'building', rate: 2, from: '2026-03-01', primary: true })).resolves.toBeUndefined()
    await expect(insertAsset(seed, { category: 'land_improvement', rate: 5 })).resolves.toBeUndefined()
    await expect(insertAsset(seed, { category: 'building' })).resolves.toBeUndefined()
  })

  it('refuses a rate outside 0-100, on another category, or above 10 on a markanläggning', async () => {
    const seed = await seedCompany()
    await expect(insertAsset(seed, { category: 'building', rate: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertAsset(seed, { category: 'building', rate: 101 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertAsset(seed, { category: 'machinery', rate: 20 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertAsset(seed, { category: 'land_improvement', rate: 12 })).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses the primäravdrag off a building and a plan before the acquisition', async () => {
    const seed = await seedCompany()
    await expect(
      insertAsset(seed, { category: 'land_improvement', rate: 5, primary: true }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      insertAsset(seed, { category: 'building', rate: 2, from: '2025-12-31' }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('set_asset_tax_plan_applies_from', () => {
  async function plainBuilding(seed: Seed): Promise<string> {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.assets (
         id, user_id, company_id, name, category, acquisition_date, acquisition_cost, salvage_value,
         useful_life_months, depreciation_method, bas_asset_account, bas_accumulated_account, bas_expense_account
       ) VALUES ($1, $2, $3, 'Kontorshus', 'building', '2020-01-01', 1000000, 0, 600, 'linear', '1110', '1119', '7821')`,
      [id, seed.userId, seed.companyId],
    )
    return id
  }

  const setRate = (id: string, rate: number | null) =>
    getPool().query(`UPDATE public.assets SET tax_depreciation_rate = $2 WHERE id = $1`, [id, rate])

  async function appliesFrom(id: string): Promise<string | null> {
    const { rows } = await getPool().query<{ from: string | null }>(
      `SELECT to_char(tax_plan_applies_from, 'YYYY-MM-DD') AS from FROM public.assets WHERE id = $1`,
      [id],
    )
    return rows[0].from
  }

  it('reaches every year while none is closed, and only the open ones after', async () => {
    const seed = await seedCompany()
    const id = await plainBuilding(seed)
    await setRate(id, 2)
    // The company's only year is 2026, the asset older: every year.
    expect(await appliesFrom(id)).toBe('2020-01-01')
    await setRate(id, null)
    expect(await appliesFrom(id)).toBeNull()

    await insertFiscalPeriod({
      userId: seed.userId,
      companyId: seed.companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      isClosed: true,
    })
    await setRate(id, 2)
    expect(await appliesFrom(id)).toBe('2026-01-01')
  })

  it('fixes the plan once a year it reached is closed, and keeps the date out of a caller\'s hands', async () => {
    const seed = await seedCompany()
    const id = await plainBuilding(seed)
    await setRate(id, 2)
    await getPool().query(`UPDATE public.assets SET tax_plan_applies_from = '2030-01-01' WHERE id = $1`, [id])
    expect(await appliesFrom(id)).toBe('2020-01-01')

    // The year the plan reached is closed (declared): it may not move.
    await getPool().query(`UPDATE public.fiscal_periods SET is_closed = true, closed_at = now() WHERE id = $1`, [seed.fiscalPeriodId])
    await expect(setRate(id, 3)).rejects.toMatchObject({ code: 'PT409', message: 'TAX_PLAN_USED_BY_CLOSED_YEAR' })
    await expect(setRate(id, null)).rejects.toMatchObject({ code: 'PT409', message: 'TAX_PLAN_USED_BY_CLOSED_YEAR' })
    // Anything else on the asset still changes.
    await expect(
      getPool().query(`UPDATE public.assets SET name = 'Kontorshuset' WHERE id = $1`, [id]),
    ).resolves.toBeTruthy()
  })
})
