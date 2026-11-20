import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, insertFiscalPeriod, seedCompany } from './fixtures'

/**
 * Migration 20261031200701_development_expenditure_model: the K3 18.7 model
 * for internally generated intangible assets, and its behandlingshistorik
 * (BFL 5 kap. 11 §, BFNAR 2013:2 punkt 9.16).
 *
 * Pinned here:
 *   - set_development_expenditure_model sets the model for an owner or admin
 *     and refuses a member (42501) and a K2 company (DEVELOPMENT_MODEL_REFUSED);
 *   - every change writes one audit_log row with the user, the company and
 *     the model before and after: the signed-in user for a session, the
 *     named user and actor for a service-role door;
 *   - a write that bypasses the RPC is still recorded; an unchanged value
 *     writes nothing;
 *   - assets.own_development (what the fond för utvecklingsutgifter follows)
 *     defaults to false and is only allowed on 101x;
 *   - set_asset_own_development marks an existing 101x asset for a writer
 *     of the company under K3 and the aktiveringsmodell, refuses a viewer,
 *     an asset off 101x and the kostnadsföringsmodell, and every change of
 *     the mark (by the door or a plain update) writes one audit_log row with
 *     who made it;
 *   - both judge the fiscal years' own frameworks, not the company column
 *     (the latest year's): the model needs an open K3 year, the mark an
 *     asset acquired in a K3 year.
 */

const SET_SQL = `SELECT public.set_development_expenditure_model($1::uuid, $2::text, $3::uuid, $4::text, $5::text) AS model`

async function k3Company() {
  const seed = await seedCompany()
  await getPool().query(`UPDATE public.companies SET accounting_framework = 'k3' WHERE id = $1`, [seed.companyId])
  await getPool().query(`UPDATE public.fiscal_period_frameworks SET framework = 'k3' WHERE fiscal_period_id = $1`, [
    seed.fiscalPeriodId,
  ])
  return seed
}

/** 2026 still K2 and open, 2027 elected K3: the company column says K3. */
async function k3NextYear() {
  const seed = await seedCompany()
  const y2027 = await insertFiscalPeriod({
    userId: seed.userId,
    companyId: seed.companyId,
    name: '2027',
    periodStart: '2027-01-01',
    periodEnd: '2027-12-31',
  })
  await getPool().query(`UPDATE public.companies SET accounting_framework = 'k3' WHERE id = $1`, [seed.companyId])
  await getPool().query(`UPDATE public.fiscal_period_frameworks SET framework = 'k3' WHERE fiscal_period_id = $1`, [y2027])
  return { ...seed, y2027 }
}

type AuditRow = {
  user_id: string | null
  actor_type: string | null
  actor_label: string | null
  old_state: { development_expenditure_model: string | null }
  new_state: { development_expenditure_model: string | null }
}

const AUDIT_SQL = `SELECT user_id, actor_type, actor_label, old_state, new_state
  FROM public.audit_log
 WHERE company_id = $1 AND table_name = 'companies' AND new_state ? 'development_expenditure_model'
 ORDER BY created_at, id`

