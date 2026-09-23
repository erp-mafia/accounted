import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

async function seedCompanySettings(): Promise<string> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id)
     VALUES ($1, $2)`,
    [userId, companyId],
  )
  return companyId
}

describe('company_settings reminder day constraints', () => {
  it('uses the legacy 15, 30, and 45 day defaults', async () => {
    const companyId = await seedCompanySettings()

    const result = await getPool().query(
      `SELECT reminder_days_level_1, reminder_days_level_2, reminder_days_level_3
       FROM public.company_settings
       WHERE company_id = $1`,
      [companyId],
    )

    expect(result.rows[0]).toMatchObject({
      reminder_days_level_1: 15,
      reminder_days_level_2: 30,
      reminder_days_level_3: 45,
    })
  })

  it('accepts a strictly increasing custom schedule', async () => {
    const companyId = await seedCompanySettings()

    await expect(
      getPool().query(
        `UPDATE public.company_settings
         SET reminder_days_level_1 = 7,
             reminder_days_level_2 = 21,
             reminder_days_level_3 = 35
         WHERE company_id = $1`,
        [companyId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it.each([
    [30, 20, 45],
    [15, 15, 45],
    [0, 30, 45],
    [15, 30, 366],
  ])('rejects invalid schedule %s, %s, %s', async (level1, level2, level3) => {
    const companyId = await seedCompanySettings()

    await expect(
      getPool().query(
        `UPDATE public.company_settings
         SET reminder_days_level_1 = $1,
             reminder_days_level_2 = $2,
             reminder_days_level_3 = $3
         WHERE company_id = $4`,
        [level1, level2, level3, companyId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
