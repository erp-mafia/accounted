import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPool } from '@/tests/pg/setup'

/**
 * Migration 20261121133000: the system seed for debiterad preliminärskatt
 * proposes 2518 Betald F-skatt for a legal person, not the 2510 summary
 * account. The enskild firma column stays 2013 (an eget uttag).
 */

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261121133000_skattekonto_rules_f_skatt_2518.sql'),
  'utf8',
)

async function preliminarySeed() {
  const res = await getPool().query<{ counter_account: string; counter_account_ef: string | null }>(
    `SELECT counter_account, counter_account_ef FROM public.skattekonto_rules
      WHERE company_id IS NULL AND pattern LIKE '%preliminärskatt%'`,
  )
  return res.rows
}

describe('skattekonto_rules.pg: preliminärskatt seed on 2518 (20261121133000)', () => {
  it('proposes 2518 for a legal person and keeps 2013 for an enskild firma', async () => {
    expect(await preliminarySeed()).toEqual([{ counter_account: '2518', counter_account_ef: '2013' }])
  })

  it('is idempotent: a replay leaves the seed unchanged', async () => {
    await getPool().query(MIGRATION_SQL)
    expect(await preliminarySeed()).toEqual([{ counter_account: '2518', counter_account_ef: '2013' }])
  })
})
