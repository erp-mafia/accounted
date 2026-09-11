import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * pg-real coverage for 20260911190100_backfill_seeded_account_sru_codes.sql
 * (#2517).
 *
 * Charts seeded between 2026-03-31 and 2026-06-12 got their system accounts
 * without sru_code. The backfill gives them exactly what the current
 * seed_chart_of_accounts() writes. Guards under test:
 *   - every backfilled number ends on the code a chart seeded today carries
 *     (the legacy 2610/2612 on the 2600-2799 code)
 *   - the seeded accounts that are NULL on purpose stay NULL
 *   - a code on a system account is never overwritten
 *   - accounts the user created (is_system_account = false) are untouched
 *   - one audit row per updated account, tagged as the system and this
 *     migration, never as the company's user (behandlingshistorik)
 *   - idempotent (re-run is a no-op: no new audit rows, updated_at does not move)
 */

const BACKFILL_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260911190100_backfill_seeded_account_sru_codes.sql'),
  'utf8',
)

// The 41 numbers the current aktiebolag seed shares with the old seeds,
// plus the two legacy numbers only the old seeds created.
const SEEDED_NUMBERS = [
  '1510', '1910', '1930', '1940',
  '2081', '2091', '2099', '2440',
  '2611', '2621', '2631', '2641', '2650', '2710', '2731', '2893',
  '3001', '3002', '3100', '3900', '3960',
  '4000',
  '5010', '5410', '5420', '5460', '5800', '5910',
  '6071', '6110', '6212', '6230', '6530', '6570', '6991',
  '7010', '7210', '7510', '7960',
  '8310', '8410',
]
const LEGACY_NUMBERS = ['2610', '2612']
const INTENTIONAL_NULL_NUMBERS = ['2010', '2013', '2018', '2067', '2068', '2069', '2890']

async function runBackfill(): Promise<void> {
  await getPool().query(BACKFILL_SQL)
}

async function insertAccount(params: {
  userId: string
  companyId: string
  number: string
  isSystem: boolean
  sruCode: string | null
}): Promise<void> {
  const cls = Number(params.number[0])
  await getPool().query(
    `INSERT INTO public.chart_of_accounts
       (user_id, company_id, account_number, account_name, account_class, account_group,
        account_type, normal_balance, plan_type, is_system_account, sru_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'k1', $9, $10)`,
    [
      params.userId,
      params.companyId,
      params.number,
      `Konto ${params.number}`,
      cls,
      params.number.slice(0, 2),
      cls === 1 ? 'asset' : cls === 2 ? 'liability' : cls === 3 ? 'revenue' : 'expense',
      cls === 1 || cls >= 4 ? 'debit' : 'credit',
      params.isSystem,
      params.sruCode,
    ],
  )
}

async function sruByNumber(companyId: string): Promise<Record<string, string | null>> {
  const { rows } = await getPool().query<{ account_number: string; sru_code: string | null }>(
    `SELECT account_number, sru_code FROM public.chart_of_accounts WHERE company_id = $1`,
    [companyId],
  )
  return Object.fromEntries(rows.map((r) => [r.account_number, r.sru_code]))
}

describe('backfill_seeded_account_sru_codes', () => {
  it('gives every seeded NULL account the code a chart seeded today carries', async () => {
    // Reference: a chart seeded by the current function.
    const reference = await seedCompany()
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, 'aktiebolag')`, [
      reference.companyId,
    ])
    const expected = await sruByNumber(reference.companyId)

    // An old-seed chart: the same system accounts, no sru_code.
    const legacy = await seedCompany()
    for (const number of [...SEEDED_NUMBERS, ...LEGACY_NUMBERS]) {
      await insertAccount({ ...legacy, number, isSystem: true, sruCode: null })
    }

    await runBackfill()

    const after = await sruByNumber(legacy.companyId)
    for (const number of SEEDED_NUMBERS) {
      expect(expected[number], `reference seed lacks ${number}`).toBeTruthy()
      expect(after[number], number).toBe(expected[number])
    }
    expect(after['2610']).toBe('7369')
    expect(after['2612']).toBe('7369')
  })

  it('leaves the seeded accounts that are NULL on purpose alone', async () => {
    const { userId, companyId } = await seedCompany()
    for (const number of INTENTIONAL_NULL_NUMBERS) {
      await insertAccount({ userId, companyId, number, isSystem: true, sruCode: null })
    }

    await runBackfill()

    const after = await sruByNumber(companyId)
    for (const number of INTENTIONAL_NULL_NUMBERS) {
      expect(after[number], number).toBeNull()
    }
  })

  it('never overwrites a code already on a system account', async () => {
    const { userId, companyId } = await seedCompany()
    await insertAccount({ userId, companyId, number: '1930', isSystem: true, sruCode: '7285' })

    await runBackfill()

    expect((await sruByNumber(companyId))['1930']).toBe('7285')
  })

  it('leaves accounts the user created alone', async () => {
    const { userId, companyId } = await seedCompany()
    await insertAccount({ userId, companyId, number: '1930', isSystem: false, sruCode: null })

    await runBackfill()

    expect((await sruByNumber(companyId))['1930']).toBeNull()
  })

  it('audits each change as the system, not the user, and is a no-op on re-run', async () => {
    const { userId, companyId } = await seedCompany()
    await insertAccount({ userId, companyId, number: '1510', isSystem: true, sruCode: null })
    const pool = getPool()
    const { rows: idRows } = await pool.query<{ id: string }>(
      `SELECT id FROM public.chart_of_accounts WHERE company_id = $1 AND account_number = '1510'`,
      [companyId],
    )
    const recordId = idRows[0].id
    const updateAudits = async () =>
      (
        await pool.query<{
          actor_type: string
          actor_label: string | null
          company_id: string
          old_sru: string | null
          new_sru: string | null
        }>(
          `SELECT actor_type, actor_label, company_id,
                  old_state->>'sru_code' AS old_sru, new_state->>'sru_code' AS new_sru
             FROM public.audit_log
            WHERE table_name = 'chart_of_accounts' AND record_id = $1 AND action = 'UPDATE'`,
          [recordId],
        )
      ).rows
    const updatedAt = async () =>
      (
        await pool.query<{ updated_at: Date }>(
          `SELECT updated_at FROM public.chart_of_accounts WHERE id = $1`,
          [recordId],
        )
      ).rows[0].updated_at.toISOString()

    expect(await updateAudits()).toHaveLength(0)
    await runBackfill()
    expect((await sruByNumber(companyId))['1510']).toBe('7251')
    const audits = await updateAudits()
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      actor_type: 'system',
      actor_label: 'migration 20260911190100 backfill_seeded_account_sru_codes',
      company_id: companyId,
      old_sru: null,
      new_sru: '7251',
    })

    const firstUpdatedAt = await updatedAt()
    await runBackfill()
    expect(await updatedAt()).toBe(firstUpdatedAt)
    expect(await updateAudits()).toHaveLength(1)
    expect((await sruByNumber(companyId))['1510']).toBe('7251')
  })
})
