import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

/**
 * Migration 20261031200101_asset_components: K3 components as register rows
 * with history.
 *
 * Pinned here:
 *   - the asset row is a projection of its active components (k3_components,
 *     acquisition_cost, salvage_value, opening), read-only to every other
 *     writer;
 *   - commit_asset_depreciation requires and records the per-component split
 *     of a component asset, summing to the voucher, covering exactly the
 *     active components with their opening snapshots; an asset without
 *     components posts as before;
 *   - a component's basis (cost, dates, opening) locks once its plan has
 *     posted, its life and salvage stay editable, and a posted component or
 *     split cannot be deleted;
 *   - a component cannot be added to an asset whose depreciation was posted
 *     as a whole;
 *   - commit_asset_component_replacement posts the derecognition voucher,
 *     marks the component, registers the replacement and moves the
 *     projection, and refuses a voucher that does not match the register;
 *   - a derecognition is released only by the storno of its voucher;
 *   - delete_never_posted_asset treats a derecognised component as the books.
 */

type Seed = { userId: string; companyId: string; fiscalPeriodId: string }

const COMMIT_SQL = `SELECT * FROM public.commit_asset_depreciation(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric,
  $6::numeric, $7::date, NULL::text, NULL::text, $8::jsonb
)`

const REPLACE_SQL = `SELECT * FROM public.commit_asset_component_replacement(
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::numeric, $8::numeric, $9::jsonb
)`

async function insertBuilding(seed: Seed, cost = 1_000_000): Promise<string> {
  const assetId = randomUUID()
  await getPool().query(
    `INSERT INTO public.assets (
       id, user_id, company_id, name, category, acquisition_date,
       acquisition_cost, salvage_value, useful_life_months,
       depreciation_method, bas_asset_account, bas_accumulated_account,
       bas_expense_account
     ) VALUES ($1, $2, $3, 'Fastighet', 'building', '2026-01-01',
               $4, 0, 600, 'linear', '1110', '1119', '7821')`,
    [assetId, seed.userId, seed.companyId, cost],
  )
  return assetId
}

async function insertComponent(
  seed: Seed,
  assetId: string,
  values: {
    name: string
    cost: number
    life: number | null
    salvage?: number
    opening?: number
    openingDate?: string | null
    acquired?: string
    sort?: number
  },
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.asset_components (
       id, user_id, company_id, asset_id, name, cost, useful_life_months,
       salvage_value, acquisition_date, opening_accumulated_depreciation,
       opening_depreciation_date, sort_order
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id,
      seed.userId,
      seed.companyId,
      assetId,
      values.name,
      values.cost,
      values.life,
      values.salvage ?? 0,
      values.acquired ?? '2026-01-01',
      values.opening ?? 0,
      values.openingDate ?? null,
      values.sort ?? 0,
    ],
  )
  return id
}

