/**
 * The capabilities report (lib/modules/capabilities.ts): one status per
 * module with its reasons and a resolution, from the gates that already
 * exist. The resolver is pure, so every rule is pinned here without a
 * database; the loader is checked against a per-table mock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CAPABILITY, type CapabilityKey } from '@/lib/entitlements/keys'
import {
  AVAILABILITY_STATUSES,
  CAPABILITY_REASONS,
  PACKAGE_REASONS,
  capabilityDigest,
  capabilityInputsFromEntitlements,
  capabilitySurface,
  capabilitySurfaceWithoutCompany,
  loadCompanyCapabilities,
  publishedCapabilities,
  resolveCapabilities,
  type CapabilityInputs,
  type ModuleCapability,
  type PackageCapability,
} from '../capabilities'
import { MODULES } from '../manifest'
import { PACKAGES, PACKAGE_CONFIG_KEYS, packageForModule, type PackageId } from '../packages'
import { createTableMockSupabase } from '@/tests/helpers'

const MODULE_KEYS: CapabilityKey[] = [CAPABILITY.ai, CAPABILITY.bank_sync, CAPABILITY.skatteverket, CAPABILITY.collections]

function inputs(overrides: Partial<CapabilityInputs> = {}): CapabilityInputs {
  return {
    jurisdiction: 'SE',
    ledgerCurrency: 'SEK',
    entityType: 'aktiebolag',
    paysSalaries: null,
    entitled: new Set(MODULE_KEYS),
    disabled: new Set(),
    selfHosted: false,
    ...overrides,
  }
}

const allBut = (...keys: CapabilityKey[]) => new Set(MODULE_KEYS.filter((k) => !keys.includes(k)))

function moduleOf(result: ReturnType<typeof resolveCapabilities>, id: string): ModuleCapability {
  const found = result.modules.find((m) => m.id === id)
  if (!found) throw new Error(`no module ${id}`)
  return found
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveCapabilities', () => {
  it('reports every module once, in manifest order, with its manifest copy, all active for a fully entitled aktiebolag', () => {
    const result = resolveCapabilities(inputs())
    expect(result.jurisdiction).toBe('SE')
    expect(result.ledger_currency).toBe('SEK')
    expect(result.modules.map((m) => m.id)).toEqual(MODULES.map((m) => m.id))
    for (const def of MODULES) {
      const m = moduleOf(result, def.id)
      expect(m).toEqual({
        id: def.id,
        kind: def.kind,
        name: def.name,
        name_sv: def.nameSv,
        summary: def.summary,
        depends_on: [...def.dependsOn],
        status: 'active',
        reasons: [],
        resolution: null,
        package: packageForModule(def.id),
        availability: 'on',
      })
    }
  })

  it('reports a module whose plan capability is missing as needs_plan, and does not pass a plan gate on to its dependents', () => {
    const result = resolveCapabilities(inputs({ entitled: allBut(CAPABILITY.bank_sync, CAPABILITY.ai) }))
    expect(moduleOf(result, 'bank-feed')).toMatchObject({
      status: 'needs_plan',
      reasons: ['needs_plan'],
      resolution: 'Upgrade the plan to use Bank feed.',
    })
    expect(moduleOf(result, 'agent')).toMatchObject({ status: 'needs_plan', reasons: ['needs_plan'] })
    // Payment files need no bank feed: payments stays active.
    expect(moduleOf(result, 'payments')).toMatchObject({ status: 'active', reasons: [] })
  })

  it('reports a module the company disabled as off, and its dependents as off through the dependency', () => {
    const result = resolveCapabilities(inputs({ disabled: new Set([CAPABILITY.bank_sync]) }))
    expect(moduleOf(result, 'bank-feed')).toMatchObject({
      status: 'off',
      reasons: ['disabled_by_company'],
      resolution: 'Bank feed is turned off for this company.',
    })
    expect(moduleOf(result, 'payments')).toMatchObject({
      status: 'off',
      reasons: ['dependency_unavailable'],
      resolution: 'Payments needs Bank feed, which is turned off for this company.',
    })
    expect(moduleOf(result, 'transactions').status).toBe('active')
  })

  it('ranks needs_plan over off and lists every reason in precedence order', () => {
    const result = resolveCapabilities(
      inputs({ entitled: allBut(CAPABILITY.bank_sync), disabled: new Set([CAPABILITY.bank_sync]) }),
    )
    expect(moduleOf(result, 'bank-feed')).toMatchObject({
      status: 'needs_plan',
      reasons: ['needs_plan', 'disabled_by_company'],
      resolution: 'Upgrade the plan to use Bank feed.',
    })
    // Disabled is what makes the module absent for its dependents, plan or no plan.
    expect(moduleOf(result, 'payments')).toMatchObject({ status: 'off', reasons: ['dependency_unavailable'] })
  })

  it('reports every country-bound block as unsupported outside its jurisdictions, ranks it over the plan and lists the dependency last', () => {
    const result = resolveCapabilities(inputs({ jurisdiction: 'NO', entitled: allBut(CAPABILITY.bank_sync) }))
    for (const m of result.modules) {
      const def = MODULES.find((d) => d.id === m.id)!
      if (def.kind === 'kernel' || def.jurisdictions.length === 0) {
        expect(m.status, m.id).toBe('active')
      } else {
        expect(m.status, m.id).toBe('unsupported')
        expect(m.reasons[0], m.id).toBe('unsupported_country')
      }
    }
    expect(moduleOf(result, 'bank-feed')).toMatchObject({
      reasons: ['unsupported_country', 'needs_plan', 'dependency_unavailable'],
      resolution: 'Bank feed is available only for companies in SE.',
    })
    expect(moduleOf(result, 'byra')).toMatchObject({ status: 'active', reasons: [] })
  })

  it('keeps the kernels active whatever the inputs say', () => {
    const result = resolveCapabilities(
      inputs({ jurisdiction: 'NO', entitled: new Set(), disabled: new Set(MODULE_KEYS), entityType: null }),
    )
    for (const id of ['platform', 'ledger']) {
      expect(moduleOf(result, id)).toMatchObject({ status: 'active', reasons: [], resolution: null })
    }
  })

  describe('payroll offer rule (the only legal-form gate today)', () => {
    it('offers payroll to every legal person', () => {
      for (const entityType of ['aktiebolag', 'ekonomisk_forening', 'ideell_forening']) {
        expect(moduleOf(resolveCapabilities(inputs({ entityType })), 'payroll').status, entityType).toBe('active')
      }
    })

    it('reports payroll unsupported for an enskild firma that does not pay salaries, with the way to turn it on', () => {
      const payroll = moduleOf(resolveCapabilities(inputs({ entityType: 'enskild_firma', paysSalaries: false })), 'payroll')
      expect(payroll.status).toBe('unsupported')
      expect(payroll.reasons).toEqual(['unsupported_legal_form'])
      expect(payroll.resolution).toContain('pays_salaries')
    })

    it('offers payroll to an enskild firma that pays salaries', () => {
      const payroll = moduleOf(resolveCapabilities(inputs({ entityType: 'enskild_firma', paysSalaries: true })), 'payroll')
      expect(payroll).toMatchObject({ status: 'active', reasons: [] })
    })

    it('leaves the decision to pays_salaries when the stored form is unknown', () => {
      expect(moduleOf(resolveCapabilities(inputs({ entityType: null })), 'payroll').status).toBe('unsupported')
      expect(moduleOf(resolveCapabilities(inputs({ entityType: null, paysSalaries: true })), 'payroll').status).toBe('active')
    })

    it('does not pass the gate on: an enskild firma without payroll still records the owner\'s utlägg', () => {
      const result = resolveCapabilities(inputs({ entityType: 'enskild_firma', paysSalaries: false }))
      expect(moduleOf(result, 'expenses')).toMatchObject({ status: 'active', reasons: [] })
    })
  })

  it('tells a self-host to add a connector key instead of upgrading a plan', () => {
    const result = resolveCapabilities(inputs({ selfHosted: true, entitled: allBut(CAPABILITY.skatteverket) }))
    expect(moduleOf(result, 'skatteverket').resolution).toMatch(/connector key \(GNUBOK_CONNECTOR_KEY\)/)
  })

  it('writes every resolution as one dash-free English sentence, and only for a module that is not active', () => {
    const worst = [
      inputs({ jurisdiction: 'NO', entitled: new Set(), disabled: new Set(MODULE_KEYS), entityType: null }),
      inputs({ entitled: new Set(), disabled: new Set(MODULE_KEYS), entityType: 'enskild_firma' }),
      inputs({ selfHosted: true, entitled: new Set() }),
    ]
    for (const input of worst) {
      for (const m of resolveCapabilities(input).modules) {
        if (m.status === 'active') {
          expect(m.resolution, m.id).toBeNull()
          continue
        }
        expect(m.resolution, m.id).toMatch(/^[A-Z][^\n]*\.$/)
        expect(m.resolution!.slice(0, -1), m.id).not.toMatch(/\.\s/)
        expect(m.resolution, m.id).not.toMatch(/[\u2013\u2014]/)
        expect(m.reasons.length, m.id).toBeGreaterThan(0)
        for (const r of m.reasons) expect(CAPABILITY_REASONS, m.id).toContain(r)
      }
    }
  })
})

describe('capabilityDigest', () => {
  it('is empty when every module is active', () => {
    expect(capabilityDigest(resolveCapabilities(inputs()))).toEqual([])
  })

  it('lists only the modules that are not active, as id, status and reasons', () => {
    const digest = capabilityDigest(
      resolveCapabilities(inputs({ entitled: allBut(CAPABILITY.collections), entityType: 'enskild_firma' })),
    )
    expect(digest).toEqual([
      { id: 'payroll', status: 'unsupported', reasons: ['unsupported_legal_form'] },
      { id: 'collections', status: 'needs_plan', reasons: ['needs_plan'] },
    ])
  })

  it('stays small for the briefing even when every block is unavailable', () => {
    const digest = capabilityDigest(
      resolveCapabilities(inputs({ jurisdiction: 'NO', entitled: new Set(), disabled: new Set(MODULE_KEYS), entityType: null })),
    )
    expect(digest.length).toBe(MODULES.filter((m) => m.kind === 'block' && m.jurisdictions.length > 0).length)
    // Under 500 tokens in the worst case; a typical company lists zero to three modules.
    expect(JSON.stringify(digest).length).toBeLessThan(2_000)
  })
})

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

type Result = { data: unknown; error?: { message: string } | null }

/** The shared per-table mock; the grant rows answer the company_capability_grant_rows RPC. */
function mockSupabase(tables: Record<string, Result>, rpcResult: Result = { data: [] }) {
  const mock = createTableMockSupabase({ ...tables, 'rpc:company_capability_grant_rows': rpcResult })
  const calls = () => [
    ...mock.tables(),
    ...(mock.findCall('rpc:company_capability_grant_rows', 'rpc') ? ['rpc:company_capability_grant_rows'] : []),
  ]
  return { supabase: mock.supabase as unknown as SupabaseClient, calls }
}

