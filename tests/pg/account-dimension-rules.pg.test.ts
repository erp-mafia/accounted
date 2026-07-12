import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

// PR10 account_dimension_rules (20260703200000_account_dimension_rules.sql):
// RLS via user_company_ids() on all four operations, the adr_value_presence
// CHECK (required ⇔ no value), UNIQUE (company_id, account_number,
// dimension_id), value_id ON DELETE CASCADE, and the composite
// (dimension_id, company_id) FK that pins a rule's dimension to the same
// company.

async function seedWithDimensions() {
  const seeded = await seedCompany()
  await getPool().query(`SELECT public.ensure_company_dimensions($1)`, [seeded.companyId])
  return seeded
}

async function getDimensionId(companyId: string, sieDimNo: number): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT id FROM public.dimensions WHERE company_id = $1 AND sie_dim_no = $2`,
    [companyId, sieDimNo],
  )
  return rows[0].id
}

async function insertValue(params: {
  companyId: string
  dimensionId: string
  code: string
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.dimension_values (id, company_id, dimension_id, code, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, params.companyId, params.dimensionId, params.code, params.name ?? params.code],
  )
  return id
}

async function insertRule(params: {
  companyId: string
  dimensionId: string
  ruleType: 'required' | 'default' | 'fixed'
  accountNumber?: string
  valueId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.account_dimension_rules
       (id, company_id, account_number, dimension_id, rule_type, value_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      params.companyId,
      params.accountNumber ?? '4010',
      params.dimensionId,
      params.ruleType,
      params.valueId ?? null,
    ],
  )
  return id
}

describe('account_dimension_rules RLS', () => {
  it('lets a member insert and read an own-company rule', async () => {
    const { userId, companyId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)

    await withUserContext(userId, async (client) => {
      await client.query(
        `INSERT INTO public.account_dimension_rules
           (company_id, account_number, dimension_id, rule_type)
         VALUES ($1, '4010', $2, 'required')`,
        [companyId, dimId],
      )
      const { rows } = await client.query(
        `SELECT account_number, rule_type, value_id, is_active
         FROM public.account_dimension_rules WHERE company_id = $1`,
        [companyId],
      )
      expect(rows).toEqual([
        { account_number: '4010', rule_type: 'required', value_id: null, is_active: true },
      ])
    })
  })

  it('hides other companies rules and blocks cross-company inserts', async () => {
    const a = await seedWithDimensions()
    const b = await seedWithDimensions()
    const aDimId = await getDimensionId(a.companyId, 6)
    await insertRule({ companyId: a.companyId, dimensionId: aDimId, ruleType: 'required' })

    await withUserContext(b.userId, async (client) => {
      // The outsider sees none of A's rules (and has none of their own).
      const { rows } = await client.query(
        `SELECT id FROM public.account_dimension_rules`,
      )
      expect(rows).toEqual([])

      await expect(
        client.query(
          `INSERT INTO public.account_dimension_rules
             (company_id, account_number, dimension_id, rule_type)
           VALUES ($1, '5010', $2, 'required')`,
          [a.companyId, aDimId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })
})

describe('adr_value_presence CHECK', () => {
  it('rejects a required rule that carries a value', async () => {
    const { companyId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)
    const valueId = await insertValue({ companyId, dimensionId: dimId, code: 'P001' })

    await expect(
      insertRule({ companyId, dimensionId: dimId, ruleType: 'required', valueId }),
    ).rejects.toThrow(/adr_value_presence/)
  })

  it('rejects a default rule without a value', async () => {
    const { companyId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)

    await expect(
      insertRule({ companyId, dimensionId: dimId, ruleType: 'default', valueId: null }),
    ).rejects.toThrow(/adr_value_presence/)
  })
})

describe('UNIQUE (company_id, account_number, dimension_id)', () => {
  it('rejects a second rule for the same account and dimension', async () => {
    const { companyId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)
    const valueId = await insertValue({ companyId, dimensionId: dimId, code: 'P001' })
    await insertRule({ companyId, dimensionId: dimId, ruleType: 'default', valueId })

    // Different rule_type, same (company, account, dimension) — still one slot.
    await expect(
      insertRule({ companyId, dimensionId: dimId, ruleType: 'required' }),
    ).rejects.toThrow(/duplicate|unique/)
  })
})

describe('cascade behavior', () => {
  it('deleting the dimension_value removes rules pinned to it (ON DELETE CASCADE)', async () => {
    const { companyId } = await seedWithDimensions()
    const dimId = await getDimensionId(companyId, 6)
    const valueId = await insertValue({ companyId, dimensionId: dimId, code: 'P001' })
    const ruleId = await insertRule({ companyId, dimensionId: dimId, ruleType: 'fixed', valueId })

    // The value is unreferenced by posted lines, so the retention trigger
    // allows the delete — and the rule must ride the cascade.
    await getPool().query(`DELETE FROM public.dimension_values WHERE id = $1`, [valueId])

    const { rows } = await getPool().query(
      `SELECT id FROM public.account_dimension_rules WHERE id = $1`,
      [ruleId],
    )
    expect(rows).toEqual([])
  })
})

describe('composite (dimension_id, company_id) FK', () => {
  it('rejects a rule whose dimension belongs to another company', async () => {
    const a = await seedWithDimensions()
    const b = await seedWithDimensions()
    const aDimId = await getDimensionId(a.companyId, 6)

    await expect(
      insertRule({ companyId: b.companyId, dimensionId: aDimId, ruleType: 'required' }),
    ).rejects.toThrow(/foreign key/)
  })
})
