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
  CAPABILITY_REASONS,
  capabilityDigest,
  loadCompanyCapabilities,
  resolveCapabilities,
  type CapabilityInputs,
  type ModuleCapability,
} from '../capabilities'
import { MODULES } from '../manifest'
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
