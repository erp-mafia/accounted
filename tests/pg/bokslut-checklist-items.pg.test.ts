import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260824210000_bokslut_checklist_items: RLS (members
// read, owner/admin/member write as themselves, viewers read-only, no
// DELETE policy), the item_key and state CHECKs, the done pair CHECK and the
// composite primary key (one row per item and period).

async function tick(
  companyId: string,
  periodId: string,
  userId: string,
  overrides: { itemKey?: string; state?: string; doneAt?: string | null } = {},
): Promise<void> {
  const state = overrides.state ?? 'done'
  const doneAt = overrides.doneAt === undefined ? (state === 'open' ? null : new Date().toISOString()) : overrides.doneAt
  await getPool().query(
    `INSERT INTO public.bokslut_checklist_items
       (company_id, fiscal_period_id, item_key, state, done_by, done_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $5)`,
    [companyId, periodId, overrides.itemKey ?? 'inventory_valued', state, userId, doneAt],
  )
}

describe('bokslut_checklist_items RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await tick(companyId, fiscalPeriodId, userId)
    const stranger = await insertAuthUser()

    const ownerView = await withUserContext(userId, (client) =>
      client.query(`SELECT item_key FROM public.bokslut_checklist_items WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(ownerView.rows).toHaveLength(1)

    const strangerView = await withUserContext(stranger, (client) =>
      client.query(`SELECT item_key FROM public.bokslut_checklist_items WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(strangerView.rows).toHaveLength(0)
  })

  it('lets viewers read but not tick', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await tick(companyId, fiscalPeriodId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    const read = await withUserContext(viewer, (client) =>
      client.query(`SELECT item_key FROM public.bokslut_checklist_items WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(read.rows).toHaveLength(1)

    await expect(
      withUserContext(viewer, (client) =>
        client.query(
          `INSERT INTO public.bokslut_checklist_items (company_id, fiscal_period_id, item_key, state, done_by, done_at, updated_by)
           VALUES ($1, $2, 'accruals_posted', 'done', $3, NOW(), $3)`,
          [companyId, fiscalPeriodId, viewer],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('lets members tick as themselves, upsert their own rows, but not sign as someone else', async () => {
    const { userId: owner, companyId, fiscalPeriodId } = await seedCompany()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: member, role: 'member' })

    const inserted = await withUserContext(member, (client) =>
      client.query(
        `INSERT INTO public.bokslut_checklist_items (company_id, fiscal_period_id, item_key, state, done_by, done_at, updated_by)
         VALUES ($1, $2, 'accruals_posted', 'done', $3, NOW(), $3)
         ON CONFLICT (company_id, fiscal_period_id, item_key)
         DO UPDATE SET state = EXCLUDED.state, done_by = EXCLUDED.done_by, done_at = EXCLUDED.done_at, updated_by = EXCLUDED.updated_by, updated_at = NOW()
         RETURNING state`,
        [companyId, fiscalPeriodId, member],
      ),
    )
    expect(inserted.rows[0].state).toBe('done')

    await expect(
      withUserContext(member, (client) =>
        client.query(
          `INSERT INTO public.bokslut_checklist_items (company_id, fiscal_period_id, item_key, state, done_by, done_at, updated_by)
           VALUES ($1, $2, 'tax_provision', 'done', $3, NOW(), $3)`,
          [companyId, fiscalPeriodId, owner],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('has no DELETE policy: a member delete touches nothing', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await tick(companyId, fiscalPeriodId, userId)
    const res = await withUserContext(userId, (client) =>
      client.query(`DELETE FROM public.bokslut_checklist_items WHERE fiscal_period_id = $1`, [fiscalPeriodId]),
    )
    expect(res.rowCount).toBe(0)
  })
})

describe('bokslut_checklist_items constraints', () => {
  it('rejects a malformed key, an unknown state, an open row with done_at, a done row without it, and a duplicate', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await expect(tick(companyId, fiscalPeriodId, userId, { itemKey: 'Not Valid' })).rejects.toThrow(/item_key/i)
    await expect(tick(companyId, fiscalPeriodId, userId, { state: 'maybe' })).rejects.toThrow(/state/i)
    await expect(tick(companyId, fiscalPeriodId, userId, { state: 'open', doneAt: new Date().toISOString() })).rejects.toThrow(/done_pair/i)
    await expect(tick(companyId, fiscalPeriodId, userId, { state: 'done', doneAt: null })).rejects.toThrow(/done_pair/i)
    await tick(companyId, fiscalPeriodId, userId, { itemKey: 'no_drafts', state: 'not_applicable' })
    await expect(tick(companyId, fiscalPeriodId, userId, { itemKey: 'no_drafts' })).rejects.toThrow(/duplicate key/i)
  })
})
