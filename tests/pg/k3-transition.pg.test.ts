import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertFiscalPeriod, seedCompany } from './fixtures'

/**
 * Migration 20261031201101_k3_transition: the transition to K3 (BFNAR
 * 2012:1 kap. 35).
 *
 * Pinned here:
 *   - one transition per company, on one of its own fiscal years; it is
 *     committed only by commit_k3_transition;
 *   - split_asset_at_k3_transition divides a plain asset at the transition
 *     date (35.18): the components hold its cost and the accumulated
 *     depreciation at the transition (opening plus everything posted on it
 *     as a whole) in their openings, stated the day before; the asset row
 *     follows as the projection; a split that does not hold those figures
 *     is refused;
 *   - a split component's basis moves only with the split; the split is
 *     undone exactly (the plain asset as it was) while nothing is posted
 *     per component;
 *   - no split before the transition is started, after depreciation posted
 *     from the transition date, of mark, of an asset acquired under K3, or
 *     once committed;
 *   - commit_k3_transition posts a system voucher dated the transition
 *     date with balance sheet lines against the one equity account, the
 *     stated deferred tax change on 2240/1370, and marks the transition
 *     committed; a second commit is refused; a storno opens it again;
 *   - it refuses a result account, another equity account, a deferred tax
 *     change other than stated, and deferred tax under the 35.27 relief;
 *   - it refuses own development (101x) on the voucher (35.16);
 *   - a loss carried into the first K3 year needs its 29.29 reason, which
 *     the committed items keep;
 *   - a committed transition keeps its year and relief; its note facts stay
 *     editable; it cannot be deleted;
 *   - the transition year must be reported under K3 by its own framework
 *     row, not the company's latest framework: a K2 year is refused at the
 *     start and at the commit.
 */

type Seed = { userId: string; companyId: string; fiscalPeriodId: string }
type Company = Seed & { previousPeriodId: string }

const SPLIT_SQL = `SELECT public.split_asset_at_k3_transition($1::uuid, $2::uuid, $3::jsonb)`
const COMMIT_SQL = `SELECT * FROM public.commit_k3_transition(
  $1::uuid, $2::uuid, $3::text, $4::numeric, $5::numeric, $6::jsonb
)`
// The last two before the actor are the asset's opening as the plan read it.
const DEPRECIATE_SQL = `SELECT * FROM public.commit_asset_depreciation(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric,
  $6::numeric, $7::date, NULL::text, NULL::text, NULL::jsonb
)`

/** 2025 under K2, 2026 the first K3 year (its own framework row). */
async function company(): Promise<Company> {
  const seed = await seedCompany()
  const previousPeriodId = await insertFiscalPeriod({
    userId: seed.userId,
    companyId: seed.companyId,
    name: '2025',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
  })
  await getPool().query(`UPDATE public.companies SET accounting_framework = 'k3' WHERE id = $1`, [seed.companyId])
  await getPool().query(`UPDATE public.fiscal_period_frameworks SET framework = 'k3' WHERE fiscal_period_id = $1`, [
    seed.fiscalPeriodId,
  ])
  return { ...seed, previousPeriodId }
}

async function insertAsset(
  seed: Seed,
  values: { category?: string; acquired?: string; opening?: number; openingDate?: string | null; life?: number } = {},
): Promise<string> {
  const id = randomUUID()
  const land = values.category === 'land'
  await getPool().query(
    `INSERT INTO public.assets (
       id, user_id, company_id, name, category, acquisition_date,
       acquisition_cost, salvage_value, useful_life_months,
       depreciation_method, bas_asset_account, bas_accumulated_account,
       bas_expense_account, opening_accumulated_depreciation, opening_depreciation_date
     ) VALUES ($1, $2, $3, 'Kontorshus', $4, $5, 1000000, 0, $6, 'linear',
               $7, $8, $9, $10, $11)`,
    [
      id,
      seed.userId,
      seed.companyId,
      values.category ?? 'building',
      values.acquired ?? '2016-01-01',
      land ? 0 : values.life ?? 1000,
      land ? '1130' : '1110',
      land ? '1118' : '1119',
      land ? '7820' : '7821',
      values.opening ?? 0,
      values.openingDate ?? null,
    ],
  )
  return id
}

