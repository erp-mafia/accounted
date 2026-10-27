import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20261015180200_ideell_forening_medlemsavgifter_account.sql: an ideell
 * förening's chart carries 3901 Medlemsavgifter, the account behind the first
 * income post of its förenklat årsbokslut (BFNAR 2010:1 bilaga 2). New
 * föreningar get it from the seed; existing ones from the backfill, which is
 * replayed here from the migration file itself.
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261015180200_ideell_forening_medlemsavgifter_account.sql'),
  'utf8',
)

/**
 * Replays the migration's backfill. The file also redefines
 * seed_chart_of_accounts() with the body it had then; pg-real runs every test
 * file against one database, so the current body (a later migration's) is put
 * back afterwards, or the files after this one would seed an older chart.
 */
async function replayMigration(): Promise<void> {
  const current = await getPool().query<{ def: string }>(
    `SELECT pg_get_functiondef('public.seed_chart_of_accounts(uuid, text)'::regprocedure) AS def`,
  )
  try {
    await getPool().query(MIGRATION_SQL)
  } finally {
    await getPool().query(current.rows[0].def)
  }
}

interface ChartRow {
  account_number: string
  account_name: string
  sru_code: string | null
}

async function account(companyId: string, number: string): Promise<ChartRow | undefined> {
  const res = await getPool().query<ChartRow>(
    `SELECT account_number, account_name, sru_code FROM public.chart_of_accounts
      WHERE company_id = $1 AND account_number = $2`,
    [companyId, number],
  )
  return res.rows[0]
}

async function seeded(entityType: 'ideell_forening' | 'aktiebolag' | 'ekonomisk_forening'): Promise<string> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType })
  await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [companyId, entityType])
  return companyId
}

describe('ideell förening: 3901 Medlemsavgifter in the seed', () => {
  it('seeds 3901 for a new ideell förening, without an SRU code (INK3 is not modelled)', async () => {
    const companyId = await seeded('ideell_forening')
    expect(await account(companyId, '3901')).toEqual({
      account_number: '3901',
      account_name: 'Medlemsavgifter',
      sru_code: null,
    })
  })

  it('keeps the ekonomisk förening 3901 on its INK2R code and gives an aktiebolag none', async () => {
    expect((await account(await seeded('ekonomisk_forening'), '3901'))?.sru_code).toBe('7413')
    expect(await account(await seeded('aktiebolag'), '3901')).toBeUndefined()
  })
})

describe('ideell förening: the 3901 backfill', () => {
  it('adds 3901 to an existing förening that lacks it, and leaves everyone else as they are', async () => {
    const lacking = await seeded('ideell_forening')
    await getPool().query(`DELETE FROM public.chart_of_accounts WHERE company_id = $1 AND account_number = '3901'`, [
      lacking,
    ])
    const ownAccount = await seeded('ideell_forening')
    await getPool().query(
      `UPDATE public.chart_of_accounts SET account_name = 'Egna medlemsintäkter'
        WHERE company_id = $1 AND account_number = '3901'`,
      [ownAccount],
    )
    const aktiebolag = await seeded('aktiebolag')
    const userId = await insertAuthUser()
    const emptyChart = await insertCompany({ createdBy: userId, entityType: 'ideell_forening' })

    await replayMigration()

    expect(await account(lacking, '3901')).toEqual({
      account_number: '3901',
      account_name: 'Medlemsavgifter',
      sru_code: null,
    })
    expect((await account(ownAccount, '3901'))?.account_name).toBe('Egna medlemsintäkter')
    expect(await account(aktiebolag, '3901')).toBeUndefined()
    // A company with no chart at all gets it from the seed, not the backfill.
    expect(await account(emptyChart, '3901')).toBeUndefined()
  })

  it('is safe to run twice', async () => {
    const companyId = await seeded('ideell_forening')
    await replayMigration()
    await replayMigration()
    const res = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.chart_of_accounts WHERE company_id = $1 AND account_number = '3901'`,
      [companyId],
    )
    expect(res.rows[0].n).toBe(1)
  })
})
