import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * 20261015180300_forenklat_arsbokslut_inputs.sql: RLS (members read, writing
 * members write in their own name, viewers and strangers do not, no DELETE
 * grant or policy), the constraints, and the audit trail of every change.
 */

async function insertInputs(
  companyId: string,
  periodId: string,
  userId: string,
  overrides: { signatories?: string; confirmedAt?: string | null; confirmedBy?: string | null } = {},
): Promise<string> {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.forenklat_arsbokslut_inputs
       (company_id, fiscal_period_id, eligibility_confirmed_at, eligibility_confirmed_by, notes, signatories, updated_by)
     VALUES ($1, $2, $3, $4, 'Not 1 Eget kapital', $5::jsonb, $6)
     RETURNING id`,
    [
      companyId,
      periodId,
      overrides.confirmedAt === undefined ? new Date().toISOString() : overrides.confirmedAt,
      overrides.confirmedBy === undefined ? userId : overrides.confirmedBy,
      overrides.signatories ?? '[{"name":"Ledamot A","role":"ordförande"}]',
      userId,
    ],
  )
  return res.rows[0].id
}

describe('forenklat_arsbokslut_inputs RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertInputs(companyId, fiscalPeriodId, userId)
    const stranger = await insertAuthUser()

    const own = await withUserContext(userId, (client) =>
      client.query(`SELECT notes FROM public.forenklat_arsbokslut_inputs WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(own.rows).toEqual([{ notes: 'Not 1 Eget kapital' }])

    const theirs = await withUserContext(stranger, (client) =>
      client.query(`SELECT notes FROM public.forenklat_arsbokslut_inputs WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(theirs.rows).toHaveLength(0)
  })

  it('lets a member write in their own name, upserting the one row per period', async () => {
    const { companyId, fiscalPeriodId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    const res = await withUserContext(member, async (client) => {
      for (const notes of ['Första', 'Andra']) {
        await client.query(
          `INSERT INTO public.forenklat_arsbokslut_inputs (company_id, fiscal_period_id, notes, updated_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (company_id, fiscal_period_id)
           DO UPDATE SET notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by`,
          [companyId, fiscalPeriodId, notes, member],
        )
      }
      return client.query(`SELECT notes FROM public.forenklat_arsbokslut_inputs WHERE fiscal_period_id = $1`, [
        fiscalPeriodId,
      ])
    })
    expect(res.rows).toEqual([{ notes: 'Andra' }])
  })

  it('refuses a write in someone else\'s name and a viewer\'s write', async () => {
    const { userId: owner, companyId, fiscalPeriodId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    await expect(
      withUserContext(member, (client) =>
        client.query(
          `INSERT INTO public.forenklat_arsbokslut_inputs (company_id, fiscal_period_id, updated_by) VALUES ($1, $2, $3)`,
          [companyId, fiscalPeriodId, owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.forenklat_arsbokslut_inputs (company_id, fiscal_period_id, updated_by) VALUES ($1, $2, $3)`,
          [companyId, fiscalPeriodId, viewer],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('never lets a member delete the row: authenticated has no DELETE grant', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertInputs(companyId, fiscalPeriodId, userId)
    await expect(
      withUserContext(userId, (client) =>
        client.query(`DELETE FROM public.forenklat_arsbokslut_inputs WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
      ),
    ).rejects.toThrow(/permission denied/i)
    const left = await getPool().query(
      `SELECT 1 FROM public.forenklat_arsbokslut_inputs WHERE fiscal_period_id = $1`,
      [fiscalPeriodId],
    )
    expect(left.rowCount).toBe(1)
  })
})

describe('forenklat_arsbokslut_inputs constraints and audit', () => {
  it('rejects a second row for the period, signatories that are not a list, and a confirmer without a time', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertInputs(companyId, fiscalPeriodId, userId)
    await expect(insertInputs(companyId, fiscalPeriodId, userId)).rejects.toThrow(/period_key/)

    const other = await seedCompany()
    await expect(
      insertInputs(other.companyId, other.fiscalPeriodId, other.userId, { signatories: '{"name":"A"}' }),
    ).rejects.toThrow(/signatories/)
    const tooMany = JSON.stringify(Array.from({ length: 31 }, (_, i) => ({ name: `Ledamot ${i}`, role: null })))
    await expect(
      insertInputs(other.companyId, other.fiscalPeriodId, other.userId, { signatories: tooMany }),
    ).rejects.toThrow(/signatories/)
    await expect(
      insertInputs(other.companyId, other.fiscalPeriodId, other.userId, { confirmedAt: null }),
    ).rejects.toThrow(/confirmation_pair/)
  })

  it('writes every change to audit_log with the company', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const id = await insertInputs(companyId, fiscalPeriodId, userId)
    await getPool().query(
      `UPDATE public.forenklat_arsbokslut_inputs SET eligibility_confirmed_at = NULL, eligibility_confirmed_by = NULL WHERE id = $1`,
      [id],
    )
    const rows = await getPool().query<{ action: string; company_id: string }>(
      `SELECT action, company_id FROM public.audit_log
        WHERE table_name = 'forenklat_arsbokslut_inputs' AND record_id = $1
        ORDER BY created_at, id`,
      [id],
    )
    expect(rows.rows).toEqual([
      { action: 'INSERT', company_id: companyId },
      { action: 'UPDATE', company_id: companyId },
    ])
  })
})
