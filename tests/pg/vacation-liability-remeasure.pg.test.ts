import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * 20261027213121 (semesterlöneskuld remeasurement):
 *
 *   - company_settings.salary_vacation_liability_method defaults to
 *     'accrual' (every existing company books as before) and accepts only
 *     'accrual' and 'remeasure';
 *   - salary_calculation_policy accepts vacation_day_value at either value
 *     and still refuses an unknown value;
 *   - vacation_liability_remeasurements: one row per run, kind and run go
 *     together, members of the company read and write their own rows only,
 *     and nobody deletes one (it is a verifikat's underlag).
 */

async function settingsRow(companyId: string) {
  await getPool().query(`INSERT INTO public.company_settings (company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [companyId])
}

async function seedRun(companyId: string, userId: string): Promise<string> {
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 10, '2026-10-25', 'draft')`,
    [runId, companyId, userId],
  )
  return runId
}

const REPORT = JSON.stringify({ as_of_date: '2026-10-25', rows: [] })

describe('company_settings.salary_vacation_liability_method', () => {
  it("defaults to 'accrual' and accepts only accrual and remeasure", async () => {
    const { companyId } = await seedCompany()
    await settingsRow(companyId)
    const res = await getPool().query<{ salary_vacation_liability_method: string }>(
      `SELECT salary_vacation_liability_method FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(res.rows[0].salary_vacation_liability_method).toBe('accrual')
    await expect(
      getPool().query(`UPDATE public.company_settings SET salary_vacation_liability_method = 'remeasure' WHERE company_id = $1`, [companyId]),
    ).resolves.toBeDefined()
    await expect(
      getPool().query(`UPDATE public.company_settings SET salary_vacation_liability_method = 'true_up' WHERE company_id = $1`, [companyId]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('salary_calculation_policy.vacation_day_value', () => {
  it('accepts either value beside the other conventions and refuses another', async () => {
    const { companyId } = await seedCompany()
    await settingsRow(companyId)
    for (const ok of [{ vacation_day_value: 'daily_divisor' }, { vacation_day_value: 'percent_4_6', sick_rate: 'annual_hourly' }]) {
      await expect(
        getPool().query(`UPDATE public.company_settings SET salary_calculation_policy = $2::jsonb WHERE company_id = $1`, [
          companyId,
          JSON.stringify(ok),
        ]),
      ).resolves.toBeDefined()
    }
    for (const bad of [{ vacation_day_value: 'percent_5' }, { vacation_day_value: 'percent_4_6', unknown: 'x' }]) {
      await expect(
        getPool().query(`UPDATE public.company_settings SET salary_calculation_policy = $2::jsonb WHERE company_id = $1`, [
          companyId,
          JSON.stringify(bad),
        ]),
      ).rejects.toMatchObject({ code: '23514' })
    }
  })
})

describe('vacation_liability_remeasurements', () => {
  it('keeps one row per run, and a run row names its run', async () => {
    const { companyId, userId } = await seedCompany()
    const runId = await seedRun(companyId, userId)
    const insert = (kind: string, salaryRunId: string | null) =>
      getPool().query(
        `INSERT INTO public.vacation_liability_remeasurements (company_id, as_of_date, kind, salary_run_id, report)
         VALUES ($1, '2026-10-25', $2, $3, $4::jsonb)`,
        [companyId, kind, salaryRunId, REPORT],
      )
    await expect(insert('salary_run', runId)).resolves.toBeDefined()
    await expect(insert('salary_run', runId)).rejects.toMatchObject({ code: '23505' })
    await expect(insert('salary_run', null)).rejects.toMatchObject({ code: '23514' })
    await expect(insert('standalone', runId)).rejects.toMatchObject({ code: '23514' })
    await expect(insert('standalone', null)).resolves.toBeDefined()
    await expect(insert('true_up', null)).rejects.toMatchObject({ code: '23514' })
  })

  it('a member writes and reads their company\'s rows, never another company\'s, and nobody deletes one', async () => {
    const { companyId, userId } = await seedCompany()
    const otherUser = await insertAuthUser()
    const otherCompany = await insertCompany({ createdBy: otherUser })
    await insertCompanyMember({ companyId: otherCompany, userId: otherUser, role: 'owner' })
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.vacation_liability_remeasurements (company_id, as_of_date, kind, report)
       VALUES ($1, '2026-10-31', 'standalone', $2::jsonb) RETURNING id`,
      [companyId, REPORT],
    )
    const id = rows[0].id

    await withUserContext(userId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.vacation_liability_remeasurements (company_id, as_of_date, kind, report)
         VALUES ($1, '2026-11-30', 'standalone', $2::jsonb)`,
        [companyId, REPORT],
      )
      expect(inserted.rowCount).toBe(1)
      const own = await client.query(`SELECT id FROM public.vacation_liability_remeasurements WHERE id = $1`, [id])
      expect(own.rowCount).toBe(1)
      await expect(
        client.query(`DELETE FROM public.vacation_liability_remeasurements WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: '42501' })
    })

    await withUserContext(otherUser, async (client) => {
      const seen = await client.query(`SELECT id FROM public.vacation_liability_remeasurements WHERE id = $1`, [id])
      expect(seen.rowCount).toBe(0)
      await expect(
        client.query(
          `INSERT INTO public.vacation_liability_remeasurements (company_id, as_of_date, kind, report)
           VALUES ($1, '2026-10-31', 'standalone', $2::jsonb)`,
          [companyId, REPORT],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })

    const still = await getPool().query(`SELECT id FROM public.vacation_liability_remeasurements WHERE id = $1`, [id])
    expect(still.rowCount).toBe(1)
  })
})
