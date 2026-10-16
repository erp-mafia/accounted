import { randomUUID } from 'crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * A company's package choice and who decided it (migration 20261016200400):
 * set_company_package_choice writes the company_capability_config row
 * `package:<id>` with source, approver and credential, refuses a member who
 * is not an owner or admin, refuses to switch a package off while
 * package_open_obligations names anything, writes the audit_log row
 * behandlingshistorik reads, and writes nothing for a choice equal to the
 * stored one. package_usage answers every switchable package in one call.
 */

interface ChoiceResult {
  ok: boolean
  code?: string
  unchanged?: boolean
  enabled?: boolean
  previous_enabled?: boolean | null
  obligations?: string[]
  capability_config_id?: string
}

async function setChoice(params: {
  companyId: string
  packageId: string
  enabled: boolean
  decidedBy: string
  source?: 'company' | 'suggestion'
  actorType?: string | null
  actorLabel?: string | null
  pendingOperationId?: string | null
}): Promise<ChoiceResult> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: ChoiceResult }>(
      `SELECT public.set_company_package_choice($1, $2, $3, $4, $5, $6, $7, $8) AS result`,
      [
        params.companyId,
        params.packageId,
        params.enabled,
        params.source ?? 'suggestion',
        params.decidedBy,
        params.actorType ?? 'user',
        params.actorLabel ?? null,
        params.pendingOperationId ?? null,
      ],
    )
    return rows[0].result
  })
}

async function choiceRow(companyId: string, packageId: string) {
  const { rows } = await getPool().query(
    `SELECT enabled, source, decided_by, decided_actor_type, decided_actor_label, decided_at, pending_operation_id
       FROM public.company_capability_config
      WHERE company_id = $1 AND capability_key = $2`,
    [companyId, `package:${packageId}`],
  )
  return rows[0] ?? null
}

async function auditRows(companyId: string) {
  const { rows } = await getPool().query(
    `SELECT action, actor_type, actor_label, user_id, old_state, new_state, description
       FROM public.audit_log
      WHERE company_id = $1 AND table_name = 'company_capability_config'
      ORDER BY created_at, id`,
    [companyId],
  )
  return rows
}

