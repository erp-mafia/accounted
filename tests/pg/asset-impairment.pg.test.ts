import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertFiscalPeriod, seedCompany } from './fixtures'

/**
 * Migration 20261031200301_asset_impairment_land_start: nedskrivning (ÅRL
 * 4:5, K3 27), mark that is never depreciated, and the depreciation start
 * date (K3 17.18).
 *
 * Pinned here:
 *   - a land asset has useful_life_months 0 and nothing depreciation-shaped;
 *     0 months is refused for every other category;
 *   - depreciation_start_date is not before the acquisition and locks once a
 *     planenlig avskrivning has posted;
 *   - commit_asset_value_adjustment posts a write-down or reversal on the
 *     balansdag, capped at the carrying amount or the write-down
 *     outstanding, never a goodwill reversal, never behind later
 *     depreciation, and only a voucher that books exactly the amount;
 *   - a row counts while its voucher is posted: after the storno, nothing is
 *     outstanding;
 *   - a component asset allocates the write-down over its active components;
 *     an impaired component cannot be replaced, and a plain asset written
 *     down cannot be split into components;
 *   - the rows are immutable, and a written-down asset is "the books" for
 *     delete_never_posted_asset and the opening lock.
 */

type Seed = { userId: string; companyId: string; fiscalPeriodId: string }

const ADJUST_SQL = `SELECT * FROM public.commit_asset_value_adjustment(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::date, $7::numeric,
  $8::numeric, $9::text, $10::text, $11::text, $12::jsonb
)`

const DEPRECIATE_SQL = `SELECT * FROM public.commit_asset_depreciation(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric,
  0::numeric, NULL::date, NULL::text, NULL::text, $6::jsonb
)`

