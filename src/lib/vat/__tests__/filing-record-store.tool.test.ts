/**
 * The momsdeklaration filing record against a REAL PostgREST.
 *
 * A mocked client answers whatever the test queues, so it cannot see that a
 * filing's label misses the row the deadline generator built, and it cannot see
 * that PostgREST refuses an update whose or() names a column the update does
 * not return.
 */
import { describe, it, expect } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from '@/tests/tool-pg/client'
import type { EntityType } from '@/types'
import { markVatPeriodFiled, unmarkVatPeriodFiled, vatPeriodDeadline } from '../filing-record-store'

const TODAY = '2026-09-17'

/** Written past the triggers: stored years a door refuses today, as an old import left them. */
async function seed(entityType: EntityType, years: [string, string][]) {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType })
  await insertCompanyMember({ companyId, userId })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, entity_type, vat_has_eu_trade, vat_filing_method)
     VALUES ($1, $2, $3, false, 'electronic')`,
    [userId, companyId, entityType],
  )
  const client = await getPool().connect()
  try {
    await client.query(`SET session_replication_role = replica`)
    for (const [start, end] of years) {
      await client.query(
        `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, companyId, `${start} ${end}`, start, end],
      )
    }
  } finally {
    await client.query(`SET session_replication_role = DEFAULT`)
    client.release()
  }
  return { userId, companyId }
}

async function insertDeadline(
  { userId, companyId }: { userId: string; companyId: string },
  type: string,
  taxPeriod: string,
  dueDate: string,
) {
  await getPool().query(
    `INSERT INTO public.deadlines (company_id, user_id, title, due_date, deadline_type, tax_deadline_type, tax_period, status)
     VALUES ($1, $2, 'Momsdeklaration', $3, 'tax', $4, $5, 'overdue')`,
    [companyId, userId, dueDate, type, taxPeriod],
  )
}

async function deadlinesOf(companyId: string) {
  const { rows } = await getPool().query(
    `SELECT tax_period, is_completed FROM public.deadlines WHERE company_id = $1 ORDER BY tax_period`,
    [companyId],
  )
  return rows as { tax_period: string; is_completed: boolean }[]
}

describe('the filing record (real PostgREST)', () => {
  it('keeps one row for an enskild firma on broken years, the one the generator built', async () => {
    const supabase = createToolPgClient()
    const company = await seed('enskild_firma', [
      ['2024-09-01', '2025-08-31'],
      ['2025-09-01', '2026-08-31'],
    ])
    await insertDeadline(company, 'moms_yearly', '2025', '2026-08-17')
    const period = { periodType: 'yearly' as const, year: 2025, period: 1 }

    await expect(
      markVatPeriodFiled(supabase, company.companyId, { ...period, filedOn: '2026-03-01' }, { today: TODAY }),
    ).resolves.toMatchObject({ ok: true, created: false })
    await expect(
      markVatPeriodFiled(supabase, company.companyId, { ...period, filedOn: '2026-03-02' }, { today: TODAY }),
    ).resolves.toMatchObject({ ok: true, created: false })

    expect(await deadlinesOf(company.companyId)).toEqual([{ tax_period: '2025', is_completed: true }])
    await expect(vatPeriodDeadline(supabase, company.companyId, period)).resolves.toMatchObject({ filed: true })

    await expect(unmarkVatPeriodFiled(supabase, company.companyId, period, { today: TODAY })).resolves.toMatchObject({
      ok: true,
    })
    expect(await deadlinesOf(company.companyId)).toEqual([{ tax_period: '2025', is_completed: false }])
  })

  it('undoes a manual mark of a quarter', async () => {
    const supabase = createToolPgClient()
    const company = await seed('aktiebolag', [['2026-01-01', '2026-12-31']])
    await insertDeadline(company, 'moms_quarterly', '2026-Q2', '2026-08-17')
    const period = { periodType: 'quarterly' as const, year: 2026, period: 2 }

    await expect(
      markVatPeriodFiled(supabase, company.companyId, { ...period, filedOn: '2026-08-10' }, { today: TODAY }),
    ).resolves.toMatchObject({ ok: true, created: false })
    await expect(unmarkVatPeriodFiled(supabase, company.companyId, period, { today: TODAY })).resolves.toMatchObject({
      ok: true,
    })

    expect(await deadlinesOf(company.companyId)).toEqual([{ tax_period: '2026-Q2', is_completed: false }])
  })
})
