import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20260908110045_backfill_bas2026_retired_12xx_labels.sql
 * (#2413).
 *
 * The backfill renames 1249/1259/1269 only where the chart carries the
 * contradictory pair the catalog used to hand out: a BAS 2026 free head
 * (1240/1250/1260) next to a contra account still named after the retired
 * bilar/inventarier/datorer accounts. Guards under test:
 *   - the pair is renamed (both catalog literals for the contra name)
 *   - an old-BAS chart (1240 "Bilar och andra transportmedel") is untouched
 *   - a user-renamed contra account is untouched
 *   - a contra account without its head is untouched
 *   - idempotent (re-run is a no-op)
 */

const BACKFILL_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260908110045_backfill_bas2026_retired_12xx_labels.sql'),
  'utf8',
)

const FREE_MASKINER = '(Fritt konto för Maskiner och andra tekniska anläggningar)'
const FREE_INVENTARIER = '(Fritt konto för Inventarier, verktyg och installationer)'
const CONTRA_MASKINER =
  'Ackumulerade avskrivningar (fritt konto för Maskiner och andra tekniska anläggningar)'
const CONTRA_INVENTARIER =
  'Ackumulerade avskrivningar (fritt konto för Inventarier, verktyg och installationer)'

async function runBackfill(): Promise<void> {
  await getPool().query(BACKFILL_SQL)
}

async function insertAccounts(
  userId: string,
  companyId: string,
  rows: Array<[number: string, name: string]>,
): Promise<void> {
  for (const [number, name] of rows) {
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class, account_group,
          account_type, normal_balance, is_active)
       VALUES ($1, $2, $3, $4, 1, '12', 'asset', $5, true)`,
      [userId, companyId, number, name, number.endsWith('9') ? 'credit' : 'debit'],
    )
  }
}

async function names(companyId: string): Promise<Record<string, string>> {
  const { rows } = await getPool().query<{ account_number: string; account_name: string }>(
    `SELECT account_number, account_name FROM public.chart_of_accounts WHERE company_id = $1`,
    [companyId],
  )
  return Object.fromEntries(rows.map((r) => [r.account_number, r.account_name]))
}

describe('backfill_bas2026_retired_12xx_labels', () => {
  it('renames the contra account under a BAS 2026 free head, both catalog literals', async () => {
    const { userId, companyId } = await seedCompany()
    await insertAccounts(userId, companyId, [
      ['1240', FREE_MASKINER],
      ['1249', 'Ack. avskrivningar på bilar och andra transportmedel'],
      ['1250', FREE_INVENTARIER],
      ['1259', 'Ackumulerade avskrivningar på inventarier och verktyg'],
      ['1260', FREE_INVENTARIER],
      ['1269', 'Ack. avskrivningar på datorer'],
    ])

    await runBackfill()

    const after = await names(companyId)
    expect(after['1249']).toBe(CONTRA_MASKINER)
    expect(after['1259']).toBe(CONTRA_INVENTARIER)
    expect(after['1269']).toBe(CONTRA_INVENTARIER)
    expect(after['1240']).toBe(FREE_MASKINER)
  })

  it('leaves an old-BAS chart alone: 1240 Bilar next to 1249 Ack. avskr. bilar is consistent', async () => {
    const { userId, companyId } = await seedCompany()
    await insertAccounts(userId, companyId, [
      ['1240', 'Bilar och andra transportmedel'],
      ['1249', 'Ackumulerade avskrivningar på bilar och andra transportmedel'],
      ['1250', 'Datorer'],
      ['1259', 'Ackumulerade avskrivningar på datorer'],
    ])

    await runBackfill()

    const after = await names(companyId)
    expect(after['1249']).toBe('Ackumulerade avskrivningar på bilar och andra transportmedel')
    expect(after['1259']).toBe('Ackumulerade avskrivningar på datorer')
  })

  it('leaves a user rename alone', async () => {
    const { userId, companyId } = await seedCompany()
    await insertAccounts(userId, companyId, [
      ['1240', FREE_MASKINER],
      ['1249', 'Ack. avskrivningar maskiner och andra tekniska anläggningar'],
    ])

    await runBackfill()

    expect((await names(companyId))['1249']).toBe(
      'Ack. avskrivningar maskiner och andra tekniska anläggningar',
    )
  })

  it('leaves a contra account without its free head alone', async () => {
    const { userId, companyId } = await seedCompany()
    await insertAccounts(userId, companyId, [
      ['1249', 'Ack. avskrivningar på bilar och andra transportmedel'],
    ])

    await runBackfill()

    expect((await names(companyId))['1249']).toBe(
      'Ack. avskrivningar på bilar och andra transportmedel',
    )
  })

  it('is idempotent', async () => {
    const { userId, companyId } = await seedCompany()
    await insertAccounts(userId, companyId, [
      ['1260', FREE_INVENTARIER],
      ['1269', 'Ackumulerade avskrivningar på datorer'],
    ])

    await runBackfill()
    const first = await names(companyId)
    await runBackfill()
    const second = await names(companyId)

    expect(first['1269']).toBe(CONTRA_INVENTARIER)
    expect(second).toEqual(first)
  })
})
