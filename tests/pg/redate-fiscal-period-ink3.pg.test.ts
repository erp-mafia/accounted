/**
 * pg-real tests for 20261015180500_redate_blocks_filed_ink3.sql: an ideell
 * förening that has marked its Inkomstdeklaration 3 as filed cannot move the
 * räkenskapsår's dates afterwards, the same refusal (annual_filing) an
 * aktiebolag gets for a filed INK2 (redate-fiscal-period.pg.test.ts). An INK3
 * deadline that is not filed yet blocks nothing.
 */
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod } from '@/tests/pg/fixtures'

interface RedateResult {
  ok: boolean
  code?: string
  blockers?: Array<{ code: string; message_sv: string }>
}

interface Year {
  userId: string
  companyId: string
  periodId: string
}

const SQL = `SELECT public.redate_fiscal_period($1::uuid, $2::uuid, $3::date, $4::date, $5::text, $6::boolean, $7::uuid) AS result`

/** An ideell förening's first räkenskapsår, recorded one day late. */
async function seedForeningYear(): Promise<Year> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType: 'ideell_forening', name: 'Testföreningen' })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const periodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2025-04-24',
    periodEnd: '2026-08-31',
    name: 'Räkenskapsår 2025/2026',
  })
  return { userId, companyId, periodId }
}

async function insertInk3Deadline(year: Year, status: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.deadlines (company_id, user_id, title, due_date, deadline_type, tax_deadline_type, tax_period, status)
     VALUES ($1, $2, 'Inkomstdeklaration 3 2025/2026', '2027-04-01', 'tax', 'inkomstdeklaration_ideell_forening', '2025/2026', $3)`,
    [year.companyId, year.userId, status],
  )
}

async function redate(year: Year, start: string, dryRun = true): Promise<RedateResult> {
  const res = await runAsServiceRole((client) =>
    client.query<{ result: RedateResult }>(SQL, [year.companyId, year.periodId, start, null, null, dryRun, year.userId]),
  )
  return res.rows[0].result
}

describe('redate_fiscal_period: a filed INK3', () => {
  it.each(['submitted', 'confirmed'])('refuses to move a year whose INK3 is %s', async (status) => {
    const year = await seedForeningYear()
    await insertInk3Deadline(year, status)

    const result = await redate(year, '2025-04-23', false)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('FISCAL_PERIOD_DATES_BLOCKED')
    expect((result.blockers ?? []).map((b) => b.code)).toEqual(['annual_filing'])
    expect(result.blockers?.[0].message_sv).toBe('Följande är redan inlämnat för räkenskapsåret: inkomstdeklaration.')

    const { rows } = await getPool().query<{ period_start: string }>(
      `SELECT to_char(period_start, 'YYYY-MM-DD') AS period_start FROM public.fiscal_periods WHERE id = $1`,
      [year.periodId],
    )
    expect(rows[0].period_start).toBe('2025-04-24')
  })

  it('lets the year move while its INK3 is not filed yet', async () => {
    const year = await seedForeningYear()
    await insertInk3Deadline(year, 'upcoming')

    const result = await redate(year, '2025-04-23')
    expect(result.blockers ?? []).toEqual([])
    expect(result.ok).toBe(true)
  })
})
