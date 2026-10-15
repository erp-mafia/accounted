/**
 * Capabilities: which building blocks (./manifest.ts) one company can use
 * right now, and why not when it cannot. Modelled on Stripe's account
 * capabilities: every module gets a status, the reasons behind it and one
 * sentence a client can show. Served by
 * GET /api/v1/companies/{companyId}/capabilities and, for the modules that
 * are not active, by the MCP agent briefing.
 *
 * Read-only by design. It reports the gates that already exist (the paid
 * plan, the per-company capability config, the payroll offer rule, the
 * company's pinned jurisdiction) and adds none: no route or tool reads it to
 * decide what a user may do. The per-company module switch comes later.
 *
 * resolveCapabilities() is pure over loaded inputs, so every rule is unit
 * tested without a database; loadCompanyCapabilities() loads those inputs in
 * one parallel wave and resolves them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isEntityType } from '@/lib/company/entity-type'
import { offersPayroll } from '@/lib/company/offers-payroll'
import { readCapabilityAxes } from '@/lib/entitlements/has-capability'
import type { CapabilityKey } from '@/lib/entitlements/keys'
import { isSelfHosted } from '@/lib/env/public-flags'
import { MODULES, type ModuleDefinition, type ModuleId, type ModuleKind } from './manifest'
import { getModule, modulesInDependencyOrder } from './resolve'

export const CAPABILITY_STATUSES = ['active', 'off', 'needs_plan', 'unsupported'] as const
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number]

/**
 * Every reason code, in precedence order: the first one a module has decides
 * its status. A module's own reasons always outrank a dependency.
 */
export const CAPABILITY_REASONS = [
  'unsupported_country',
  'unsupported_legal_form',
  'needs_plan',
  'disabled_by_company',
  'dependency_unavailable',
] as const
export type CapabilityReason = (typeof CAPABILITY_REASONS)[number]

type OwnReason = Exclude<CapabilityReason, 'dependency_unavailable'>

const STATUS_FOR: Record<OwnReason, CapabilityStatus> = {
  unsupported_country: 'unsupported',
  unsupported_legal_form: 'unsupported',
  needs_plan: 'needs_plan',
  disabled_by_company: 'off',
}

export interface ModuleCapability {
  id: ModuleId
  kind: ModuleKind
  name: string
  name_sv: string
  summary: string
  /** The blocks this module needs present (the kernel is implicit). */
  depends_on: ModuleId[]
  status: CapabilityStatus
  /** Every reason that applies, in CAPABILITY_REASONS order; empty when active. */
  reasons: CapabilityReason[]
  /** One English sentence a client can show; null when active. */
  resolution: string | null
}

export interface CompanyCapabilities {
  jurisdiction: string
  ledger_currency: string
  /** One entry per module, in manifest order (kernels first). */
  modules: ModuleCapability[]
}

/** What the resolver needs to know about one company, already loaded. */
export interface CapabilityInputs {
  /** companies.jurisdiction (ISO 3166-1 alpha-2). */
  jurisdiction: string
  /** companies.ledger_currency (ISO 4217). Reported, not yet a gate. */
  ledgerCurrency: string
  /** The stored legal form: company_settings.entity_type, else companies.entity_type. */
  entityType: unknown
  /** company_settings.pays_salaries. */
  paysSalaries: boolean | null
  /** Capability keys the plan entitles (readCapabilityAxes). */
  entitled: ReadonlySet<CapabilityKey>
  /** Capability keys the company has disabled (readCapabilityAxes). */
  disabled: ReadonlySet<CapabilityKey>
  /** A self-host fixes a missing paid capability with a connector key, not a plan. */
  selfHosted: boolean
}

/**
 * Legal-form gates, by module. Only a rule the product already enforces
 * elsewhere belongs here: a new one is a product decision about the law, not
 * a detail of this report.
 */
const LEGAL_FORM_GATES: Partial<Record<ModuleId, { allows: (input: CapabilityInputs) => boolean; resolution: string }>> = {
  // The rule behind the dashboard's payroll section and the MCP payroll:write blocker.
  payroll: {
    allows: (input) => offersPayroll(input.entityType, input.paysSalaries),
    resolution:
      'Payroll is on for every legal person; an enskild firma turns it on by setting pays_salaries in the company tax profile.',
  },
}

function ownReasons(mod: ModuleDefinition, input: CapabilityInputs): OwnReason[] {
  const reasons: OwnReason[] = []
  if (mod.jurisdictions.length > 0 && !mod.jurisdictions.includes(input.jurisdiction)) {
    reasons.push('unsupported_country')
  }
  const gate = LEGAL_FORM_GATES[mod.id]
  if (gate && !gate.allows(input)) reasons.push('unsupported_legal_form')
  if (mod.capability) {
    if (!input.entitled.has(mod.capability)) reasons.push('needs_plan')
    if (input.disabled.has(mod.capability)) reasons.push('disabled_by_company')
  }
  return reasons
}

/**
 * The status a module passes on to the modules that depend on it: set only
 * when the module is absent for the company, because its country is not
 * supported or the company turned it off. A plan or legal-form gate limits
 * the module's own features, not the code its dependents share: an enskild
 * firma without payroll still records the owner's utlägg, and payment files
 * need no bank feed.
 */
type Absence = 'unsupported' | 'off'

function absenceOf(reasons: readonly OwnReason[], inherited: Absence | null): Absence | null {
  if (reasons.includes('unsupported_country')) return 'unsupported'
  if (inherited === 'unsupported') return 'unsupported'
  if (reasons.includes('disabled_by_company')) return 'off'
  return inherited
}

