import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * 20261015180400_ink3_underlag_inputs.sql: RLS (members read, writing members
 * write in their own name, viewers and strangers do not, no DELETE policy),
 * the shape CHECKs on the two jsonb maps, the one row per räkenskapsår, the
 * period belonging to the same company, and the audit trail.
 */

async function insertInputs(
  companyId: string,
  periodId: string,
  userId: string,
  values: { treatments?: string; overrides?: string; allmannyttig?: boolean | null } = {},
): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.ink3_underlag_inputs
       (company_id, fiscal_period_id, allmannyttig, account_treatments, field_overrides, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
     RETURNING id`,
    [
      companyId,
      periodId,
      values.allmannyttig === undefined ? true : values.allmannyttig,
      values.treatments ?? '{"3010":"taxable","3901":"exempt","6110":"shared"}',
      values.overrides ?? '{"8671":12000,"8822":true,"8620":"Kulturarv","8787":-5}',
      userId,
    ],
  )
  return res.rows[0].id
}

describe('ink3_underlag_inputs RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertInputs(companyId, fiscalPeriodId, userId)
    const stranger = await insertAuthUser()

    const own = await withUserContext(userId, (client) =>
      client.query(`SELECT allmannyttig, account_treatments FROM public.ink3_underlag_inputs WHERE fiscal_period_id = $1`, [
        fiscalPeriodId,
      ]),
    )
    expect(own.rows).toEqual([
      { allmannyttig: true, account_treatments: { '3010': 'taxable', '3901': 'exempt', '6110': 'shared' } },
    ])

    const theirs = await withUserContext(stranger, (client) =>
      client.query(`SELECT id FROM public.ink3_underlag_inputs WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(theirs.rows).toHaveLength(0)
  })

  it('lets a member write in their own name, upserting the one row per period', async () => {
    const { companyId, fiscalPeriodId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    const res = await withUserContext(member, async (client) => {
      for (const statement of [null, false]) {
        await client.query(
          `INSERT INTO public.ink3_underlag_inputs (company_id, fiscal_period_id, allmannyttig, updated_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (company_id, fiscal_period_id)
           DO UPDATE SET allmannyttig = EXCLUDED.allmannyttig, updated_by = EXCLUDED.updated_by`,
          [companyId, fiscalPeriodId, statement, member],
        )
      }
      return client.query(
        `SELECT allmannyttig, account_treatments, field_overrides FROM public.ink3_underlag_inputs WHERE fiscal_period_id = $1`,
        [fiscalPeriodId],
      )
    })
    expect(res.rows).toEqual([{ allmannyttig: false, account_treatments: {}, field_overrides: {} }])
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
          `INSERT INTO public.ink3_underlag_inputs (company_id, fiscal_period_id, updated_by) VALUES ($1, $2, $3)`,
          [companyId, fiscalPeriodId, owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.ink3_underlag_inputs (company_id, fiscal_period_id, updated_by) VALUES ($1, $2, $3)`,
          [companyId, fiscalPeriodId, viewer],
        ),
      ),
    ).rejects.toThrow(/row-level security|viewer|role/i)
  })

  it('is never deleted by a member: no DELETE grant or policy', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertInputs(companyId, fiscalPeriodId, userId)
    await expect(
      withUserContext(userId, (client) =>
        client.query(`DELETE FROM public.ink3_underlag_inputs WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
      ),
    ).rejects.toThrow(/permission denied/i)
    const left = await getPool().query(`SELECT 1 FROM public.ink3_underlag_inputs WHERE fiscal_period_id = $1`, [
      fiscalPeriodId,
    ])
    expect(left.rowCount).toBe(1)
  })
})

describe('ink3_underlag_inputs constraints and audit', () => {
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
    ['a balance sheet account', '{"1930":"taxable"}'],
    ['an unknown treatment', '{"3010":"partly"}'],
    ['a non-string treatment', '{"3010":1}'],
    ['a list instead of an object', '["3010"]'],
  ])('refuses account_treatments with %s', async (_label, treatments) => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await expect(insertInputs(companyId, fiscalPeriodId, userId, { treatments })).rejects.toThrow(
      /account_treatments_check/,
    )
  })

  it.each([
    ['a code that is not four digits', '{"86710":1}'],
    ['öre', '{"8671":12000.5}'],
    ['an amount above the field range', '{"8671":1000000000000}'],
    ['text longer than 36 characters', `{"8620":"${'a'.repeat(37)}"}`],
    ['empty text', '{"8620":""}'],
    ['a nested object', '{"8671":{"value":1}}'],
    ['null', '{"8671":null}'],
  ])('refuses field_overrides with %s', async (_label, overrides) => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await expect(insertInputs(companyId, fiscalPeriodId, userId, { overrides })).rejects.toThrow(
      /field_overrides_check/,
    )
  })

  it('accepts negative whole kronor, a ticked box and short text', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const id = await insertInputs(companyId, fiscalPeriodId, userId)
    const res = await getPool().query(`SELECT field_overrides FROM public.ink3_underlag_inputs WHERE id = $1`, [id])
    expect(res.rows[0].field_overrides).toEqual({ '8671': 12000, '8822': true, '8620': 'Kulturarv', '8787': -5 })
  })

  it('stays editable after the räkenskapsår is closed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany({ isClosed: true })
    const id = await insertInputs(companyId, fiscalPeriodId, userId)
    const res = await withUserContext(userId, (client) =>
      client.query(`UPDATE public.ink3_underlag_inputs SET allmannyttig = false, updated_by = $2 WHERE id = $1`, [
        id,
        userId,
      ]),
    )
    expect(res.rowCount).toBe(1)
  })

  it('writes every change to audit_log with the company', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const id = await insertInputs(companyId, fiscalPeriodId, userId)
    await getPool().query(`UPDATE public.ink3_underlag_inputs SET allmannyttig = NULL WHERE id = $1`, [id])
    const rows = await getPool().query<{ action: string; company_id: string }>(
      `SELECT action, company_id FROM public.audit_log
        WHERE table_name = 'ink3_underlag_inputs' AND record_id = $1
        ORDER BY created_at, id`,
      [id],
    )
    expect(rows.rows).toEqual([
      { action: 'INSERT', company_id: companyId },
      { action: 'UPDATE', company_id: companyId },
    ])
  })
})