async function insertDraft(
  seed: Seed,
  lines: Array<[string, number, number]>,
  options: { sourceType?: string; entryDate?: string; fiscalPeriodId?: string } = {},
): Promise<string> {
  const entryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries (
       id, user_id, company_id, fiscal_period_id, voucher_number,
       voucher_series, entry_date, description, source_type, status
     ) VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Övergång till K3', $6, 'draft')`,
    [
      entryId,
      seed.userId,
      seed.companyId,
      options.fiscalPeriodId ?? seed.fiscalPeriodId,
      options.entryDate ?? '2026-01-01',
      options.sourceType ?? 'system',
    ],
  )
  for (const [account, debit, credit] of lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [entryId, account, debit, credit],
    )
  }
  return entryId
}

async function postDepreciation(
  seed: Seed,
  assetId: string,
  amount: number,
  periodId: string,
  date: string,
  opening: [number, string | null] = [108_000, '2024-12-31'],
) {
  const entryId = await insertDraft(
    seed,
    [
      ['7821', amount, 0],
      ['1119', 0, amount],
    ],
    { sourceType: 'year_end', fiscalPeriodId: periodId, entryDate: date },
  )
  await getPool().query(DEPRECIATE_SQL, [seed.companyId, assetId, entryId, periodId, amount, opening[0], opening[1]])
  return entryId
}

async function startTransition(seed: Seed): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.k3_transitions (company_id, fiscal_period_id) VALUES ($1, $2) RETURNING id`,
    [seed.companyId, seed.fiscalPeriodId],
  )
  return rows[0].id
}

/** A building with 108 000 written off before Accounted and 12 000 posted in 2025. */
async function depreciatedBuilding(seed: Company): Promise<string> {
  const assetId = await insertAsset(seed, { opening: 108_000, openingDate: '2024-12-31' })
  await postDepreciation(seed, assetId, 12_000, seed.previousPeriodId, '2025-12-31')
  return assetId
}

const SPLIT = [
  { name: 'Stomme', cost: 692_307.69, useful_life_months: 1200, salvage_value: 0, opening_accumulated_depreciation: 92_307.69 },
  { name: 'Tak', cost: 207_692.31, useful_life_months: 480, salvage_value: 0, opening_accumulated_depreciation: 27_692.31 },
  { name: 'Mark', cost: 100_000, useful_life_months: null, salvage_value: 0, opening_accumulated_depreciation: 0 },
]

function split(seed: Seed, assetId: string, components: unknown[] = SPLIT) {
  return getPool().query(SPLIT_SQL, [seed.companyId, assetId, JSON.stringify(components)])
}

async function assetRow(assetId: string) {
  const { rows } = await getPool().query<{
    acquisition_cost: string
    salvage_value: string
    opening_accumulated_depreciation: string
    opening_depreciation_date: string | null
    k3_components: unknown
  }>(
    `SELECT acquisition_cost, salvage_value, opening_accumulated_depreciation,
            to_char(opening_depreciation_date, 'YYYY-MM-DD') AS opening_depreciation_date, k3_components
       FROM public.assets WHERE id = $1`,
    [assetId],
  )
  return rows[0]
}

function buildingItem(deferredTax: number) {
  return {
    kind: 'building',
    label: 'Kontorshus',
    carrying_amount: 880_000,
    tax_value: 780_000,
    temporary_difference: 100_000,
    tax_rate: 0.206,
    deferred_tax: deferredTax,
  }
}

function commit(seed: Seed, entryId: string | null, opening: number, change: number, items: unknown[], equity = '2091') {
  return getPool().query<{ voucher_number: number | null }>(COMMIT_SQL, [
    seed.companyId,
    entryId,
    equity,
    opening,
    change,
    JSON.stringify(items),
  ])
}

async function storno(seed: Seed, entryId: string) {
  const stornoId = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id)
       VALUES ($1, $2, $3, $4, 900, 'A', '2026-12-31', 'Makulering', 'storno', 'draft', $5)`,
      [stornoId, seed.userId, seed.companyId, seed.fiscalPeriodId, entryId],
    )
    await client.query(
      `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT $1, account_number, credit_amount, debit_amount FROM public.journal_entry_lines WHERE journal_entry_id = $2`,
      [stornoId, entryId],
    )
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [stornoId])
    await client.query('COMMIT')
  } finally {
    client.release()
  }
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
    [entryId, stornoId],
  )
}