async function insertAsset(
  seed: Seed,
  values: {
    category?: string
    cost?: number
    life?: number
    asset?: string
    accumulated?: string
    expense?: string
    start?: string | null
    opening?: number
    openingDate?: string | null
  } = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.assets (
       id, user_id, company_id, name, category, acquisition_date,
       acquisition_cost, salvage_value, useful_life_months,
       depreciation_method, bas_asset_account, bas_accumulated_account,
       bas_expense_account, depreciation_start_date,
       opening_accumulated_depreciation, opening_depreciation_date
     ) VALUES ($1, $2, $3, 'Tillgång', $4, '2026-01-01', $5, 0, $6, 'linear',
               $7, $8, $9, $10, $11, $12)`,
    [
      id,
      seed.userId,
      seed.companyId,
      values.category ?? 'building',
      values.cost ?? 1_000_000,
      values.life ?? 600,
      values.asset ?? '1110',
      values.accumulated ?? '1119',
      values.expense ?? '7821',
      values.start ?? null,
      values.opening ?? 0,
      values.openingDate ?? null,
    ],
  )
  return id
}

async function insertComponent(seed: Seed, assetId: string, name: string, cost: number, life: number | null, sort = 0) {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.asset_components (
       id, user_id, company_id, asset_id, name, cost, useful_life_months, acquisition_date, sort_order
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-01', $8)`,
    [id, seed.userId, seed.companyId, assetId, name, cost, life, sort],
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
     ) VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Nedskrivningstest', $6, 'draft')`,
    [
      entryId,
      seed.userId,
      seed.companyId,
      options.fiscalPeriodId ?? seed.fiscalPeriodId,
      options.entryDate ?? '2026-12-31',
      options.sourceType ?? 'system',
    ],
  )
  for (const [account, debit, credit] of lines) {
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4)`,
      [entryId, account, debit, credit],
    )
  }
  return entryId
}

function writeDownDraft(seed: Seed, amount: number, accounts: [string, string] = ['7720', '1118'], date?: string) {
  return insertDraft(seed, [
    [accounts[0], amount, 0],
    [accounts[1], 0, amount],
  ], { entryDate: date })
}

function reversalDraft(seed: Seed, amount: number, accounts: [string, string] = ['7770', '1118']) {
  return insertDraft(seed, [
    [accounts[1], amount, 0],
    [accounts[0], 0, amount],
  ])
}

function adjust(
  seed: Seed,
  assetId: string,
  entryId: string,
  kind: 'impairment' | 'impairment_reversal',
  amount: number,
  options: { date?: string; accounts?: [string, string]; components?: unknown; periodId?: string } = {},
) {
  const accounts = options.accounts ?? [kind === 'impairment' ? '7720' : '7770', '1118']
  return getPool().query<{ voucher_number: number }>(ADJUST_SQL, [
    seed.companyId,
    assetId,
    entryId,
    options.periodId ?? seed.fiscalPeriodId,
    kind,
    options.date ?? '2026-12-31',
    amount,
    500_000,
    'Marknadsvärdet har fallit betydligt (K3 27.4).',
    accounts[0],
    accounts[1],
    options.components === undefined ? null : JSON.stringify(options.components),
  ])
}

async function netImpairment(assetId: string, componentId: string | null = null): Promise<number> {
  const { rows } = await getPool().query<{ net: string }>(
    `SELECT public.asset_net_impairment($1, $2) AS net`,
    [assetId, componentId],
  )
  return Number(rows[0].net)
}

/** What reverseEntry() writes: a posted storno, then the original reversed. */
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

async function postDepreciation(seed: Seed, assetId: string, amount: number, periodId?: string, date?: string) {
  const entryId = await insertDraft(
    seed,
    [
      ['7821', amount, 0],
      ['1119', 0, amount],
    ],
    { sourceType: 'year_end', fiscalPeriodId: periodId, entryDate: date },
  )
  await getPool().query(DEPRECIATE_SQL, [seed.companyId, assetId, entryId, periodId ?? seed.fiscalPeriodId, amount, null])
  return entryId
}

describe('assets: land and the depreciation start date', () => {
  it('registers land with useful_life_months 0 and refuses 0 for any other category', async () => {
    const seed = await seedCompany()
    await expect(
      insertAsset(seed, { category: 'land', life: 0, asset: '1130', accumulated: '1118', expense: '7820' }),
    ).resolves.toBeTypeOf('string')
    await expect(insertAsset(seed, { category: 'building', life: 0 })).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a land asset with a useful life, an opening or a start date', async () => {
    const seed = await seedCompany()
    const land = { category: 'land', asset: '1130', accumulated: '1118', expense: '7820' }
    await expect(insertAsset(seed, { ...land, life: 120 })).rejects.toMatchObject({ code: '23514' })
    await expect(
      insertAsset(seed, { ...land, life: 0, opening: 1000, openingDate: '2026-06-30' }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(insertAsset(seed, { ...land, life: 0, start: '2026-03-01' })).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses components on a land asset', async () => {
    const seed = await seedCompany()
    const landId = await insertAsset(seed, { category: 'land', life: 0, asset: '1130', accumulated: '1118', expense: '7820' })
    await expect(insertComponent(seed, landId, 'Mark', 1_000_000, null)).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a start date before the acquisition and locks it once depreciation has posted', async () => {
    const seed = await seedCompany()
    await expect(insertAsset(seed, { start: '2025-12-31' })).rejects.toMatchObject({ code: '23514' })

    const assetId = await insertAsset(seed, { start: '2026-03-01' })
    await getPool().query(`UPDATE public.assets SET depreciation_start_date = '2026-04-01' WHERE id = $1`, [assetId])

    await postDepreciation(seed, assetId, 15_000)
    await expect(
      getPool().query(`UPDATE public.assets SET depreciation_start_date = '2026-05-01' WHERE id = $1`, [assetId]),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_CORRECTION_BLOCKED' })
    // Other edits still pass.
    await getPool().query(`UPDATE public.assets SET name = 'Kontorshus' WHERE id = $1`, [assetId])
  })
})

describe('commit_asset_value_adjustment', () => {
  it('posts a write-down on the balansdag and records it', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    await postDepreciation(seed, assetId, 20_000)
    const entryId = await writeDownDraft(seed, 180_000)

    const { rows } = await adjust(seed, assetId, entryId, 'impairment', 180_000)
    expect(rows[0].voucher_number).toBeGreaterThan(0)

    const { rows: stored } = await getPool().query<{ kind: string; amount: string; component_id: string | null; accumulated_account: string }>(
      `SELECT kind, amount, component_id, accumulated_account FROM public.asset_value_adjustments WHERE journal_entry_id = $1`,
      [entryId],
    )
    expect(stored).toEqual([{ kind: 'impairment', amount: '180000.00', component_id: null, accumulated_account: '1118' }])
    expect(await netImpairment(assetId)).toBe(180_000)
    const { rows: entry } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry[0].status).toBe('posted')
  })

  it('refuses a date that is not the last day of the fiscal year', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await writeDownDraft(seed, 10_000, undefined, '2026-06-30')
    await expect(
      adjust(seed, assetId, entryId, 'impairment', 10_000, { date: '2026-06-30' }),
    ).rejects.toMatchObject({ code: 'PT409', message: 'NOT_AT_BALANCE_SHEET_DATE' })
  })

  it('caps a write-down at the carrying amount', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed, { cost: 100_000 })
    await postDepreciation(seed, assetId, 20_000)
    const entryId = await writeDownDraft(seed, 80_000.01)
    await expect(adjust(seed, assetId, entryId, 'impairment', 80_000.01)).rejects.toMatchObject({
      code: 'PT409',
      message: 'EXCEEDS_CARRYING_AMOUNT',
    })
  })

  it('refuses a voucher that does not book the amount on the two accounts', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const wrongAccount = await insertDraft(seed, [
      ['7720', 10_000, 0],
      ['1119', 0, 10_000],
    ])
    await expect(adjust(seed, assetId, wrongAccount, 'impairment', 10_000)).rejects.toMatchObject({ code: '23514' })
    const wrongAmount = await writeDownDraft(seed, 9_000)
    await expect(adjust(seed, assetId, wrongAmount, 'impairment', 10_000)).rejects.toMatchObject({ code: '23514' })
  })

  it('reverses at most the write-down outstanding, and never on goodwill', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    await adjust(seed, assetId, await writeDownDraft(seed, 50_000), 'impairment', 50_000)

    const tooMuch = await reversalDraft(seed, 50_000.01)
    await expect(adjust(seed, assetId, tooMuch, 'impairment_reversal', 50_000.01)).rejects.toMatchObject({
      code: 'PT409',
      message: 'EXCEEDS_WRITE_DOWN',
    })
    await adjust(seed, assetId, await reversalDraft(seed, 20_000), 'impairment_reversal', 20_000)
    expect(await netImpairment(assetId)).toBe(30_000)

    const goodwill = await insertAsset(seed, { category: 'immaterial', asset: '1070', accumulated: '1079', expense: '7817', life: 60 })
    await adjust(seed, goodwill, await writeDownDraft(seed, 10_000, ['7710', '1078']), 'impairment', 10_000, {
      accounts: ['7710', '1078'],
    })
    const back = await reversalDraft(seed, 10_000, ['7760', '1078'])
    await expect(
      adjust(seed, goodwill, back, 'impairment_reversal', 10_000, { accounts: ['7760', '1078'] }),
    ).rejects.toMatchObject({ code: 'PT409', message: 'GOODWILL_REVERSAL_FORBIDDEN' })
  })

  it('refuses a write-down behind depreciation posted for a later year', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const nextYear = await insertFiscalPeriod({
      userId: seed.userId,
      companyId: seed.companyId,
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
      name: '2027',
    })
    await postDepreciation(seed, assetId, 20_000, nextYear, '2027-12-31')
    const entryId = await writeDownDraft(seed, 10_000)
    await expect(adjust(seed, assetId, entryId, 'impairment', 10_000)).rejects.toMatchObject({
      code: 'PT409',
      message: 'LATER_DEPRECIATION_POSTED',
    })
  })

  it('stops counting a write-down once its voucher is reversed', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await writeDownDraft(seed, 40_000)
    await adjust(seed, assetId, entryId, 'impairment', 40_000)
    await storno(seed, entryId)
    expect(await netImpairment(assetId)).toBe(0)
    const back = await reversalDraft(seed, 1_000)
    await expect(adjust(seed, assetId, back, 'impairment_reversal', 1_000)).rejects.toMatchObject({
      code: 'PT409',
      message: 'EXCEEDS_WRITE_DOWN',
    })
  })

  it('keeps the rows immutable and the asset on the books', async () => {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed)
    const entryId = await writeDownDraft(seed, 10_000)
    await adjust(seed, assetId, entryId, 'impairment', 10_000)

    await expect(
      getPool().query(`UPDATE public.asset_value_adjustments SET amount = 1 WHERE journal_entry_id = $1`, [entryId]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`DELETE FROM public.asset_value_adjustments WHERE journal_entry_id = $1`, [entryId]),
    ).rejects.toMatchObject({ code: '23514' })

    const { rows } = await getPool().query<{ outcome: string }>(
      `SELECT public.delete_never_posted_asset($1, $2) AS outcome`,
      [seed.companyId, assetId],
    )
    expect(rows[0].outcome).toBe('depreciation_posted')
    await expect(
      getPool().query(
        `UPDATE public.assets SET opening_accumulated_depreciation = 1000, opening_depreciation_date = '2026-06-30' WHERE id = $1`,
        [assetId],
      ),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_CORRECTION_BLOCKED' })
    await expect(insertComponent(seed, assetId, 'Stomme', 1_000_000, 1200)).rejects.toMatchObject({
      code: 'PT409',
      message: 'ASSET_CORRECTION_BLOCKED',
    })
  })
})

describe('commit_asset_value_adjustment on a component asset', () => {
  async function componentAsset() {
    const seed = await seedCompany()
    const assetId = await insertAsset(seed, { cost: 1 })
    const stomme = await insertComponent(seed, assetId, 'Stomme', 800_000, 1200, 0)
    const tak = await insertComponent(seed, assetId, 'Tak', 200_000, 300, 1)
    return { seed, assetId, stomme, tak }
  }

  it('requires the allocation over active components and records one row each', async () => {
    const { seed, assetId, stomme, tak } = await componentAsset()
    const entryId = await writeDownDraft(seed, 100_000)
    await expect(adjust(seed, assetId, entryId, 'impairment', 100_000)).rejects.toMatchObject({
      code: 'PT409',
      message: 'ASSET_COMPONENTS_CHANGED',
    })
    await expect(
      adjust(seed, assetId, entryId, 'impairment', 100_000, {
        components: [{ component_id: stomme, amount: 80_000 }, { component_id: tak, amount: 10_000 }],
      }),
    ).rejects.toMatchObject({ code: '23514' })

    await adjust(seed, assetId, entryId, 'impairment', 100_000, {
      components: [{ component_id: stomme, amount: 80_000 }, { component_id: tak, amount: 20_000 }],
    })
    expect(await netImpairment(assetId, stomme)).toBe(80_000)
    expect(await netImpairment(assetId, tak)).toBe(20_000)
  })

  it('caps each component at its own carrying amount', async () => {
    const { seed, assetId, stomme, tak } = await componentAsset()
    const entryId = await writeDownDraft(seed, 250_000)
    await expect(
      adjust(seed, assetId, entryId, 'impairment', 250_000, {
        components: [{ component_id: stomme, amount: 40_000 }, { component_id: tak, amount: 210_000 }],
      }),
    ).rejects.toMatchObject({ code: 'PT409', message: 'EXCEEDS_CARRYING_AMOUNT' })
  })

  it('refuses to replace a component with a write-down outstanding', async () => {
    const { seed, assetId, stomme, tak } = await componentAsset()
    await adjust(seed, assetId, await writeDownDraft(seed, 50_000), 'impairment', 50_000, {
      components: [{ component_id: stomme, amount: 40_000 }, { component_id: tak, amount: 10_000 }],
    })
    const replacement = await insertDraft(
      seed,
      [
        ['1110', 0, 200_000],
        ['7972', 200_000, 0],
      ],
      { entryDate: '2026-12-31' },
    )
    await expect(
      getPool().query(
        `SELECT * FROM public.commit_asset_component_replacement(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::numeric, $8::numeric, $9::jsonb
         )`,
        [seed.companyId, assetId, tak, replacement, seed.fiscalPeriodId, '2026-12-31', 0, 0, null],
      ),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_COMPONENT_IMPAIRED' })
  })
})
