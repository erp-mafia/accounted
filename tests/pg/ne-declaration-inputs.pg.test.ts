import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * 20261119235300_ne_declaration_inputs.sql: RLS (members read, writing
 * members write in their own name, viewers and strangers do not, no DELETE
 * policy), the object CHECK, one row per räkenskapsår, the period belonging to
 * the same company, and the audit trail.
 */

const INPUTS = '{"category":"full","priorYearSchablonavdrag":61250,"pfondExistingFonder":[{"year":2023,"balance":40000}]}'

async function insertInputs(companyId: string, periodId: string, userId: string, inputs = INPUTS): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.ne_declaration_inputs (company_id, fiscal_period_id, inputs, updated_by)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING id`,
    [companyId, periodId, inputs, userId],
  )
  return res.rows[0].id
}

describe('ne_declaration_inputs RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertInputs(companyId, fiscalPeriodId, userId)
    const stranger = await insertAuthUser()

    const own = await withUserContext(userId, (client) =>
      client.query(`SELECT inputs FROM public.ne_declaration_inputs WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(own.rows).toEqual([{ inputs: JSON.parse(INPUTS) }])

    const theirs = await withUserContext(stranger, (client) =>
      client.query(`SELECT id FROM public.ne_declaration_inputs WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(theirs.rows).toHaveLength(0)
  })

  it('lets a member write in their own name, upserting the one row per period', async () => {
    const { companyId, fiscalPeriodId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    const res = await withUserContext(member, async (client) => {
      for (const inputs of ['{"category":"full"}', '{"category":"pensioner"}']) {
        await client.query(
          `INSERT INTO public.ne_declaration_inputs (company_id, fiscal_period_id, inputs, updated_by)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (company_id, fiscal_period_id)
           DO UPDATE SET inputs = EXCLUDED.inputs, updated_by = EXCLUDED.updated_by`,
          [companyId, fiscalPeriodId, inputs, member],
        )
      }
      return client.query(`SELECT inputs FROM public.ne_declaration_inputs WHERE fiscal_period_id = $1`, [fiscalPeriodId])
    })
    expect(res.rows).toEqual([{ inputs: { category: 'pensioner' } }])
  })

  it("refuses a write in someone else's name and a viewer's write", async () => {
    const { userId: owner, companyId, fiscalPeriodId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    await expect(
      withUserContext(member, (client) =>
        client.query(
          `INSERT INTO public.ne_declaration_inputs (company_id, fiscal_period_id, updated_by) VALUES ($1, $2, $3)`,
          [companyId, fiscalPeriodId, owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.ne_declaration_inputs (company_id, fiscal_period_id, updated_by) VALUES ($1, $2, $3)`,
          [companyId, fiscalPeriodId, viewer],
        ),
      ),
    ).rejects.toThrow(/row-level security|viewer|role/i)
  })

  it("refuses a viewer's move of a row into a company they write (20261122121500)", async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const id = await insertInputs(a.companyId, a.fiscalPeriodId, a.userId)
    await insertCompanyMember({ companyId: a.companyId, userId: b.userId, role: 'viewer' })

    const res = await withUserContext(b.userId, (client) =>
      client.query(
        `UPDATE public.ne_declaration_inputs
            SET company_id = $2, fiscal_period_id = $3, updated_by = $4
          WHERE id = $1`,
        [id, b.companyId, b.fiscalPeriodId, b.userId],
      ),
    )
    expect(res.rowCount).toBe(0)
    const row = await getPool().query(`SELECT company_id FROM public.ne_declaration_inputs WHERE id = $1`, [id])
    expect(row.rows).toEqual([{ company_id: a.companyId }])
  })

  it('is never deleted by a member: no DELETE grant or policy', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertInputs(companyId, fiscalPeriodId, userId)
    await expect(
      withUserContext(userId, (client) =>
        client.query(`DELETE FROM public.ne_declaration_inputs WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
      ),
    ).rejects.toThrow(/permission denied/i)
    const left = await getPool().query(`SELECT 1 FROM public.ne_declaration_inputs WHERE fiscal_period_id = $1`, [
      fiscalPeriodId,
    ])
    expect(left.rowCount).toBe(1)
  })
})

describe('ne_declaration_inputs constraints and audit', () => {
  it('keeps one row per räkenskapsår', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertInputs(companyId, fiscalPeriodId, userId)
    await expect(insertInputs(companyId, fiscalPeriodId, userId)).rejects.toThrow(/period_key/)
  })

  it('refuses a fiscal period of another company', async () => {
    const own = await seedCompany()
    const other = await seedCompany()
    await expect(insertInputs(own.companyId, other.fiscalPeriodId, own.userId)).rejects.toThrow(/fiscal_period_fkey/)
  })

  it.each([
    ['a list', '[1, 2]'],
    ['a number', '12'],
    ['more than 8 KiB', `{"note":"${'a'.repeat(9000)}"}`],
  ])('refuses inputs that are %s', async (_label, inputs) => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await expect(insertInputs(companyId, fiscalPeriodId, userId, inputs)).rejects.toThrow(/inputs_check/)
  })

  it('stays editable after the räkenskapsår is closed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany({ isClosed: true })
    const id = await insertInputs(companyId, fiscalPeriodId, userId)
    const res = await withUserContext(userId, (client) =>
      client.query(`UPDATE public.ne_declaration_inputs SET inputs = '{}'::jsonb, updated_by = $2 WHERE id = $1`, [
        id,
        userId,
      ]),
    )
    expect(res.rowCount).toBe(1)
  })

  it('writes every change to audit_log with the company', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const id = await insertInputs(companyId, fiscalPeriodId, userId)
    await getPool().query(`UPDATE public.ne_declaration_inputs SET inputs = '{}'::jsonb WHERE id = $1`, [id])
    const rows = await getPool().query<{ action: string; company_id: string }>(
      `SELECT action, company_id FROM public.audit_log
        WHERE table_name = 'ne_declaration_inputs' AND record_id = $1
        ORDER BY created_at, id`,
      [id],
    )
    expect(rows.rows).toEqual([
      { action: 'INSERT', company_id: companyId },
      { action: 'UPDATE', company_id: companyId },
    ])
  })
})
