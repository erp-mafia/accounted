import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { openObligationsMessageSv, PackageSwitchParamsSchema, SWITCHABLE_PACKAGE_IDS, switchCompanyPackage } from '../package-switch'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'u0000000-0000-4000-8000-000000000001'
const OP = 'p0000000-0000-4000-8000-000000000001'

function run(rpc: { data?: unknown; error?: unknown }, input: Partial<Parameters<typeof switchCompanyPackage>[1]> = {}) {
  const mock = createTableMockSupabase({ 'rpc:set_company_package_choice': rpc })
  const result = switchCompanyPackage(mock.supabase as never, {
    companyId: COMPANY,
    userId: USER,
    pendingOperationId: OP,
    enabled: true,
    params: { package_id: 'payroll', source: 'suggestion', suggestion_key: 'enable_package:payroll' },
    actor: { type: 'api_key', label: 'Claude' },
    ...input,
  })
  return { mock, result }
}

describe('PackageSwitchParamsSchema', () => {
  it('accepts every package but Bokföring', () => {
    expect(SWITCHABLE_PACKAGE_IDS).not.toContain('bookkeeping')
    expect(SWITCHABLE_PACKAGE_IDS).toHaveLength(8)
    expect(PackageSwitchParamsSchema.safeParse({ package_id: 'payroll' }).success).toBe(true)
    expect(PackageSwitchParamsSchema.safeParse({ package_id: 'bookkeeping' }).success).toBe(false)
    expect(PackageSwitchParamsSchema.safeParse({ package_id: 'payroll', source: 'byra' }).success).toBe(false)
  })
})

describe('switchCompanyPackage', () => {
  it('writes the choice through set_company_package_choice with who decided', async () => {
    const { mock, result } = run({ data: { ok: true, unchanged: false, capability_config_id: 'cfg-1', decided_at: '2026-10-16T10:00:00Z' } })
    expect(await result).toEqual({
      ok: true,
      data: {
        package_id: 'payroll',
        package_name: 'Lön',
        enabled: true,
        changed: true,
        capability_config_id: 'cfg-1',
        decided_at: '2026-10-16T10:00:00Z',
        winding_down: false,
        open_obligations: [],
      },
    })
    expect(mock.findCall('rpc:set_company_package_choice', 'rpc')).toEqual([
      {
        p_company_id: COMPANY,
        p_package_id: 'payroll',
        p_enabled: true,
        p_source: 'suggestion',
        p_decided_by: USER,
        p_actor_type: 'api_key',
        p_actor_label: 'Claude',
        p_pending_operation_id: OP,
      },
    ])
  })

  it('records the company as the source when no suggestion staged it', async () => {
    const { mock, result } = run({ data: { ok: true, unchanged: true } }, { params: { package_id: 'assets' }, enabled: false })
    expect(await result).toMatchObject({ ok: true, data: { changed: false, enabled: false } })
    expect((mock.findCall('rpc:set_company_package_choice', 'rpc')?.[0] as Record<string, unknown>).p_source).toBe('company')
  })

  it('switches off with obligations still open and answers that the package winds down', async () => {
    const mock = createTableMockSupabase({
      'rpc:set_company_package_choice': { data: { ok: true, unchanged: false, capability_config_id: 'cfg-2' } },
      salary_runs: { data: [{ id: 'run-1' }] },
    })
    const result = await switchCompanyPackage(mock.supabase as never, {
      companyId: COMPANY,
      userId: USER,
      pendingOperationId: OP,
      enabled: false,
      params: { package_id: 'payroll', source: 'company' },
      actor: { type: 'user' },
    })
    expect(result).toMatchObject({ ok: true, data: { enabled: false, changed: true, winding_down: true } })
    expect(result.ok && result.data.open_obligations).toContain('open_salary_runs')
  })

  it('refuses with the obligations named, in Swedish, when the database still refuses (before the migration)', async () => {
    const { result } = run(
      { data: { ok: false, code: 'PACKAGE_HAS_OPEN_OBLIGATIONS', obligations: ['active_employees', 'open_salary_runs'] } },
      { enabled: false },
    )
    expect(await result).toEqual({
      ok: false,
      code: 'PACKAGE_HAS_OPEN_OBLIGATIONS',
      message_sv: 'Lön kan inte stängas av medan det finns aktiva anställda och lönekörningar som inte är bokförda.',
      status: 409,
      obligations: ['active_employees', 'open_salary_runs'],
    })
  })

  it('maps the admin refusal to 403, so the approval goes back to pending', async () => {
    const { result } = run({ data: { ok: false, code: 'PACKAGE_SWITCH_ADMIN_REQUIRED' } })
    expect(await result).toMatchObject({ ok: false, code: 'PACKAGE_SWITCH_ADMIN_REQUIRED', status: 403 })
  })

  it('throws on a database error (the commit dispatcher records it)', async () => {
    const { result } = run({ error: { message: 'connection reset' } })
    await expect(result).rejects.toThrow('connection reset')
  })
})

describe('openObligationsMessageSv', () => {
  it('joins the phrases the Swedish way', () => {
    expect(openObligationsMessageSv('assets', ['active_assets'])).toBe(
      'Inventarier kan inte stängas av medan det finns inventarier som fortfarande skrivs av.',
    )
    expect(openObligationsMessageSv('customer-invoices', ['unpaid_customer_invoices', 'active_recurring_invoices', 'open_collection_cases'])).toBe(
      'Kundfakturor kan inte stängas av medan det finns obetalda kundfakturor, aktiva återkommande fakturor och öppna inkassoärenden.',
    )
    expect(openObligationsMessageSv('bank', ['something_new'])).toBe('Bank kan inte stängas av medan något är öppet där.')
  })
})