describe('set_company_package_choice', () => {
  let ownerId: string
  let companyId: string

  beforeEach(async () => {
    const seeded = await seedCompany()
    ownerId = seeded.userId
    companyId = seeded.companyId
  })

  it('switches a package on for an owner and records who decided, with an audit row', async () => {
    const opId = randomUUID()
    await getPool().query(
      `INSERT INTO public.pending_operations (id, user_id, company_id, operation_type, title, actor_type, actor_label, risk_level)
       VALUES ($1, $2, $3, 'enable_package', 'Slå på Lön?', 'system', 'Accounted', 'low')`,
      [opId, ownerId, companyId],
    )
    const result = await setChoice({
      companyId,
      packageId: 'payroll',
      enabled: true,
      decidedBy: ownerId,
      actorType: 'api_key',
      actorLabel: 'Claude',
      pendingOperationId: opId,
    })
    expect(result).toMatchObject({ ok: true, unchanged: false, enabled: true, previous_enabled: null })

    const row = await choiceRow(companyId, 'payroll')
    expect(row).toMatchObject({
      enabled: true,
      source: 'suggestion',
      decided_by: ownerId,
      decided_actor_type: 'api_key',
      decided_actor_label: 'Claude',
      pending_operation_id: opId,
    })
    expect(row.decided_at).not.toBeNull()

    const audit = await auditRows(companyId)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'INSERT', actor_type: 'api_key', actor_label: 'Claude', user_id: ownerId, old_state: null })
    expect(audit[0].new_state).toMatchObject({ capability_key: 'package:payroll', enabled: true, source: 'suggestion' })
  })

  it('writes nothing for a choice equal to the stored one', async () => {
    await setChoice({ companyId, packageId: 'assets', enabled: true, decidedBy: ownerId })
    const again = await setChoice({ companyId, packageId: 'assets', enabled: true, decidedBy: ownerId })
    expect(again).toMatchObject({ ok: true, unchanged: true })
    expect(await auditRows(companyId)).toHaveLength(1)
  })

  it('refuses a member who is not an owner or admin, and a package that cannot be switched', async () => {
    const memberId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: memberId, role: 'member' })
    expect(await setChoice({ companyId, packageId: 'payroll', enabled: true, decidedBy: memberId })).toEqual({
      ok: false,
      code: 'PACKAGE_SWITCH_ADMIN_REQUIRED',
    })
    expect(await setChoice({ companyId, packageId: 'bookkeeping', enabled: false, decidedBy: ownerId })).toEqual({
      ok: false,
      code: 'PACKAGE_NOT_SWITCHABLE',
    })
    expect(await choiceRow(companyId, 'payroll')).toBeNull()
    expect(await auditRows(companyId)).toHaveLength(0)
  })

  it('accepts an admin', async () => {
    const adminId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: adminId, role: 'admin' })
    expect(await setChoice({ companyId, packageId: 'expenses', enabled: true, decidedBy: adminId })).toMatchObject({ ok: true })
  })

  it('refuses to switch a package off while it has open obligations, and switches it off once they are settled', async () => {
    const employeeId = randomUUID()
    await getPool().query(
      `INSERT INTO public.employees (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
       VALUES ($1, $2, $3, 'Anna', 'Andersson', 'sealed', '1234', '2026-01-01')`,
      [employeeId, companyId, ownerId],
    )
    const refused = await setChoice({ companyId, packageId: 'payroll', enabled: false, decidedBy: ownerId })
    expect(refused).toEqual({ ok: false, code: 'PACKAGE_HAS_OPEN_OBLIGATIONS', obligations: ['active_employees'] })
    expect(await choiceRow(companyId, 'payroll')).toBeNull()

    await getPool().query(`UPDATE public.employees SET is_active = false WHERE id = $1`, [employeeId])
    const off = await setChoice({ companyId, packageId: 'payroll', enabled: false, decidedBy: ownerId, source: 'company' })
    expect(off).toMatchObject({ ok: true, enabled: false })
    expect(await choiceRow(companyId, 'payroll')).toMatchObject({ enabled: false, source: 'company' })

    const on = await setChoice({ companyId, packageId: 'payroll', enabled: true, decidedBy: ownerId })
    expect(on).toMatchObject({ ok: true, enabled: true, previous_enabled: false })
    const audit = await auditRows(companyId)
    expect(audit.map((r) => r.action)).toEqual(['INSERT', 'UPDATE'])
    expect(audit[1].old_state).toMatchObject({ enabled: false })
    expect(audit[1].new_state).toMatchObject({ enabled: true })
  })

  it('records an actor type outside audit_log\'s list as the user', async () => {
    const result = await setChoice({ companyId, packageId: 'bank', enabled: true, decidedBy: ownerId, actorType: 'robot' })
    expect(result).toMatchObject({ ok: true })
    expect((await auditRows(companyId))[0]).toMatchObject({ actor_type: 'user' })
  })

  it('is the service role\'s alone', async () => {
    await expect(
      withUserContext(ownerId, (client) =>
        client.query(`SELECT public.set_company_package_choice($1, 'payroll', true, 'company', $2)`, [companyId, ownerId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(ownerId, (client) => client.query(`SELECT public.package_usage($1, now())`, [companyId])),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('package_open_obligations and package_usage', () => {
  it('names the open work per package and answers every switchable package once', async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.assets (company_id, user_id, name, category, acquisition_date, acquisition_cost, useful_life_months,
                                  bas_asset_account, bas_accumulated_account, bas_expense_account)
       VALUES ($1, $2, 'Dator', 'computer', '2026-01-10', 20000, 36, '1250', '1259', '7832')`,
      [companyId, userId],
    )
    const usage = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ package_id: string; used_since: boolean; open_obligations: string[] }>(
        `SELECT * FROM public.package_usage($1, now() - interval '6 months') ORDER BY package_id`,
        [companyId],
      )
      return rows
    })
    expect(usage.map((r) => r.package_id)).toEqual([
      'assets',
      'bank',
      'customer-invoices',
      'expenses',
      'payroll',
      'pos-and-webshop',
      'receipts-and-documents',
      'supplier-invoices-and-payments',
    ])
    const assets = usage.find((r) => r.package_id === 'assets')!
    expect(assets).toEqual({ package_id: 'assets', used_since: true, open_obligations: ['active_assets'] })
    for (const row of usage.filter((r) => r.package_id !== 'assets')) {
      expect(row).toMatchObject({ used_since: false, open_obligations: [] })
    }

    const unknown = await runAsServiceRole(async (client) => {
      const { rows } = await client.query<{ o: string[] }>(`SELECT public.package_open_obligations($1, 'bookkeeping') AS o`, [companyId])
      return rows[0].o
    })
    expect(unknown).toEqual(['not_switchable'])
  })
})