describe('k3_transitions', () => {
  it('holds one transition per company, on its own fiscal year, committed only by the RPC', async () => {
    const seed = await company()
    const other = await company()
    await expect(
      getPool().query(`INSERT INTO public.k3_transitions (company_id, fiscal_period_id) VALUES ($1, $2)`, [
        seed.companyId,
        other.fiscalPeriodId,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(
        `INSERT INTO public.k3_transitions (company_id, fiscal_period_id, committed_at) VALUES ($1, $2, now())`,
        [seed.companyId, seed.fiscalPeriodId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    const id = await startTransition(seed)
    await expect(startTransition(seed)).rejects.toMatchObject({ code: '23505' })
    await expect(
      getPool().query(`UPDATE public.k3_transitions SET committed_at = now() WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.k3_transitions SET relief_rules = ARRAY['35.27'] WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('split_asset_at_k3_transition', () => {
  it('divides the asset at the transition: the components hold its cost and the accumulated depreciation', async () => {
    const seed = await company()
    const assetId = await depreciatedBuilding(seed)
    const transitionId = await startTransition(seed)
    await split(seed, assetId)

    const { rows: components } = await getPool().query<{
      name: string
      cost: string
      opening_accumulated_depreciation: string
      opening_depreciation_date: string | null
      acquisition_date: string
    }>(
      `SELECT name, cost, opening_accumulated_depreciation,
              to_char(opening_depreciation_date, 'YYYY-MM-DD') AS opening_depreciation_date,
              to_char(acquisition_date, 'YYYY-MM-DD') AS acquisition_date
         FROM public.asset_components WHERE asset_id = $1 ORDER BY sort_order`,
      [assetId],
    )
    expect(components.map((row) => [row.name, Number(row.cost), Number(row.opening_accumulated_depreciation), row.opening_depreciation_date])).toEqual([
      ['Stomme', 692_307.69, 92_307.69, '2025-12-31'],
      ['Tak', 207_692.31, 27_692.31, '2025-12-31'],
      ['Mark', 100_000, 0, null],
    ])
    expect(components.every((row) => row.acquisition_date === '2016-01-01')).toBe(true)

    const asset = await assetRow(assetId)
    expect(Number(asset.acquisition_cost)).toBe(1_000_000)
    expect(Number(asset.opening_accumulated_depreciation)).toBe(120_000)
    expect(asset.opening_depreciation_date).toBe('2025-12-31')

    const { rows: splits } = await getPool().query(
      `SELECT transition_id, to_char(split_date, 'YYYY-MM-DD') AS split_date, carried_accumulated,
              original_opening, to_char(original_opening_date, 'YYYY-MM-DD') AS original_opening_date
         FROM public.asset_transition_splits WHERE asset_id = $1`,
      [assetId],
    )
    expect(splits).toHaveLength(1)
    expect(splits[0]).toMatchObject({ transition_id: transitionId, split_date: '2026-01-01', original_opening_date: '2024-12-31' })
    expect(Number(splits[0].carried_accumulated)).toBe(120_000)
    expect(Number(splits[0].original_opening)).toBe(108_000)
  })

  it('refuses a split that does not hold the asset\'s cost and accumulated depreciation', async () => {
    const seed = await company()
    const assetId = await depreciatedBuilding(seed)
    await startTransition(seed)
    const short = SPLIT.map((row, index) => (index === 0 ? { ...row, opening_accumulated_depreciation: 80_307.69, cost: 680_307.69 } : row))
    await expect(split(seed, assetId, short)).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_COMPONENTS_CHANGED' })
  })

  it('moves a split component\'s basis only with the split, and undoes the split exactly', async () => {
    const seed = await company()
    const assetId = await depreciatedBuilding(seed)
    await startTransition(seed)
    await split(seed, assetId)
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.asset_components WHERE asset_id = $1 AND name = 'Tak'`,
      [assetId],
    )
    await expect(
      getPool().query(`UPDATE public.asset_components SET cost = cost + 1 WHERE id = $1`, [rows[0].id]),
    ).rejects.toMatchObject({ code: 'PT409' })
    await expect(getPool().query(`DELETE FROM public.asset_components WHERE id = $1`, [rows[0].id])).rejects.toMatchObject({
      code: 'PT409',
    })
    // An estimate stays editable (K3 10.9-10.10).
    await getPool().query(`UPDATE public.asset_components SET useful_life_months = 420 WHERE id = $1`, [rows[0].id])

    // Made again with other lives, then undone.
    await split(seed, assetId, SPLIT.map((row) => (row.name === 'Tak' ? { ...row, useful_life_months: 360 } : row)))
    await split(seed, assetId, [])
    const asset = await assetRow(assetId)
    expect(Number(asset.opening_accumulated_depreciation)).toBe(108_000)
    expect(asset.opening_depreciation_date).toBe('2024-12-31')
    expect(asset.k3_components).toBeNull()
    const { rows: left } = await getPool().query(`SELECT 1 FROM public.asset_components WHERE asset_id = $1`, [assetId])
    expect(left).toHaveLength(0)
    const { rows: splits } = await getPool().query(`SELECT 1 FROM public.asset_transition_splits WHERE asset_id = $1`, [assetId])
    expect(splits).toHaveLength(0)
  })

  it('refuses before the start, after depreciation from the transition date, mark and an asset acquired under K3', async () => {
    const seed = await company()
    const assetId = await depreciatedBuilding(seed)
    await expect(split(seed, assetId)).rejects.toMatchObject({ code: 'PT409', message: 'K3_TRANSITION_NOT_STARTED' })
    await startTransition(seed)

    const land = await insertAsset(seed, { category: 'land' })
    await expect(split(seed, land)).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_NOT_SPLITTABLE' })
    const newer = await insertAsset(seed, { acquired: '2026-03-01' })
    await expect(split(seed, newer)).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_ACQUIRED_UNDER_K3' })

    const posted = await insertAsset(seed, { opening: 108_000, openingDate: '2024-12-31' })
    await postDepreciation(seed, posted, 12_000, seed.fiscalPeriodId, '2026-12-31')
    await expect(split(seed, posted)).rejects.toMatchObject({ code: 'PT409', message: 'LATER_DEPRECIATION_POSTED' })
  })
})

describe('commit_k3_transition', () => {
  it('posts the voucher against equity on the transition date and marks the transition committed', async () => {
    const seed = await company()
    const assetId = await depreciatedBuilding(seed)
    const transitionId = await startTransition(seed)
    const entryId = await insertDraft(seed, [
      ['2091', 20_600, 0],
      ['2240', 0, 20_600],
    ])
    const { rows } = await commit(seed, entryId, 20_600, 20_600, [buildingItem(20_600)])
    expect(rows[0].voucher_number).toBeGreaterThan(0)

    const { rows: transition } = await getPool().query(
      `SELECT journal_entry_id, committed_at, opening_deferred_tax, deferred_tax_items FROM public.k3_transitions WHERE id = $1`,
      [transitionId],
    )
    expect(transition[0].journal_entry_id).toBe(entryId)
    expect(transition[0].committed_at).not.toBeNull()
    expect(Number(transition[0].opening_deferred_tax)).toBe(20_600)
    expect(transition[0].deferred_tax_items).toHaveLength(1)

    // Committed: no second commit, no split, the year and relief stay; the notes do not.
    await expect(commit(seed, null, 0, 0, [])).rejects.toMatchObject({ code: 'PT409', message: 'K3_TRANSITION_COMMITTED' })
    await expect(split(seed, assetId)).rejects.toMatchObject({ code: 'PT409', message: 'K3_TRANSITION_COMMITTED' })
    await expect(
      getPool().query(`UPDATE public.k3_transitions SET deferred_tax_relief = true WHERE id = $1`, [transitionId]),
    ).rejects.toMatchObject({ code: 'PT409' })
    await getPool().query(
      `UPDATE public.k3_transitions SET relief_rules = ARRAY['35.22'], changed_principles = 'Komponentavskrivning (K3 17.4)' WHERE id = $1`,
      [transitionId],
    )
    await expect(getPool().query(`DELETE FROM public.k3_transitions WHERE id = $1`, [transitionId])).rejects.toMatchObject({
      code: 'PT409',
    })

    // A storno opens it again.
    await storno(seed, entryId)
    await expect(commit(seed, null, 0, 0, [])).resolves.toBeDefined()
  })

  it('refuses a result account, another equity account, a change other than stated and deferred tax under 35.27', async () => {
    const seed = await company()
    const transitionId = await startTransition(seed)
    const toResult = await insertDraft(seed, [
      ['8940', 20_600, 0],
      ['2240', 0, 20_600],
    ])
    await expect(commit(seed, toResult, 20_600, 20_600, [buildingItem(20_600)])).rejects.toMatchObject({ code: '23514' })
    const otherEquity = await insertDraft(seed, [
      ['2081', 20_600, 0],
      ['2240', 0, 20_600],
    ])
    await expect(commit(seed, otherEquity, 20_600, 20_600, [buildingItem(20_600)])).rejects.toMatchObject({ code: '23514' })
    const wrongChange = await insertDraft(seed, [
      ['2091', 10_000, 0],
      ['2240', 0, 10_000],
    ])
    await expect(commit(seed, wrongChange, 20_600, 20_600, [buildingItem(20_600)])).rejects.toMatchObject({ code: '23514' })
    await expect(commit(seed, null, 20_600, 0, [buildingItem(10_000)])).rejects.toMatchObject({ code: '23514' })

    await getPool().query(`UPDATE public.k3_transitions SET deferred_tax_relief = true WHERE id = $1`, [transitionId])
    await expect(commit(seed, null, 20_600, 0, [buildingItem(20_600)])).rejects.toMatchObject({ code: '23514' })
    await expect(commit(seed, null, 0, 0, [])).resolves.toBeDefined()
  })

  it('refuses capitalising expensed development at the transition (35.16)', async () => {
    const seed = await company()
    await startTransition(seed)
    const development = await insertDraft(seed, [
      ['1010', 300_000, 0],
      ['2091', 0, 300_000],
    ])
    await expect(commit(seed, development, 0, 0, [])).rejects.toMatchObject({ code: '23514' })
    const written = await insertDraft(seed, [
      ['2091', 50_000, 0],
      ['1019', 0, 50_000],
    ])
    await expect(commit(seed, written, 0, 0, [])).rejects.toMatchObject({ code: '23514' })
    const other = await insertDraft(seed, [
      ['1090', 30_000, 0],
      ['2091', 0, 30_000],
    ])
    await expect(commit(seed, other, 0, 0, [])).resolves.toBeDefined()
  })

  it('wants the 29.29 reason for a loss carried into the first K3 year, and keeps it', async () => {
    const seed = await company()
    await startTransition(seed)
    const loss = {
      kind: 'loss_carryforward',
      label: 'Underskottsavdrag',
      carrying_amount: 0,
      tax_value: 100_000,
      temporary_difference: -100_000,
      tax_rate: 0.206,
      deferred_tax: -20_600,
    }
    const draft = await insertDraft(seed, [
      ['1370', 20_600, 0],
      ['2091', 0, 20_600],
    ])
    await expect(commit(seed, draft, -20_600, -20_600, [loss])).rejects.toMatchObject({ code: '22023' })
    await commit(seed, draft, -20_600, -20_600, [{ ...loss, reason: 'Ny storkund ger överskott.' }])
    const { rows } = await getPool().query<{ deferred_tax_items: Array<{ reason?: string }> }>(
      `SELECT deferred_tax_items FROM public.k3_transitions WHERE company_id = $1`,
      [seed.companyId],
    )
    expect(rows[0].deferred_tax_items[0].reason).toBe('Ny storkund ger överskott.')
  })
})

describe('the transition year\'s own framework', () => {
  // B1: companies.accounting_framework is the latest year's. A K2 year (2025
  // here, or a 2026 switched back to K2) takes no transition.
  it('refuses to start the transition on a K2 year', async () => {
    const seed = await company()
    await expect(
      getPool().query(`INSERT INTO public.k3_transitions (company_id, fiscal_period_id) VALUES ($1, $2)`, [
        seed.companyId,
        seed.previousPeriodId,
      ]),
    ).rejects.toMatchObject({ code: 'PT409', message: 'K3_TRANSITION_NOT_K3' })
  })

  it('refuses the commit once the year is no longer K3', async () => {
    const seed = await company()
    await startTransition(seed)
    await getPool().query(`UPDATE public.fiscal_period_frameworks SET framework = 'k2' WHERE fiscal_period_id = $1`, [
      seed.fiscalPeriodId,
    ])
    await expect(commit(seed, null, 0, 0, [])).rejects.toMatchObject({ code: 'PT409', message: 'K3_TRANSITION_NOT_K3' })
  })
})