async function insertDraft(
  seed: Seed,
  lines: Array<[string, number, number]>,
  options: { sourceType?: string; entryDate?: string } = {},
): Promise<string> {
  const entryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries (
       id, user_id, company_id, fiscal_period_id, voucher_number,
       voucher_series, entry_date, description, source_type, status
     ) VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Komponenttest', $6, 'draft')`,
    [
      entryId,
      seed.userId,
      seed.companyId,
      seed.fiscalPeriodId,
      options.entryDate ?? '2026-12-31',
      options.sourceType ?? 'year_end',
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

function depreciationDraft(seed: Seed, amount: number) {
  return insertDraft(seed, [
    ['7821', amount, 0],
    ['1119', 0, amount],
  ])
}

function split(entries: Array<[string, number, number?, string?]>) {
  return JSON.stringify(
    entries.map(([componentId, amount, opening, openingDate]) => ({
      component_id: componentId,
      amount,
      expected_opening_amount: opening ?? 0,
      expected_opening_date: openingDate ?? null,
    })),
  )
}

async function assetRow(assetId: string) {
  const { rows } = await getPool().query<{
    acquisition_cost: string
    salvage_value: string
    opening_accumulated_depreciation: string
    opening_depreciation_date: string | null
    k3_components: Array<{ component_id: string; cost: number }> | null
  }>(
    `SELECT acquisition_cost, salvage_value, opening_accumulated_depreciation,
            opening_depreciation_date::text AS opening_depreciation_date, k3_components
       FROM public.assets WHERE id = $1`,
    [assetId],
  )
  return rows[0]
}

/** Two components (stomme 800 000 over 100 years, tak 200 000 over 25) on a fresh building. */
async function seedComponentAsset() {
  const seed = await seedCompany()
  const assetId = await insertBuilding(seed)
  const stomme = await insertComponent(seed, assetId, { name: 'Stomme', cost: 800_000, life: 1200, sort: 0 })
  const tak = await insertComponent(seed, assetId, { name: 'Tak', cost: 200_000, life: 300, sort: 1 })
  return { ...seed, assetId, stomme, tak }
}

async function postYear(s: Awaited<ReturnType<typeof seedComponentAsset>>, stomme = 8000, tak = 8000) {
  const total = stomme + tak
  const entryId = await depreciationDraft(s, total)
  const { rows } = await getPool().query<{ voucher_number: number; schedule_id: string }>(COMMIT_SQL, [
    s.companyId,
    s.assetId,
    entryId,
    s.fiscalPeriodId,
    total,
    0,
    null,
    split([
      [s.stomme, stomme],
      [s.tak, tak],
    ]),
  ])
  return { entryId, scheduleId: rows[0].schedule_id }
}

describe('asset_components: the asset row is a projection', () => {
  it('sums the active components into cost, salvage and opening, and lists them in k3_components', async () => {
    const seed = await seedCompany()
    const assetId = await insertBuilding(seed, 1)
    await insertComponent(seed, assetId, { name: 'Stomme', cost: 600_000, life: 1200, opening: 60_000, openingDate: '2026-06-30' })
    await insertComponent(seed, assetId, { name: 'Mark', cost: 400_000, life: null, sort: 1 })

    const row = await assetRow(assetId)
    expect(Number(row.acquisition_cost)).toBe(1_000_000)
    expect(Number(row.salvage_value)).toBe(0)
    expect(Number(row.opening_accumulated_depreciation)).toBe(60_000)
    expect(row.opening_depreciation_date).toBe('2026-06-30')
    expect(row.k3_components?.map((c) => Number(c.cost))).toEqual([600_000, 400_000])
  })

  it('refuses a direct write of k3_components, and of the cost of a component asset', async () => {
    const s = await seedComponentAsset()
    await expect(
      getPool().query(`UPDATE public.assets SET k3_components = '[]'::jsonb WHERE id = $1`, [s.assetId]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.assets SET acquisition_cost = 5 WHERE id = $1`, [s.assetId]),
    ).rejects.toMatchObject({ code: '23514' })
    // A plain asset keeps its own cost.
    const plain = await insertBuilding(await seedCompany())
    await getPool().query(`UPDATE public.assets SET acquisition_cost = 5 WHERE id = $1`, [plain])
  })

  it('refuses an insert carrying k3_components', async () => {
    const seed = await seedCompany()
    await expect(
      getPool().query(
        `INSERT INTO public.assets (user_id, company_id, name, category, acquisition_date,
           acquisition_cost, useful_life_months, bas_asset_account, bas_accumulated_account,
           bas_expense_account, k3_components)
         VALUES ($1, $2, 'X', 'building', '2026-01-01', 100, 60, '1110', '1119', '7821',
                 '[{"name":"a","cost":100,"useful_life_months":60}]'::jsonb)`,
        [seed.userId, seed.companyId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('validates a backfill element the way the old schema did', async () => {
    const { rows } = await getPool().query<{ ok: boolean }>(
      `SELECT public.asset_component_backfill_valid(v) AS ok FROM (VALUES
         ('{"name":"a","cost":100,"useful_life_months":60}'::jsonb),
         ('{"name":"a","cost":"x","useful_life_months":60}'::jsonb),
         ('{"name":"a","cost":100,"useful_life_months":60,"salvage_value":200}'::jsonb),
         ('{"name":"a","cost":0,"useful_life_months":60}'::jsonb)
       ) AS t(v)`,
    )
    expect(rows.map((r) => r.ok)).toEqual([true, false, false, false])
  })
})

describe('commit_asset_depreciation: the component split', () => {
  it('posts and records the split, summing to the voucher', async () => {
    const s = await seedComponentAsset()
    const { scheduleId } = await postYear(s)
    const { rows } = await getPool().query<{ component_id: string; amount: string }>(
      `SELECT component_id, amount FROM public.depreciation_schedule_components
        WHERE schedule_id = $1 ORDER BY amount`,
      [scheduleId],
    )
    expect(rows.map((r) => Number(r.amount)).reduce((a, b) => a + b, 0)).toBe(16_000)
    expect(new Set(rows.map((r) => r.component_id))).toEqual(new Set([s.stomme, s.tak]))
  })

  it('refuses a component asset without a split, a split that misses a component, and one that does not sum', async () => {
    const s = await seedComponentAsset()
    const args = (entryId: string, components: string | null) => [
      s.companyId, s.assetId, entryId, s.fiscalPeriodId, 16_000, 0, null, components,
    ]
    await expect(
      getPool().query(COMMIT_SQL, args(await depreciationDraft(s, 16_000), null)),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_COMPONENTS_CHANGED' })
    await expect(
      getPool().query(COMMIT_SQL, args(await depreciationDraft(s, 16_000), split([[s.stomme, 16_000]]))),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_COMPONENTS_CHANGED' })
    await expect(
      getPool().query(
        COMMIT_SQL,
        args(await depreciationDraft(s, 16_000), split([[s.stomme, 8000], [s.tak, 7000]])),
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a stale component opening snapshot', async () => {
    const seed = await seedCompany()
    const assetId = await insertBuilding(seed)
    const a = await insertComponent(seed, assetId, { name: 'A', cost: 500_000, life: 600, opening: 10_000, openingDate: '2026-01-31' })
    const b = await insertComponent(seed, assetId, { name: 'B', cost: 500_000, life: 600, sort: 1 })
    const entryId = await depreciationDraft(seed, 2000)
    await expect(
      getPool().query(COMMIT_SQL, [
        seed.companyId, assetId, entryId, seed.fiscalPeriodId, 2000, 10_000, '2026-01-31',
        split([[a, 1000], [b, 1000]]),
      ]),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_OPENING_CHANGED' })
  })

  it('posts an asset without components as before, and refuses a split for it', async () => {
    const seed = await seedCompany()
    const assetId = await insertBuilding(seed)
    const entryId = await depreciationDraft(seed, 5000)
    await expect(
      getPool().query(COMMIT_SQL, [
        seed.companyId, assetId, entryId, seed.fiscalPeriodId, 5000, 0, null,
        split([[randomUUID(), 5000]]),
      ]),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_COMPONENTS_CHANGED' })
    const ok = await depreciationDraft(seed, 5000)
    const { rows } = await getPool().query(COMMIT_SQL, [
      seed.companyId, assetId, ok, seed.fiscalPeriodId, 5000, 0, null, null,
    ])
    expect(rows).toHaveLength(1)
  })
})

describe('asset_components: locks once posted', () => {
  it('locks cost and opening of a posted component, keeps its life editable', async () => {
    const s = await seedComponentAsset()
    await postYear(s)
    await expect(
      getPool().query(`UPDATE public.asset_components SET cost = 1 WHERE id = $1`, [s.tak]),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_CORRECTION_BLOCKED' })
    await expect(
      getPool().query(
        `UPDATE public.asset_components
            SET opening_accumulated_depreciation = 100, opening_depreciation_date = '2026-06-30'
          WHERE id = $1`,
        [s.tak],
      ),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_CORRECTION_BLOCKED' })
    await getPool().query(`UPDATE public.asset_components SET useful_life_months = 240 WHERE id = $1`, [s.tak])
  })

  it('refuses deleting a posted component and its split rows', async () => {
    const s = await seedComponentAsset()
    const { scheduleId } = await postYear(s)
    await expect(
      getPool().query(`DELETE FROM public.asset_components WHERE id = $1`, [s.tak]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`DELETE FROM public.depreciation_schedule_components WHERE schedule_id = $1`, [scheduleId]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`UPDATE public.depreciation_schedule_components SET amount = 0 WHERE schedule_id = $1`, [scheduleId]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses a component on an asset whose depreciation was posted as a whole', async () => {
    const seed = await seedCompany()
    const assetId = await insertBuilding(seed)
    const entryId = await depreciationDraft(seed, 5000)
    await getPool().query(COMMIT_SQL, [seed.companyId, assetId, entryId, seed.fiscalPeriodId, 5000, 0, null, null])
    await expect(
      insertComponent(seed, assetId, { name: 'Tak', cost: 100, life: 300 }),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_CORRECTION_BLOCKED' })
  })

  it('takes a tillkommande component on a component asset with history, without an opening', async () => {
    const s = await seedComponentAsset()
    await postYear(s)
    await insertComponent(s, s.assetId, { name: 'Hiss', cost: 50_000, life: 300, acquired: '2026-12-31', sort: 2 })
    expect(Number((await assetRow(s.assetId)).acquisition_cost)).toBe(1_050_000)
    await expect(
      insertComponent(s, s.assetId, { name: 'Ventilation', cost: 50_000, life: 300, opening: 10, openingDate: '2026-12-31', acquired: '2026-12-31' }),
    ).rejects.toMatchObject({ code: 'PT409' })
  })
})

describe('commit_asset_component_replacement', () => {
  async function replacementDraft(s: { userId: string; companyId: string; fiscalPeriodId: string }, opts: {
    cost: number
    toDate: number
    accumulated: number
    loss: number
    date: string
  }) {
    const lines: Array<[string, number, number]> = []
    if (opts.toDate > 0) lines.push(['7821', opts.toDate, 0], ['1119', 0, opts.toDate])
    if (opts.accumulated > 0) lines.push(['1119', opts.accumulated, 0])
    lines.push(['1110', 0, opts.cost])
    if (opts.loss > 0) lines.push(['7972', opts.loss, 0])
    return insertDraft(s, lines, { sourceType: 'system', entryDate: opts.date })
  }

  it('posts the voucher, derecognises the component, registers the new one and moves the projection', async () => {
    const s = await seedComponentAsset()
    const entryId = await replacementDraft(s, {
      cost: 200_000, toDate: 4000, accumulated: 4000, loss: 196_000, date: '2026-06-30',
    })
    const { rows } = await getPool().query<{ voucher_number: number; new_component_id: string }>(REPLACE_SQL, [
      s.companyId, s.assetId, s.tak, entryId, s.fiscalPeriodId, '2026-06-30', 4000, 4000,
      JSON.stringify({ name: 'Nytt tak', cost: 250_000, useful_life_months: 360 }),
    ])
    expect(rows[0].voucher_number).toBeGreaterThan(0)

    const { rows: comps } = await getPool().query<{
      id: string
      derecognised_at: string | null
      derecognition_depreciation: string
      replaces_component_id: string | null
      acquisition_date: string
    }>(
      `SELECT id, derecognised_at::text, derecognition_depreciation, replaces_component_id,
              acquisition_date::text
         FROM public.asset_components WHERE asset_id = $1`,
      [s.assetId],
    )
    const old = comps.find((c) => c.id === s.tak)!
    expect(old.derecognised_at).toBe('2026-06-30')
    expect(Number(old.derecognition_depreciation)).toBe(4000)
    const fresh = comps.find((c) => c.id === rows[0].new_component_id)!
    expect(fresh.replaces_component_id).toBe(s.tak)
    expect(fresh.acquisition_date).toBe('2026-06-30')

    const asset = await assetRow(s.assetId)
    expect(Number(asset.acquisition_cost)).toBe(1_050_000)
    expect(asset.k3_components?.map((c) => c.component_id).sort()).toEqual([s.stomme, fresh.id].sort())

    const { rows: entry } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry[0].status).toBe('posted')
  })

  it('refuses a voucher that does not take the component cost off the asset account', async () => {
    const s = await seedComponentAsset()
    const entryId = await replacementDraft(s, {
      cost: 150_000, toDate: 0, accumulated: 0, loss: 150_000, date: '2026-06-30',
    })
    await expect(
      getPool().query(REPLACE_SQL, [
        s.companyId, s.assetId, s.tak, entryId, s.fiscalPeriodId, '2026-06-30', 0, 0, null,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('refuses clearing an accumulated depreciation the register does not hold', async () => {
    const s = await seedComponentAsset()
    const entryId = await replacementDraft(s, {
      cost: 200_000, toDate: 0, accumulated: 5000, loss: 195_000, date: '2026-06-30',
    })
    await expect(
      getPool().query(REPLACE_SQL, [
        s.companyId, s.assetId, s.tak, entryId, s.fiscalPeriodId, '2026-06-30', 0, 5000, null,
      ]),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_COMPONENT_STATE_CHANGED' })
  })

  it('refuses the last component without a replacement: that is a disposal', async () => {
    const seed = await seedCompany()
    const assetId = await insertBuilding(seed)
    const only = await insertComponent(seed, assetId, { name: 'Allt', cost: 1_000_000, life: 600 })
    const entryId = await replacementDraft(seed, {
      cost: 1_000_000, toDate: 0, accumulated: 0, loss: 1_000_000, date: '2026-06-30',
    })
    await expect(
      getPool().query(REPLACE_SQL, [
        seed.companyId, assetId, only, entryId, seed.fiscalPeriodId, '2026-06-30', 0, 0, null,
      ]),
    ).rejects.toMatchObject({ code: 'PT409', message: 'ASSET_LAST_COMPONENT' })
  })

  it('refuses a mid-year derecognition once the year is depreciated', async () => {
    const s = await seedComponentAsset()
    await postYear(s)
    const entryId = await replacementDraft(s, {
      cost: 200_000, toDate: 0, accumulated: 8000, loss: 192_000, date: '2026-06-30',
    })
    await expect(
      getPool().query(REPLACE_SQL, [
        s.companyId, s.assetId, s.tak, entryId, s.fiscalPeriodId, '2026-06-30', 0, 8000, null,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps a derecognised component until the storno of its voucher releases it', async () => {
    const s = await seedComponentAsset()
    const entryId = await replacementDraft(s, {
      cost: 200_000, toDate: 0, accumulated: 0, loss: 200_000, date: '2026-06-30',
    })
    await getPool().query(REPLACE_SQL, [
      s.companyId, s.assetId, s.tak, entryId, s.fiscalPeriodId, '2026-06-30', 0, 0,
      JSON.stringify({ name: 'Nytt tak', cost: 200_000, useful_life_months: 300 }),
    ])

    const release = () =>
      getPool().query(
        `UPDATE public.asset_components
            SET derecognised_at = NULL, derecognition_journal_entry_id = NULL, derecognition_depreciation = 0
          WHERE id = $1`,
        [s.tak],
      )
    await expect(release()).rejects.toMatchObject({ code: '23514' })
    await expect(
      getPool().query(`DELETE FROM public.asset_components WHERE id = $1`, [s.tak]),
    ).rejects.toMatchObject({ code: '23514' })

    // What reverseEntry() writes: a posted storno, then the original reversed.
    const stornoId = randomUUID()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status, reverses_id)
         VALUES ($1, $2, $3, $4, 900, 'A', '2026-07-01', 'Makulering', 'storno', 'draft', $5)`,
        [stornoId, s.userId, s.companyId, s.fiscalPeriodId, entryId],
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

    await release()
    const asset = await assetRow(s.assetId)
    expect(asset.k3_components?.map((c) => c.component_id)).toContain(s.tak)
  })
})

describe('delete_never_posted_asset with components', () => {
  it('deletes a fresh component asset with its components', async () => {
    const s = await seedComponentAsset()
    const { rows } = await getPool().query<{ outcome: string }>(
      `SELECT public.delete_never_posted_asset($1, $2) AS outcome`,
      [s.companyId, s.assetId],
    )
    expect(rows[0].outcome).toBe('deleted')
    const { rowCount } = await getPool().query(`SELECT 1 FROM public.asset_components WHERE asset_id = $1`, [s.assetId])
    expect(rowCount).toBe(0)
  })

  it('answers depreciation_posted once a component was derecognised', async () => {
    const s = await seedComponentAsset()
    const entryId = await insertDraft(
      s,
      [
        ['1110', 0, 200_000],
        ['7972', 200_000, 0],
      ],
      { sourceType: 'system', entryDate: '2026-03-31' },
    )
    await getPool().query(REPLACE_SQL, [
      s.companyId, s.assetId, s.tak, entryId, s.fiscalPeriodId, '2026-03-31', 0, 0,
      JSON.stringify({ name: 'Nytt tak', cost: 200_000, useful_life_months: 300 }),
    ])
    const { rows } = await getPool().query<{ outcome: string }>(
      `SELECT public.delete_never_posted_asset($1, $2) AS outcome`,
      [s.companyId, s.assetId],
    )
    expect(rows[0].outcome).toBe('depreciation_posted')
  })
})
