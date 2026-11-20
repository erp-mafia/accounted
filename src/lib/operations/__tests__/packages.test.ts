/**
 * The package operations (lib/operations/packages.ts): the list with status
 * and what keeps a switched-off package winding down, and the staged switch:
 * refused on only for plan, country or legal form, never refused off, and
 * never written directly.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { MODULES } from '@/lib/modules/manifest'
import { packagesDisable, packagesEnable, packagesList } from '../packages'
import { stageOperation } from '../stage'

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const ALL_GRANTS = [...new Set(MODULES.flatMap((m) => (m.capability ? [m.capability] : [])))].map((key) => ({
  capability_key: key,
  expires_at: null,
  source: 'stripe',
  team_id: null,
}))

function companyTables(overrides: Parameters<typeof createTableMockSupabase>[0] = {}) {
  return createTableMockSupabase({
    companies: { data: { jurisdiction: 'SE', ledger_currency: 'SEK', entity_type: 'aktiebolag' } },
    company_settings: { data: { entity_type: 'aktiebolag', pays_salaries: true } },
    company_capability_config: { data: [] },
    'rpc:company_capability_grant_rows': { data: ALL_GRANTS },
    ...overrides,
  })
}

function ctx(mock: ReturnType<typeof createTableMockSupabase>) {
  return {
    supabase: mock.supabase as unknown as SupabaseClient,
    companyId: COMPANY_ID,
    userId: USER_ID,
    log: createLogger('test'),
  }
}

describe('packages.list', () => {
  it('lists every package on for a company without a profile or a switch', async () => {
    const result = await packagesList.run(ctx(companyTables()), {}, { dryRun: false })
    if (!result.ok || result.dryRun) throw new Error('expected data')
    expect(result.data.profile).toEqual({ profile_id: 'standard', name_sv: 'Standard (allt på)', source: 'implicit' })
    expect(result.data.packages).toHaveLength(9)
    for (const p of result.data.packages) expect(p, p.package_id).toMatchObject({ availability: 'on', open_obligations: [] })
    expect(result.data.packages.find((p) => p.package_id === 'bookkeeping')!.switchable).toBe(false)
  })

  it('names what keeps a switched-off package winding down', async () => {
    const mock = companyTables({
      company_capability_config: { data: [{ capability_key: 'package:payroll', enabled: false }] },
      salary_runs: ((chain) =>
        chain.some((c) => c.method === 'in' && (c.args[1] as string[]).includes('draft')) ? { data: [{ id: 'r1' }] } : { data: [] }) as TableMockResolver,
    })
    const result = await packagesList.run(ctx(mock), {}, { dryRun: false })
    if (!result.ok || result.dryRun) throw new Error('expected data')
    expect(result.data.packages.find((p) => p.package_id === 'payroll')).toMatchObject({
      availability: 'winding_down',
      open_obligations: [{ code: 'open_salary_runs', label_sv: 'lönekörningar som inte är betalda och bokförda' }],
    })
  })
})

describe('packages.enable', () => {
  it('previews switching a package on', async () => {
    const mock = companyTables({ company_capability_config: { data: [{ capability_key: 'package:assets', enabled: false }] } })
    expect(await packagesEnable.run(ctx(mock), { package_id: 'assets' }, { dryRun: true })).toEqual({
      ok: true,
      dryRun: true,
      preview: { package_id: 'assets', package: 'Inventarier', change: 'Slå på', availability: 'off' },
    })
  })

  it('refuses for the legal form, the plan and the country, and nothing else', async () => {
    const ef = companyTables({ company_settings: { data: { entity_type: 'enskild_firma', pays_salaries: false } } })
    expect(await packagesEnable.run(ctx(ef), { package_id: 'payroll' }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'PACKAGE_NOT_FOR_LEGAL_FORM',
    })
    const noPlan = companyTables({ 'rpc:company_capability_grant_rows': { data: [] } })
    expect(await packagesEnable.run(ctx(noPlan), { package_id: 'bank' }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'PACKAGE_NOT_IN_PLAN',
      messageSv: 'Bank ingår inte i företagets abonnemang.',
    })
    const abroad = companyTables({ companies: { data: { jurisdiction: 'NO', ledger_currency: 'NOK', entity_type: 'aktiebolag' } } })
    expect(await packagesEnable.run(ctx(abroad), { package_id: 'expenses' }, { dryRun: true })).toMatchObject({
      ok: false,
      code: 'PACKAGE_NOT_IN_COUNTRY',
    })
  })

  it('never switches directly: the switch is staged and approved', async () => {
    expect(await packagesEnable.run(ctx(companyTables()), { package_id: 'assets' }, { dryRun: false })).toEqual({
      ok: false,
      code: 'PACKAGE_SWITCH_STAGE_ONLY',
    })
  })

  it('accepts only a switchable package', () => {
    expect(packagesEnable.input.safeParse({ package_id: 'bookkeeping' }).success).toBe(false)
    expect(packagesEnable.input.safeParse({ package_id: 'payroll' }).success).toBe(true)
  })
})

describe('packages.disable', () => {
  it('previews what will keep the package winding down, probed before the switch', async () => {
    const mock = companyTables({ invoices: { data: [{ id: 'i1' }] } })
    expect(await packagesDisable.run(ctx(mock), { package_id: 'customer-invoices' }, { dryRun: true })).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        package_id: 'customer-invoices',
        package: 'Kundfakturor',
        change: 'Stäng av',
        availability: 'on',
        winding_down: true,
        open_obligations: ['unpaid_customer_invoices'],
        open_obligations_sv: 'obetalda kundfakturor',
      },
    })
  })

  it('is never refused for what is open, and previews a clean switch when nothing is', async () => {
    const result = await packagesDisable.run(ctx(companyTables()), { package_id: 'assets' }, { dryRun: true })
    expect(result).toMatchObject({ ok: true, preview: { winding_down: false, open_obligations: [] } })
  })

  it('stages disable_package with the approver-facing preview', async () => {
    const mock = companyTables({
      invoices: { data: [{ id: 'i1' }] },
      pending_operations: { data: { id: 'op-1', operation_type: 'disable_package', status: 'pending' } },
    })
    const staged = await stageOperation(
      packagesDisable,
      ctx(mock),
      { package_id: 'customer-invoices' },
      { type: 'api_key', id: 'key-1', label: 'Claude' },
      { dryRun: false },
    )
    if (!staged.ok || staged.dryRun) throw new Error('expected a staged row')
    expect(staged.plan).toMatchObject({
      pendingType: 'disable_package',
      title: 'Stäng av Kundfakturor',
      params: { package_id: 'customer-invoices' },
      preview: { package: 'Kundfakturor', change: 'Stäng av', open_obligations: 'obetalda kundfakturor' },
    })
  })
})