const COMPANY_ID = '11111111-1111-4111-8111-111111111111'
const ACTIVE_GRANTS = MODULE_KEYS.map((key) => ({ capability_key: key, expires_at: null, source: 'stripe', team_id: null }))

describe('loadCompanyCapabilities', () => {
  it('reads the company, its settings, the grants and the config once each, and resolves them', async () => {
    const { supabase, calls } = mockSupabase(
      {
        companies: { data: { jurisdiction: 'SE', ledger_currency: 'SEK', entity_type: 'aktiebolag' } },
        company_settings: { data: { entity_type: 'aktiebolag', pays_salaries: false } },
        company_capability_config: { data: [{ capability_key: 'bank_sync' }] },
      },
      { data: ACTIVE_GRANTS.filter((g) => g.capability_key !== 'collections') },
    )
    const result = await loadCompanyCapabilities(supabase, COMPANY_ID)
    expect(calls().sort()).toEqual(
      ['companies', 'company_capability_config', 'company_settings', 'rpc:company_capability_grant_rows'].sort(),
    )
    expect(result).not.toBeNull()
    expect(capabilityDigest(result!)).toEqual([
      { id: 'bank-feed', status: 'off', reasons: ['disabled_by_company'] },
      { id: 'payments', status: 'off', reasons: ['dependency_unavailable'] },
      { id: 'collections', status: 'needs_plan', reasons: ['needs_plan'] },
    ])
  })

  it('reads the legal form from the companies row when the settings row has none', async () => {
    const { supabase } = mockSupabase(
      {
        companies: { data: { jurisdiction: 'SE', ledger_currency: 'SEK', entity_type: 'enskild_firma' } },
        company_settings: { data: null },
        company_capability_config: { data: [] },
      },
      { data: ACTIVE_GRANTS },
    )
    const result = await loadCompanyCapabilities(supabase, COMPANY_ID)
    expect(capabilityDigest(result!)).toEqual([
      { id: 'payroll', status: 'unsupported', reasons: ['unsupported_legal_form'] },
    ])
  })

  it('answers null for a company row that does not exist', async () => {
    const { supabase } = mockSupabase({ companies: { data: null }, company_capability_config: { data: [] } })
    expect(await loadCompanyCapabilities(supabase, COMPANY_ID)).toBeNull()
  })

  it('throws on a failed read instead of reporting a reason that may not be true', async () => {
    const companyDown = mockSupabase({ companies: { data: null, error: { message: 'down' } } })
    await expect(loadCompanyCapabilities(companyDown.supabase, COMPANY_ID)).rejects.toThrow(/company: down/)
    const grantsDown = mockSupabase(
      { companies: { data: { jurisdiction: 'SE', ledger_currency: 'SEK', entity_type: 'aktiebolag' } } },
      { data: null, error: { message: 'rpc down' } },
    )
    await expect(loadCompanyCapabilities(grantsDown.supabase, COMPANY_ID)).rejects.toThrow(/rpc down/)
  })

  it('on a self-host holds every local capability and says how to unlock a connector one', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const { supabase } = mockSupabase({
      companies: { data: { jurisdiction: 'SE', ledger_currency: 'SEK', entity_type: 'aktiebolag' } },
      company_settings: { data: { entity_type: 'aktiebolag', pays_salaries: null } },
      company_capability_config: { data: [] },
    })
    const result = await loadCompanyCapabilities(supabase, COMPANY_ID)
    const notActive = capabilityDigest(result!).map((m) => m.id)
    expect(notActive).not.toContain('agent')
    expect(notActive).toEqual(expect.arrayContaining(['bank-feed', 'skatteverket', 'collections']))
    expect(result!.modules.find((m) => m.id === 'bank-feed')!.resolution).toMatch(/GNUBOK_CONNECTOR_KEY/)
  })
})

