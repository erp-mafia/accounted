import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertFiscalPeriod, seedCompany } from './fixtures'

/**
 * 20261030030000_tax_loss_carryforwards.sql: the underskottsregister's RLS
 * (members read, writing members write in their own name, viewers and
 * strangers do not, no DELETE), one row per company and räkenskapsår, the
 * period belonging to the same company, the shape CHECKs on the spärrar and
 * the ownership change, and the audit trail.
 */

async function insertRow(
  companyId: string,
  periodId: string,
  userId: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  // A value given by the caller replaces the default (brought_forward), so a
  // column is never named twice in the INSERT.
  const row: Record<string, unknown> = {
    company_id: companyId,
    fiscal_period_id: periodId,
    updated_by: userId,
    brought_forward: 100000,
    ...values,
  }
  const columns = Object.keys(row)
  const params = Object.values(row)
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO public.tax_loss_carryforwards (${columns.join(', ')})
     VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    params,
  )
  return res.rows[0].id
}

describe('tax_loss_carryforwards RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertRow(companyId, fiscalPeriodId, userId)
    const other = await seedCompany()

    const own = await withUserContext(userId, (client) =>
      client.query(`SELECT brought_forward FROM public.tax_loss_carryforwards WHERE fiscal_period_id = $1`, [
        fiscalPeriodId,
      ]),
    )
    expect(own.rows).toEqual([{ brought_forward: '100000.00' }])

    const theirs = await withUserContext(other.userId, (client) =>
      client.query(`SELECT id FROM public.tax_loss_carryforwards WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(theirs.rows).toHaveLength(0)
  })

  it('lets a member write in their own name, upserting the one row per period', async () => {
    const { companyId, fiscalPeriodId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    const res = await withUserContext(member, async (client) => {
      for (const amount of [50000, 75000]) {
        await client.query(
          `INSERT INTO public.tax_loss_carryforwards (company_id, fiscal_period_id, brought_forward, updated_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (company_id, fiscal_period_id)
           DO UPDATE SET brought_forward = EXCLUDED.brought_forward, updated_by = EXCLUDED.updated_by`,
          [companyId, fiscalPeriodId, amount, member],
        )
      }
      return client.query(`SELECT brought_forward FROM public.tax_loss_carryforwards WHERE fiscal_period_id = $1`, [
        fiscalPeriodId,
      ])
    })
    expect(res.rows).toEqual([{ brought_forward: '75000.00' }])
  })

  it("refuses a write in someone else's name, a viewer's write and a stranger's write", async () => {
    const { userId: owner, companyId, fiscalPeriodId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })
    const stranger = await insertAuthUser()

    await expect(
      withUserContext(member, (client) =>
        client.query(
          `INSERT INTO public.tax_loss_carryforwards (company_id, fiscal_period_id, updated_by) VALUES ($1, $2, $3)`,
          [companyId, fiscalPeriodId, owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.tax_loss_carryforwards (company_id, fiscal_period_id, updated_by) VALUES ($1, $2, $3)`,
          [companyId, fiscalPeriodId, viewer],
        ),
      ),
    ).rejects.toThrow(/row-level security|viewer|role/i)

    await expect(
      withUserContext(stranger, (client) =>
        client.query(
          `INSERT INTO public.tax_loss_carryforwards (company_id, fiscal_period_id, updated_by) VALUES ($1, $2, $3)`,
          [companyId, fiscalPeriodId, stranger],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('lets a viewer read but not change a row', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const id = await insertRow(companyId, fiscalPeriodId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    const seen = await withUserContext(viewer, async (client) =>
      (await client.query(`SELECT id FROM public.tax_loss_carryforwards WHERE id = $1`, [id])).rowCount,
    )
    expect(seen).toBe(1)
    await expect(
      withUserContext(viewer, (client) =>
        client.query(`UPDATE public.tax_loss_carryforwards SET brought_forward = 1, updated_by = $2 WHERE id = $1`, [
          id,
          viewer,
        ]),
      ),
    ).rejects.toThrow(/row-level security|viewer|role/i)
  })

  it('is never deleted by a member: no DELETE grant or policy', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertRow(companyId, fiscalPeriodId, userId)
    await expect(
      withUserContext(userId, (client) =>
        client.query(`DELETE FROM public.tax_loss_carryforwards WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
      ),
    ).rejects.toThrow(/permission denied/i)
    const left = await getPool().query(`SELECT 1 FROM public.tax_loss_carryforwards WHERE fiscal_period_id = $1`, [
      fiscalPeriodId,
    ])
    expect(left.rowCount).toBe(1)
  })
})

describe('tax_loss_carryforwards constraints and audit', () => {
  it('keeps one row per company and räkenskapsår, one per year across years', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await insertRow(companyId, fiscalPeriodId, userId)
    await expect(insertRow(companyId, fiscalPeriodId, userId)).rejects.toThrow(/period_key/)

    const nextYear = await insertFiscalPeriod({
      userId,
      companyId,
      name: '2027',
      periodStart: '2027-01-01',
      periodEnd: '2027-12-31',
    })
    await expect(insertRow(companyId, nextYear, userId)).resolves.toBeTruthy()
  })

  it('refuses a fiscal period of another company', async () => {
    const own = await seedCompany()
    const other = await seedCompany()
    await expect(insertRow(own.companyId, other.fiscalPeriodId, own.userId)).rejects.toThrow(/fiscal_period_fkey/)
  })

  it.each([
    ['a negative deficit brought forward', { brought_forward: -1 }, /brought_forward_check/],
    ['spärrar above what was brought forward', { amount_block_reduction: 80000, group_block_reduction: 30000 }, /reductions_check/],
    ['a negative carried-forward deficit', { carried_forward: -5 }, /carried_forward_check/],
    ['an ownership change date without a spärr', { ownership_change_date: '2026-06-01', ownership_change_source: 'manual' }, /ownership_change_check/],
    ['a spärr without a date', { amount_block_applies: true }, /ownership_change_check/],
    ['a date without its source', { ownership_change_date: '2026-06-01', amount_block_applies: true }, /ownership_source_check/],
    ['an utgift without a beloppsspärr', { acquisition_cost: 1000 }, /amount_block_basis_check/],
    ['a koncernbidragsspärr without its last year', { ownership_change_date: '2026-06-01', ownership_change_source: 'manual', group_block_applies: true }, /group_block_end_check/],
    ['an unknown source', { source: 'guess' }, /source_check/],
  ])('refuses %s', async (_label, values, pattern) => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await expect(insertRow(companyId, fiscalPeriodId, userId, values)).rejects.toThrow(pattern)
  })

  it('accepts an ownership change with both spärrar entered by hand', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const id = await insertRow(companyId, fiscalPeriodId, userId, {
      ownership_change_date: '2026-06-01',
      ownership_change_source: 'manual',
      amount_block_applies: true,
      acquisition_cost: 20000,
      capital_contributions: 5000,
      amount_block_reduction: 55000,
      amount_block_manual: false,
      group_block_applies: true,
      group_block_last_year: 2031,
      source: 'tax_assessment',
    })
    const res = await getPool().query(
      `SELECT amount_block_reduction, group_block_last_year FROM public.tax_loss_carryforwards WHERE id = $1`,
      [id],
    )
    expect(res.rows).toEqual([{ amount_block_reduction: '55000.00', group_block_last_year: 2031 }])
  })

  it('stays editable after the räkenskapsår is closed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany({ isClosed: true })
    const id = await insertRow(companyId, fiscalPeriodId, userId)
    const res = await withUserContext(userId, (client) =>
      client.query(`UPDATE public.tax_loss_carryforwards SET carried_forward = 20000, updated_by = $2 WHERE id = $1`, [
        id,
        userId,
      ]),
    )
    expect(res.rowCount).toBe(1)
  })

  it('writes every change to audit_log with the company', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const id = await insertRow(companyId, fiscalPeriodId, userId)
    await getPool().query(`UPDATE public.tax_loss_carryforwards SET note = 'Enligt slutskattebesked' WHERE id = $1`, [id])
    const rows = await getPool().query<{ action: string; company_id: string }>(
      `SELECT action, company_id FROM public.audit_log
        WHERE table_name = 'tax_loss_carryforwards' AND record_id = $1
        ORDER BY created_at, id`,
      [id],
    )
    expect(rows.rows).toEqual([
      { action: 'INSERT', company_id: companyId },
      { action: 'UPDATE', company_id: companyId },
    ])
  })
})