function resolutionFor(
  mod: ModuleDefinition,
  reason: CapabilityReason,
  input: CapabilityInputs,
  blockingDependency: { name: string; absence: Absence } | null,
): string {
  switch (reason) {
    case 'unsupported_country':
      return `${mod.name} is available only for companies in ${mod.jurisdictions.join(', ')}.`
    case 'unsupported_legal_form':
      return LEGAL_FORM_GATES[mod.id]?.resolution ?? `${mod.name} is not offered for this legal form.`
    case 'needs_plan':
      return input.selfHosted
        ? `Add an Accounted connector key (GNUBOK_CONNECTOR_KEY) or the instance's own credentials for the service to use ${mod.name}.`
        : `Upgrade the plan to use ${mod.name}.`
    case 'disabled_by_company':
      return `${mod.name} is turned off for this company.`
    case 'dependency_unavailable': {
      const dep = blockingDependency
      const why = dep?.absence === 'unsupported' ? 'not available for this company' : 'turned off for this company'
      return `${mod.name} needs ${dep?.name ?? 'another module'}, which is ${why}.`
    }
  }
}

/** Every module's status for one company, from inputs already loaded. Pure. */
export function resolveCapabilities(input: CapabilityInputs): CompanyCapabilities {
  const absence = new Map<ModuleId, Absence | null>()
  const byId = new Map<ModuleId, ModuleCapability>()

  for (const mod of modulesInDependencyOrder()) {
    const base = {
      id: mod.id,
      kind: mod.kind,
      name: mod.name,
      name_sv: mod.nameSv,
      summary: mod.summary,
      depends_on: [...mod.dependsOn],
    }
    if (mod.kind === 'kernel') {
      absence.set(mod.id, null)
      byId.set(mod.id, { ...base, status: 'active', reasons: [], resolution: null })
      continue
    }

    // Dependencies come first in this order, so their absence is known. The
    // most severe absent dependency is the one the resolution names.
    let blocking: { name: string; absence: Absence } | null = null
    for (const depId of mod.dependsOn) {
      const depAbsence = absence.get(depId) ?? null
      if (depAbsence && (!blocking || (depAbsence === 'unsupported' && blocking.absence === 'off'))) {
        blocking = { name: getModule(depId).name, absence: depAbsence }
      }
    }

    const own = ownReasons(mod, input)
    const reasons: CapabilityReason[] = blocking ? [...own, 'dependency_unavailable'] : own
    const status: CapabilityStatus = own.length > 0 ? STATUS_FOR[own[0]] : (blocking?.absence ?? 'active')
    absence.set(mod.id, absenceOf(own, blocking?.absence ?? null))
    byId.set(mod.id, {
      ...base,
      status,
      reasons,
      resolution: reasons.length > 0 ? resolutionFor(mod, reasons[0], input, blocking) : null,
    })
  }

  return {
    jurisdiction: input.jurisdiction,
    ledger_currency: input.ledgerCurrency,
    modules: MODULES.map((m) => byId.get(m.id)!),
  }
}

/**
 * The compact form for the agent briefing: only the modules that are not
 * active, as id, status and reasons. An active module is implied by its
 * absence, so a company with everything on costs an empty list.
 */
export function capabilityDigest(
  capabilities: CompanyCapabilities,
): Array<Pick<ModuleCapability, 'id' | 'status' | 'reasons'>> {
  return capabilities.modules
    .filter((m) => m.status !== 'active')
    .map((m) => ({ id: m.id, status: m.status, reasons: m.reasons }))
}

/** The capability keys that gate a module: the only keys the loader asks about. */
const MODULE_CAPABILITY_KEYS: readonly CapabilityKey[] = [
  ...new Set(MODULES.flatMap((m) => (m.capability ? [m.capability] : []))),
]

/**
 * Load one company's inputs and resolve them: the company row, its settings
 * row, the grants and the capability config, all in one parallel wave.
 * Null when the company row does not exist. A failed read throws: the report
 * would otherwise state a reason that is not true.
 */
export async function loadCompanyCapabilities(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyCapabilities | null> {
  const [companyRes, settingsRes, axes] = await Promise.all([
    supabase.from('companies').select('jurisdiction, ledger_currency, entity_type').eq('id', companyId).maybeSingle(),
    supabase.from('company_settings').select('entity_type, pays_salaries').eq('company_id', companyId).maybeSingle(),
    readCapabilityAxes(supabase, companyId, MODULE_CAPABILITY_KEYS),
  ])
  if (companyRes.error) throw new Error(`Failed to load company: ${companyRes.error.message}`)
  if (settingsRes.error) throw new Error(`Failed to load company settings: ${settingsRes.error.message}`)
  const company = companyRes.data as { jurisdiction: string; ledger_currency: string; entity_type: string | null } | null
  if (!company) return null
  const settings = settingsRes.data as { entity_type: string | null; pays_salaries: boolean | null } | null

  return resolveCapabilities({
    jurisdiction: company.jurisdiction,
    ledgerCurrency: company.ledger_currency,
    // Same resolution as the dashboard layout: settings first, the canonical row when missing.
    entityType: isEntityType(settings?.entity_type) ? settings.entity_type : company.entity_type,
    paysSalaries: settings?.pays_salaries ?? null,
    entitled: axes.entitled,
    disabled: axes.disabled,
    selfHosted: isSelfHosted(),
  })
}