describe('loadCompanyCapabilities: package switches', () => {
  it('reads the package switches in the same config query as the capability keys', async () => {
    const mock = createTableMockSupabase({
      companies: { data: { jurisdiction: 'SE', ledger_currency: 'SEK', entity_type: 'aktiebolag' } },
      company_settings: { data: { entity_type: 'aktiebolag', pays_salaries: null } },
      company_capability_config: { data: [{ capability_key: 'package:payroll' }, { capability_key: 'bank_sync' }] },
      'rpc:company_capability_grant_rows': { data: ACTIVE_GRANTS },
    })
    const result = await loadCompanyCapabilities(mock.supabase as unknown as SupabaseClient, COMPANY_ID)
    const inCalls = mock.findCalls('company_capability_config', 'in')
    expect(inCalls).toHaveLength(1)
    expect(inCalls[0][0]).toBe('capability_key')
    expect([...(inCalls[0][1] as string[])].sort()).toEqual([...MODULE_KEYS, ...PACKAGE_CONFIG_KEYS].sort())
    expect(mock.tables().filter((t) => t === 'company_capability_config')).toHaveLength(1)
    expect(packageOf(result!, 'payroll')).toMatchObject({ availability: 'off', reasons: ['turned_off_by_company'] })
    // The capability key still reads on its own axis, never as a package.
    expect(moduleOf(result!, 'bank-feed')).toMatchObject({ status: 'off', availability: 'off' })
    expect(packageOf(result!, 'bank').availability).toBe('on')
  })
})