describe('set_development_expenditure_model', () => {
  it('sets the model for the owner and records who changed it from what', async () => {
    const seed = await k3Company()
    const audit = await withUserContext(seed.userId, async (client) => {
      const { rows } = await client.query<{ model: string }>(SET_SQL, [seed.companyId, 'capitalise', null, 'user', null])
      expect(rows[0].model).toBe('capitalise')
      await client.query('RESET ROLE')
      const model = await client.query<{ development_expenditure_model: string }>(
        `SELECT development_expenditure_model FROM public.companies WHERE id = $1`,
        [seed.companyId],
      )
      expect(model.rows[0].development_expenditure_model).toBe('capitalise')
      return (await client.query<AuditRow>(AUDIT_SQL, [seed.companyId])).rows
    })
    expect(audit).toEqual([
      {
        user_id: seed.userId,
        actor_type: 'user',
        actor_label: null,
        old_state: { development_expenditure_model: null },
        new_state: { development_expenditure_model: 'capitalise' },
      },
    ])
  })

  it('refuses a member who is not an owner or admin, and a K2 company', async () => {
    const seed = await k3Company()
    const member = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: member, role: 'member' })
    await expect(
      withUserContext(member, (client) => client.query(SET_SQL, [seed.companyId, 'capitalise', null, null, null])),
    ).rejects.toMatchObject({ code: '42501' })

    const k2 = await seedCompany()
    await expect(
      withUserContext(k2.userId, (client) => client.query(SET_SQL, [k2.companyId, 'capitalise', null, null, null])),
    ).rejects.toMatchObject({ code: 'PT409', message: 'DEVELOPMENT_MODEL_REFUSED' })
  })

  it('records the named user and the credential for a service-role door', async () => {
    const seed = await k3Company()
    // The pool is a superuser without JWT claims, as the service role is.
    await getPool().query(SET_SQL, [seed.companyId, 'expense', seed.userId, 'mcp_oauth', 'Claude'])
    const { rows } = await getPool().query<AuditRow>(AUDIT_SQL, [seed.companyId])
    expect(rows).toEqual([
      {
        user_id: seed.userId,
        actor_type: 'mcp_oauth',
        actor_label: 'Claude',
        old_state: { development_expenditure_model: null },
        new_state: { development_expenditure_model: 'expense' },
      },
    ])
  })

  it('records a write that bypasses the RPC, and nothing when the value stands', async () => {
    const seed = await k3Company()
    await getPool().query(
      `UPDATE public.companies SET development_expenditure_model = 'capitalise' WHERE id = $1`,
      [seed.companyId],
    )
    await getPool().query(
      `UPDATE public.companies SET development_expenditure_model = 'capitalise', name = 'Nytt namn AB' WHERE id = $1`,
      [seed.companyId],
    )
    const { rows } = await getPool().query<AuditRow>(AUDIT_SQL, [seed.companyId])
    expect(rows.map((row) => [row.old_state.development_expenditure_model, row.new_state.development_expenditure_model])).toEqual([
      [null, 'capitalise'],
    ])
  })
})

