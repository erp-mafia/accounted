import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  seedCompany,
} from './fixtures'

async function setActiveCompany(userId: string, companyId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id`,
    [userId, companyId],
  )
}

async function insertAdjustment(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.fiscal_period_tax_adjustments
       (id, company_id, user_id, fiscal_period_id, adjustment_type, source,
        source_key, description, account_number, amount, included)
     VALUES ($1, $2, $3, $4, 'non_deductible_expense', 'detected',
             'account:6992', 'Ej avdragsgill kostnad', '6992', 2994, true)`,
    [id, params.companyId, params.userId, params.fiscalPeriodId],
  )
  return id
}

describe('fiscal_period_tax_adjustments constraints and RLS', () => {
  it('uses the standard UUID default and locks the fiscal period in the guard', async () => {
    const result = await getPool().query<{ default_expression: string; function_definition: string }>(
      `SELECT
         pg_get_expr(d.adbin, d.adrelid) AS default_expression,
         pg_get_functiondef('public.guard_fiscal_period_tax_adjustment()'::regprocedure)
           AS function_definition
       FROM pg_attrdef d
       JOIN pg_attribute a
         ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       WHERE d.adrelid = 'public.fiscal_period_tax_adjustments'::regclass
         AND a.attname = 'id'`,
    )

    expect(result.rows[0]?.default_expression).toContain('uuid_generate_v4')
    expect(result.rows[0]?.function_definition).toMatch(/FOR UPDATE/i)
  })

  it('isolates adjustments by company membership', async () => {
    const owner = await seedCompany()
    const adjustmentId = await insertAdjustment(owner)
    const strangerId = await insertAuthUser()

    const ownerView = await withUserContext(owner.userId, (client) =>
      client.query(
        'SELECT id FROM public.fiscal_period_tax_adjustments WHERE id = $1',
        [adjustmentId],
      ),
    )
    expect(ownerView.rows).toHaveLength(1)

    const strangerView = await withUserContext(strangerId, (client) =>
      client.query(
        'SELECT id FROM public.fiscal_period_tax_adjustments WHERE id = $1',
        [adjustmentId],
      ),
    )
    expect(strangerView.rows).toHaveLength(0)
  })

  it('rejects a company that does not own the fiscal period', async () => {
    const first = await seedCompany()
    const second = await seedCompany()

    await expect(
      insertAdjustment({
        companyId: first.companyId,
        userId: first.userId,
        fiscalPeriodId: second.fiscalPeriodId,
      }),
    ).rejects.toThrow(/does not match fiscal period company/i)
  })

  it('allows an owner to insert an adjustment for the active company', async () => {
    const owner = await seedCompany()
    await setActiveCompany(owner.userId, owner.companyId)

    await withUserContext(owner.userId, async (client) => {
      const result = await client.query(
        `INSERT INTO public.fiscal_period_tax_adjustments
           (company_id, user_id, fiscal_period_id, adjustment_type, source,
            source_key, description, account_number, amount, included)
         VALUES ($1, $2, $3, 'non_deductible_expense', 'detected',
                 'account:6992', 'Ej avdragsgill kostnad', '6992', 2994, true)
         RETURNING id`,
        [owner.companyId, owner.userId, owner.fiscalPeriodId],
      )
      expect(result.rows).toHaveLength(1)
    })
  })

  it('blocks a viewer from inserting an adjustment directly under RLS', async () => {
    const owner = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: owner.companyId, userId: viewerId, role: 'viewer' })
    await setActiveCompany(viewerId, owner.companyId)

    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.fiscal_period_tax_adjustments
             (company_id, user_id, fiscal_period_id, adjustment_type, source,
              source_key, description, account_number, amount, included)
           VALUES ($1, $2, $3, 'non_deductible_expense', 'detected',
                   'account:6992', 'Ej avdragsgill kostnad', '6992', 2994, true)`,
          [owner.companyId, viewerId, owner.fiscalPeriodId],
        ),
      ).rejects.toThrow()
    })
  })

  it('blocks writes to a member company that is not the active company', async () => {
    const owner = await seedCompany()
    const otherCompanyId = await insertCompany({ createdBy: owner.userId })
    await insertCompanyMember({ companyId: otherCompanyId, userId: owner.userId, role: 'owner' })
    const otherPeriodId = await insertFiscalPeriod({
      userId: owner.userId,
      companyId: otherCompanyId,
    })
    await setActiveCompany(owner.userId, owner.companyId)

    await withUserContext(owner.userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.fiscal_period_tax_adjustments
             (company_id, user_id, fiscal_period_id, adjustment_type, source,
              source_key, description, account_number, amount, included)
           VALUES ($1, $2, $3, 'non_deductible_expense', 'detected',
                   'account:6992', 'Ej avdragsgill kostnad', '6992', 2994, true)`,
          [otherCompanyId, owner.userId, otherPeriodId],
        ),
      ).rejects.toThrow()
    })
  })

  it('accepts the deficit_carryforward adjustment type (INK2S 4.14 a) and still rejects unknown types', async () => {
    const owner = await seedCompany()

    const inserted = await getPool().query(
      `INSERT INTO public.fiscal_period_tax_adjustments
         (company_id, user_id, fiscal_period_id, adjustment_type, source,
          source_key, description, account_number, amount, included)
       VALUES ($1, $2, $3, 'deficit_carryforward', 'manual',
               'manual:deficit_carryforward',
               'Outnyttjat underskott från föregående beskattningsår', NULL, 250000, true)
       RETURNING id`,
      [owner.companyId, owner.userId, owner.fiscalPeriodId],
    )
    expect(inserted.rows).toHaveLength(1)

    await expect(
      getPool().query(
        `INSERT INTO public.fiscal_period_tax_adjustments
           (company_id, user_id, fiscal_period_id, adjustment_type, source,
            source_key, description, account_number, amount, included)
         VALUES ($1, $2, $3, 'some_other_type', 'manual',
                 'manual:other', 'Okänd justering', NULL, 1, true)`,
        [owner.companyId, owner.userId, owner.fiscalPeriodId],
      ),
    ).rejects.toThrow(/adjustment_type_check/i)
  })

  it('blocks adjustment changes after the fiscal period is locked', async () => {
    const owner = await seedCompany()
    const adjustmentId = await insertAdjustment(owner)
    await getPool().query(
      'UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1',
      [owner.fiscalPeriodId],
    )

    await expect(
      getPool().query(
        'UPDATE public.fiscal_period_tax_adjustments SET amount = 3000 WHERE id = $1',
        [adjustmentId],
      ),
    ).rejects.toThrow(/locked for tax adjustments/i)
    await expect(
      getPool().query(
        'DELETE FROM public.fiscal_period_tax_adjustments WHERE id = $1',
        [adjustmentId],
      ),
    ).rejects.toThrow(/locked for tax adjustments/i)
  })
})