// ---------------------------------------------------------------------------
// Packages and availability
// ---------------------------------------------------------------------------

function packageOf(result: ReturnType<typeof resolveCapabilities>, id: PackageId): PackageCapability {
  const found = result.packages.find((p) => p.id === id)
  if (!found) throw new Error(`no package ${id}`)
  return found
}

describe('resolveCapabilities: packages', () => {
  it('gives every company the implicit Standard profile with every package on when it can use them all', () => {
    const result = resolveCapabilities(inputs())
    expect(result.profile).toEqual({ id: 'standard', source: 'implicit' })
    expect(result.packages.map((p) => p.id)).toEqual(PACKAGES.map((p) => p.id))
    for (const p of result.packages) expect(p, p.id).toMatchObject({ availability: 'on', reasons: [] })
    for (const m of result.modules) expect(m.availability, m.id).toBe('on')
  })

  it('reports each package with its Swedish name, its modules and whether it can be switched', () => {
    const result = resolveCapabilities(inputs())
    expect(packageOf(result, 'bookkeeping')).toMatchObject({ name_sv: 'Bokföring', switchable: false })
    expect(packageOf(result, 'pos-and-webshop')).toMatchObject({
      name: 'Point of sale and webshop',
      name_sv: 'Kassa och webbshop',
      switchable: true,
      modules: ['pos', 'webshop'],
    })
    expect(moduleOf(result, 'collections').package).toBe('customer-invoices')
    expect(moduleOf(result, 'agent').package).toBeNull()
  })

  it('turns a package off on the company choice, and with it every module in it, but not a dependent in another package', () => {
    const result = resolveCapabilities(inputs({ packageChoices: { payroll: false } }))
    expect(packageOf(result, 'payroll')).toMatchObject({ availability: 'off', reasons: ['turned_off_by_company'] })
    expect(moduleOf(result, 'payroll')).toMatchObject({ availability: 'off', status: 'active' })
    // Utlägg needs payroll's code, not the Lön package switched on.
    expect(moduleOf(result, 'expenses').availability).toBe('on')
  })

  it('keeps Bokföring on whatever the company chose', () => {
    const result = resolveCapabilities(inputs({ packageChoices: { bookkeeping: false } }))
    expect(packageOf(result, 'bookkeeping')).toMatchObject({ availability: 'on', reasons: [] })
    expect(moduleOf(result, 'vat').availability).toBe('on')
  })

  it('winds a switched-off package down while it has open obligations', () => {
    const result = resolveCapabilities(
      inputs({ packageChoices: { payroll: false }, openObligations: new Set<PackageId>(['payroll']) }),
    )
    expect(packageOf(result, 'payroll')).toMatchObject({
      availability: 'winding_down',
      reasons: ['turned_off_by_company', 'open_obligations'],
    })
    expect(moduleOf(result, 'payroll').availability).toBe('winding_down')
    // Obligations alone change nothing for a package that is on.
    const on = resolveCapabilities(inputs({ openObligations: new Set<PackageId>(['payroll']) }))
    expect(packageOf(on, 'payroll')).toMatchObject({ availability: 'on', reasons: [] })
  })

  it('reports a package as outside the plan only when every module in it needs a capability the plan lacks', () => {
    const result = resolveCapabilities(inputs({ entitled: allBut(CAPABILITY.bank_sync, CAPABILITY.collections) }))
    expect(packageOf(result, 'bank')).toMatchObject({ availability: 'not_in_plan', reasons: ['needs_plan'] })
    expect(moduleOf(result, 'bank-feed').availability).toBe('not_in_plan')
    // Kundfakturor has free invoicing: on, with collections alone outside the plan.
    expect(packageOf(result, 'customer-invoices').availability).toBe('on')
    expect(moduleOf(result, 'collections').availability).toBe('not_in_plan')
    expect(moduleOf(result, 'invoicing').availability).toBe('on')
  })

  it('ranks a switch over the plan: a package the company turned off reads off, not upgrade', () => {
    const result = resolveCapabilities(inputs({ entitled: allBut(CAPABILITY.bank_sync), packageChoices: { bank: false } }))
    expect(packageOf(result, 'bank')).toMatchObject({ availability: 'off', reasons: ['turned_off_by_company', 'needs_plan'] })
    expect(moduleOf(result, 'bank-feed').availability).toBe('off')
  })

  it('reports country-bound packages and modules as not_in_country, and never the kernel or the country-neutral modules', () => {
    const result = resolveCapabilities(inputs({ jurisdiction: 'NO' }))
    for (const p of result.packages) {
      if (p.id === 'bookkeeping') expect(p.availability, p.id).toBe('on')
      else expect(p, p.id).toMatchObject({ availability: 'not_in_country', reasons: ['unsupported_country'] })
    }
    expect(moduleOf(result, 'vat').availability).toBe('not_in_country')
    for (const id of ['platform', 'ledger', 'byra']) expect(moduleOf(result, id).availability, id).toBe('on')
  })

  it('maps the module gates onto availability: legal form, company switch and a turned-off dependency are off', () => {
    const ef = resolveCapabilities(inputs({ entityType: 'enskild_firma', paysSalaries: false }))
    expect(moduleOf(ef, 'payroll')).toMatchObject({ status: 'unsupported', availability: 'off' })
    expect(packageOf(ef, 'payroll').availability).toBe('on')

    const disabled = resolveCapabilities(inputs({ disabled: new Set([CAPABILITY.bank_sync]) }))
    expect(moduleOf(disabled, 'bank-feed').availability).toBe('off')
    expect(moduleOf(disabled, 'payments').availability).toBe('off')
    expect(packageOf(disabled, 'bank').availability).toBe('on')
  })

  it('applies no country gate when the jurisdiction is not known', () => {
    const result = resolveCapabilities(inputs({ jurisdiction: null }))
    for (const m of result.modules) expect(m.availability, m.id).toBe('on')
    expect(result.jurisdiction).toBeNull()
  })

  it('only ever uses the declared statuses and reasons', () => {
    const worst = [
      inputs({ jurisdiction: 'NO', entitled: new Set(), disabled: new Set(MODULE_KEYS), entityType: null }),
      inputs({
        entitled: new Set(),
        packageChoices: Object.fromEntries(PACKAGES.map((p) => [p.id, false])),
        openObligations: new Set<PackageId>(['payroll']),
      }),
    ]
    for (const input of worst) {
      const result = resolveCapabilities(input)
      for (const p of result.packages) {
        expect(AVAILABILITY_STATUSES, p.id).toContain(p.availability)
        for (const r of p.reasons) expect(PACKAGE_REASONS, p.id).toContain(r)
        if (p.availability === 'on') expect(p.reasons, p.id).toEqual([])
        else expect(p.reasons.length, p.id).toBeGreaterThan(0)
      }
      for (const m of result.modules) expect(AVAILABILITY_STATUSES, m.id).toContain(m.availability)
    }
  })
})