async function insertIntangible(
  seed: { userId: string; companyId: string },
  account: string,
  own?: boolean,
  acquired = '2026-03-01',
) {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.assets (
       id, user_id, company_id, name, category, acquisition_date, acquisition_cost, salvage_value,
       useful_life_months, depreciation_method, bas_asset_account, bas_accumulated_account,
       bas_expense_account${own === undefined ? '' : ', own_development'}
     ) VALUES ($1, $2, $3, 'Plattform', 'immaterial', $4::date, 100000, 0, 60, 'linear',
               $5, $6, '7810'${own === undefined ? '' : ', $7'})`,
    own === undefined
      ? [id, seed.userId, seed.companyId, acquired, account, account === '1090' ? '1099' : '1019']
      : [id, seed.userId, seed.companyId, acquired, account, account === '1090' ? '1099' : '1019', own],
  )
  return id
}

async function ownDevelopment(id: string): Promise<boolean> {
  const { rows } = await getPool().query<{ own_development: boolean }>(
    `SELECT own_development FROM public.assets WHERE id = $1`,
    [id],
  )
  return rows[0].own_development
}

describe('assets.own_development', () => {
  it('is false unless the register says so, and only ever on 101x', async () => {
    const seed = await k3Company()
    // A row the old default put on 1010 is not presumed to be own development.
    expect(await ownDevelopment(await insertIntangible(seed, '1010'))).toBe(false)
    expect(await ownDevelopment(await insertIntangible(seed, '1012', true))).toBe(true)
    await expect(insertIntangible(seed, '1090', true)).rejects.toMatchObject({ code: '23514' })
  })
})

const MARK_SQL = `SELECT public.set_asset_own_development($1::uuid, $2::uuid, $3::boolean, $4::uuid, $5::text, $6::text) AS own`

type MarkAudit = {
  user_id: string | null
  actor_type: string | null
  old_state: { own_development: boolean }
  new_state: { own_development: boolean }
}

async function markAudit(assetId: string): Promise<MarkAudit[]> {
  const { rows } = await getPool().query<MarkAudit>(
    `SELECT user_id, actor_type, old_state, new_state FROM public.audit_log
      WHERE table_name = 'assets' AND record_id = $1 AND new_state ? 'own_development'
      ORDER BY created_at, id`,
    [assetId],
  )
  return rows
}

describe('set_asset_own_development', () => {
  async function capitalising() {
    const seed = await k3Company()
    await getPool().query(`UPDATE public.companies SET development_expenditure_model = 'capitalise' WHERE id = $1`, [seed.companyId])
    return seed
  }

  it('marks an asset already on 1010 for the owner, and records who did it', async () => {
    const seed = await capitalising()
    const assetId = await insertIntangible(seed, '1010')
    await withUserContext(seed.userId, (client) => client.query(MARK_SQL, [seed.companyId, assetId, true, null, null, null]))
    // withUserContext rolls back: mark again as the service role, naming the user.
    const other = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: other, role: 'admin' })
    await getPool().query(MARK_SQL, [seed.companyId, assetId, true, other, 'mcp_oauth', 'Claude'])
    expect(await ownDevelopment(assetId)).toBe(true)
    expect(await markAudit(assetId)).toEqual([
      { user_id: other, actor_type: 'mcp_oauth', old_state: expect.objectContaining({ own_development: false }), new_state: expect.objectContaining({ own_development: true }) },
    ])
  })

  it('refuses a viewer, an asset off 1010-1019 and the kostnadsföringsmodell', async () => {
    const seed = await capitalising()
    const assetId = await insertIntangible(seed, '1010')
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: viewer, role: 'viewer' })
    await expect(
      withUserContext(viewer, (client) => client.query(MARK_SQL, [seed.companyId, assetId, true, null, null, null])),
    ).rejects.toMatchObject({ code: '42501' })

    const licence = await insertIntangible(seed, '1090')
    await expect(getPool().query(MARK_SQL, [seed.companyId, licence, true, seed.userId, null, null])).rejects.toMatchObject({
      message: 'OWN_DEVELOPMENT_ACCOUNT',
    })

    await getPool().query(`UPDATE public.companies SET development_expenditure_model = 'expense' WHERE id = $1`, [seed.companyId])
    await expect(getPool().query(MARK_SQL, [seed.companyId, assetId, true, seed.userId, null, null])).rejects.toMatchObject({
      message: 'OWN_DEVELOPMENT_NOT_CAPITALISED',
    })
    expect(await markAudit(assetId)).toEqual([])
  })

  it('records a mark changed by a plain update too, and nothing when it stands', async () => {
    const seed = await capitalising()
    const assetId = await insertIntangible(seed, '1010')
    await getPool().query(`UPDATE public.assets SET own_development = true WHERE id = $1`, [assetId])
    await getPool().query(`UPDATE public.assets SET own_development = true, name = 'Plattformen' WHERE id = $1`, [assetId])
    const rows = await markAudit(assetId)
    // No signed-in user and no named one: the asset's creator, as write_audit_log records.
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(seed.userId)
  })
})

describe('the fiscal years\' own frameworks', () => {
  // B1/F1: with 2027 elected K3 the company column says K3, but 2026 is a K2
  // year still open: no own development may be capitalised in it (BFNAR
  // 2016:10 10.4). The model, a policy for the K3 years, may be chosen.
  it('lets the model be chosen for an elected K3 year, and refuses a company with no open K3 year', async () => {
    const next = await k3NextYear()
    await expect(getPool().query(SET_SQL, [next.companyId, 'capitalise', next.userId, null, null])).resolves.toBeTruthy()

    const k2Only = await seedCompany()
    await getPool().query(`UPDATE public.companies SET accounting_framework = 'k3' WHERE id = $1`, [k2Only.companyId])
    await expect(getPool().query(SET_SQL, [k2Only.companyId, 'capitalise', k2Only.userId, null, null])).rejects.toMatchObject({
      code: 'PT409',
      message: 'DEVELOPMENT_MODEL_REFUSED',
    })
  })

  it('marks own development acquired in the K3 year, never in the K2 year before it', async () => {
    const next = await k3NextYear()
    await getPool().query(`UPDATE public.companies SET development_expenditure_model = 'capitalise' WHERE id = $1`, [next.companyId])
    const inK2Year = await insertIntangible(next, '1010', undefined, '2026-03-01')
    await expect(getPool().query(MARK_SQL, [next.companyId, inK2Year, true, next.userId, null, null])).rejects.toMatchObject({
      message: 'OWN_DEVELOPMENT_NOT_CAPITALISED',
    })
    const inK3Year = await insertIntangible(next, '1010', undefined, '2027-03-01')
    await getPool().query(MARK_SQL, [next.companyId, inK3Year, true, next.userId, null, null])
    expect(await ownDevelopment(inK3Year)).toBe(true)
  })
})