describe('capabilitySurface', () => {
  it('hides nothing and gates nothing for a company that can use everything', () => {
    expect(capabilitySurface(resolveCapabilities(inputs()))).toEqual({ hidden: [], notForLegalForm: [] })
  })

  it('names payroll as not offered for an enskild firma that does not pay salaries, and hides nothing', () => {
    const surface = capabilitySurface(resolveCapabilities(inputs({ entityType: 'enskild_firma', paysSalaries: false })))
    expect(surface).toEqual({ hidden: [], notForLegalForm: ['payroll'] })
  })

  it('hides nothing for missing plan capabilities or turned-off capability keys: those gates answer at the door', () => {
    const surface = capabilitySurface(
      resolveCapabilities(inputs({ entitled: new Set(), disabled: new Set(MODULE_KEYS) })),
    )
    expect(surface.hidden).toEqual([])
  })

  it('hides every module of a switched-off package, keeps a winding-down one, and hides what the country lacks', () => {
    expect(capabilitySurface(resolveCapabilities(inputs({ packageChoices: { 'pos-and-webshop': false } }))).hidden).toEqual([
      'pos',
      'webshop',
    ])
    const winding = resolveCapabilities(
      inputs({ packageChoices: { payroll: false }, openObligations: new Set<PackageId>(['payroll']) }),
    )
    expect(capabilitySurface(winding).hidden).toEqual([])
    const abroad = capabilitySurface(resolveCapabilities(inputs({ jurisdiction: 'NO' })))
    expect(abroad.hidden).not.toContain('ledger')
    expect(abroad.hidden).not.toContain('platform')
    expect(abroad.hidden).toContain('vat')
  })

  it('without an active company, gates payroll on the placeholder legal form and hides nothing', () => {
    expect(capabilitySurfaceWithoutCompany('enskild_firma')).toEqual({ hidden: [], notForLegalForm: ['payroll'] })
    expect(capabilitySurfaceWithoutCompany('aktiebolag')).toEqual({ hidden: [], notForLegalForm: [] })
  })
})

describe('capabilityInputsFromEntitlements', () => {
  it('builds the same inputs the loader reads, from getCompanyEntitlements and the company rows', () => {
    const built = capabilityInputsFromEntitlements(
      { jurisdiction: 'SE', ledgerCurrency: 'SEK', entityType: 'aktiebolag', paysSalaries: null },
      {
        capabilities: ['skatteverket', 'email_send'],
        entitledCapabilities: ['skatteverket', 'email_send', 'bank_sync'],
        disabledConfigKeys: ['bank_sync', 'package:assets', 'package:nope', 'something_else'],
      },
    )
    expect(built).toMatchObject({ jurisdiction: 'SE', ledgerCurrency: 'SEK', entityType: 'aktiebolag', paysSalaries: null })
    expect([...built.entitled].sort()).toEqual(['bank_sync', 'email_send', 'skatteverket'])
    expect([...built.disabled]).toEqual(['bank_sync'])
    expect(built.packageChoices).toEqual({ assets: false })
    const result = resolveCapabilities(built)
    expect(moduleOf(result, 'bank-feed')).toMatchObject({ status: 'off', reasons: ['disabled_by_company'] })
    expect(packageOf(result, 'assets').availability).toBe('off')
  })

  it('reads an older entitlements answer (capabilities only) as entitled with nothing turned off', () => {
    const built = capabilityInputsFromEntitlements(
      { jurisdiction: undefined, entityType: 'aktiebolag', paysSalaries: undefined },
      { capabilities: ['ai'] },
    )
    expect(built.jurisdiction).toBeNull()
    expect([...built.entitled]).toEqual(['ai'])
    expect(built.disabled.size).toBe(0)
    expect(built.packageChoices).toEqual({})
  })
})

describe('publishedCapabilities', () => {
  it('publishes the module report field for field, without packages, profile or availability', () => {
    const result = resolveCapabilities(inputs({ entityType: 'enskild_firma', paysSalaries: false }))
    const published = publishedCapabilities(result)
    expect(Object.keys(published)).toEqual(['jurisdiction', 'ledger_currency', 'modules'])
    expect(published.modules).toHaveLength(MODULES.length)
    for (const m of published.modules) {
      expect(Object.keys(m)).toEqual(['id', 'kind', 'name', 'name_sv', 'summary', 'depends_on', 'status', 'reasons', 'resolution'])
    }
    expect(published.modules.find((m) => m.id === 'payroll')).toMatchObject({
      status: 'unsupported',
      reasons: ['unsupported_legal_form'],
    })
  })
})
