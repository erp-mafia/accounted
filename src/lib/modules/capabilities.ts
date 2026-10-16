/**
 * Capabilities: the one resolved object that says what a company can use,
 * per package (./packages.ts) and per module (./manifest.ts), and why not
 * when it cannot. Modelled on Stripe's account capabilities.
 *
 *   capabilities = country pack ∩ plan entitlements ∩ (profile defaults ⊕ company choices) ⊕ open obligations
 *
 * Every surface reads this one object: the menu (lib/navigation/nav-gates.ts,
 * through capabilitySurface), MCP's tools/list and agent briefing, and
 * GET /api/v1/companies/{companyId}/capabilities (publishedCapabilities, the
 * module report v1 has always served).
 *
 * The inputs are the ones that exist today: the company's jurisdiction, the
 * plan grants and company_capability_config (capability keys, and package
 * switches under `package:<id>`), the payroll offer rule. Profiles do not
 * exist yet, so every company has the implicit "Standard (allt på)" profile,
 * every package on: what a company can use today resolves to on, and nothing
 * any reader shows changes. Read-only: nothing here writes, and nothing yet
 * switches a package.
 *
 * Two vocabularies, one object:
 *   - `availability` (packages and modules): on, off, winding_down,
 *     not_in_plan, not_in_country. What the readers decide with.
 *   - `status` (modules): active, off, needs_plan, unsupported, with
 *     `reasons` and `resolution`. The published v1 report and the briefing
 *     digest, unchanged.
 *
 * resolveCapabilities() is pure over loaded inputs, so every rule is unit
 * tested without a database; loadCompanyCapabilities() loads those inputs in
 * one parallel wave, and capabilityInputsFromEntitlements() builds them from
 * the reads the dashboard layout already makes, so the menu costs no read of
 * its own.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isEntityType } from '@/lib/company/entity-type'
import { offersPayroll } from '@/lib/company/offers-payroll'
import { readCapabilityAxes } from '@/lib/entitlements/has-capability'
import { CAPABILITY, type CapabilityKey } from '@/lib/entitlements/keys'
import { isSelfHosted } from '@/lib/env/public-flags'
import { MODULES, type ModuleDefinition, type ModuleId, type ModuleKind } from './manifest'
import {
  PACKAGES,
  PACKAGE_CONFIG_KEYS,
  packageForConfigKey,
  packageForModule,
  type PackageDefinition,
  type PackageId,
} from './packages'
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

/**
 * Whether a package, or a module, is there for the company:
 *   - on: switched on, in the plan and offered in the country.
 *   - off: switched off (by the profile or the company), or for a module,
 *     not offered for the legal form, turned off by the company, or needing
 *     a module that is turned off.
 *   - winding_down: switched off while obligations are still open (a salary
 *     payment in flight, an open invoice): no new work starts, the open work
 *     stays reachable until it is settled. Reserved: nothing can be switched
 *     off yet, so nothing winds down; the step that lets a package be turned
 *     off loads the obligations (CapabilityInputs.openObligations).
 *   - not_in_plan: the paid plan does not include it.
 *   - not_in_country: the company's country does not have it.
 */
export const AVAILABILITY_STATUSES = ['on', 'off', 'winding_down', 'not_in_plan', 'not_in_country'] as const
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number]

/** Why a package is not on, in precedence order: the first decides its availability. */
export const PACKAGE_REASONS = [
  'unsupported_country',
  'turned_off_by_company',
  'off_in_profile',
  'open_obligations',
  'needs_plan',
] as const
export type PackageReason = (typeof PACKAGE_REASONS)[number]

/**
 * The profile every company has until profiles exist: "Standard (allt på)",
 * every package on, so nothing disappears for anyone. The profiles step
 * gives each company a stored profile id and version; this is the default
 * existing companies and self-hosts keep.
 */
export const IMPLICIT_PROFILE = Object.freeze({
  id: 'standard',
  nameSv: 'Standard (allt på)',
  /** The switchable packages this profile starts with off. */
  packagesOff: Object.freeze([] as PackageId[]),
})

export interface ProfileRef {
  id: string
  /** implicit: no profile is stored for the company; the default applies. */
  source: 'implicit'
}

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
  /** The package the module belongs to; null for platform, agent and byra. Not published by v1 yet. */
  package: PackageId | null
  /**
   * The module's availability: its package's, narrowed by the module's own
   * gates (country, legal form, company switch, dependency, plan). `reasons`
   * explain the module's own part, `package` points at the rest. Not
   * published by v1 yet.
   */
  availability: AvailabilityStatus
}

export interface PackageCapability {
  id: PackageId
  name: string
  name_sv: string
  /** False for Bokföring: always on. */
  switchable: boolean
  modules: ModuleId[]
  availability: AvailabilityStatus
  /** Every reason that applies, in PACKAGE_REASONS order; empty when on. */
  reasons: PackageReason[]
}

export interface CompanyCapabilities {
  /** companies.jurisdiction; null when no company row is known (then no country gate applies). */
  jurisdiction: string | null
  /** companies.ledger_currency; null when no company row is known. */
  ledger_currency: string | null
  profile: ProfileRef
  /** One entry per package, in PACKAGES order. */
  packages: PackageCapability[]
  /** One entry per module, in manifest order (kernels first). */
  modules: ModuleCapability[]
}

/** What the resolver needs to know about one company, already loaded. */
export interface CapabilityInputs {
  /**
   * companies.jurisdiction (ISO 3166-1 alpha-2). Null when the company row
   * is not known (no active company, a failed read): no country gate then,
   * because a reader must never hide on a guess.
   */
  jurisdiction: string | null
  /** companies.ledger_currency (ISO 4217). Reported, not yet a gate. */
  ledgerCurrency: string | null
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
  /**
   * The company's own package switches (company_capability_config,
   * `package:<id>`): false turns a package off, true on, absent leaves it to
   * the profile. Only switch-offs are read today, which is all an
   * every-package-on profile can be changed by.
   */
  packageChoices?: Partial<Record<PackageId, boolean>>
  /**
   * Packages with open obligations: a switched-off package among them is
   * winding_down instead of off. Not loaded yet (nothing can be switched off
   * yet); the step that lets a package be turned off loads it.
   */
  openObligations?: ReadonlySet<PackageId>
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

function inCountry(mod: ModuleDefinition, jurisdiction: string | null): boolean {
  return jurisdiction === null || mod.jurisdictions.length === 0 || mod.jurisdictions.includes(jurisdiction)
}

function ownReasons(mod: ModuleDefinition, input: CapabilityInputs): OwnReason[] {
  const reasons: OwnReason[] = []
  if (!inCountry(mod, input.jurisdiction)) reasons.push('unsupported_country')
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
 * need no bank feed. A package switch does not pass on either: it hides the
 * package's own doors, while a dependent in another package keeps the code
 * it shares (Utlägg without Lön still pays out the owner's receipts).
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

/**
 * One package's availability. A package exists in the country when any of
 * its modules does (a kernel always does); it is switched on by the
 * company's choice, else by the profile (Bokföring always); it is in the
 * plan unless every module in it needs a capability the plan lacks.
 */
function resolvePackage(pkg: PackageDefinition, input: CapabilityInputs): PackageCapability {
  const reasons: PackageReason[] = []
  const mods = pkg.modules.map((id) => getModule(id))
  if (!mods.some((m) => m.kind === 'kernel' || inCountry(m, input.jurisdiction))) reasons.push('unsupported_country')
  if (pkg.switchable) {
    const choice = input.packageChoices?.[pkg.id]
    if (choice === false) reasons.push('turned_off_by_company')
    else if (choice === undefined && IMPLICIT_PROFILE.packagesOff.includes(pkg.id)) reasons.push('off_in_profile')
    const off = reasons.includes('turned_off_by_company') || reasons.includes('off_in_profile')
    if (off && input.openObligations?.has(pkg.id)) reasons.push('open_obligations')
  }
  if (mods.every((m) => m.capability !== undefined && !input.entitled.has(m.capability))) reasons.push('needs_plan')

  let availability: AvailabilityStatus = 'on'
  if (reasons.includes('unsupported_country')) availability = 'not_in_country'
  else if (reasons.includes('open_obligations')) availability = 'winding_down'
  else if (reasons.includes('turned_off_by_company') || reasons.includes('off_in_profile')) availability = 'off'
  else if (reasons.includes('needs_plan')) availability = 'not_in_plan'

  return {
    id: pkg.id,
    name: pkg.name,
    name_sv: pkg.nameSv,
    switchable: pkg.switchable,
    modules: [...pkg.modules],
    availability,
    reasons,
  }
}

/**
 * A module's availability: the country first (its own, a dependency's, its
 * package's), then its package's switch, then the module's own switches
 * (legal form, company, a turned-off dependency), then the plan. A switch
 * outranks the plan, so a package the company turned off reads off, not
 * "upgrade to get it".
 */
function moduleAvailability(
  own: readonly OwnReason[],
  blocking: Absence | null,
  pkg: PackageCapability | null,
): AvailabilityStatus {
  if (own.includes('unsupported_country') || blocking === 'unsupported' || pkg?.availability === 'not_in_country') {
    return 'not_in_country'
  }
  if (pkg?.availability === 'winding_down') return 'winding_down'
  if (pkg?.availability === 'off') return 'off'
  if (own.includes('unsupported_legal_form') || own.includes('disabled_by_company') || blocking === 'off') return 'off'
  if (own.includes('needs_plan')) return 'not_in_plan'
  return 'on'
}

/** Every package's and module's availability for one company, from inputs already loaded. Pure. */
export function resolveCapabilities(input: CapabilityInputs): CompanyCapabilities {
  const packages = PACKAGES.map((p) => resolvePackage(p, input))
  const packageById = new Map(packages.map((p) => [p.id, p]))
  const absence = new Map<ModuleId, Absence | null>()
  const byId = new Map<ModuleId, ModuleCapability>()

  for (const mod of modulesInDependencyOrder()) {
    const packageId = packageForModule(mod.id)
    const pkg = packageId ? packageById.get(packageId)! : null
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
      byId.set(mod.id, {
        ...base,
        status: 'active',
        reasons: [],
        resolution: null,
        package: packageId,
        availability: 'on',
      })
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
      package: packageId,
      availability: moduleAvailability(own, blocking?.absence ?? null, pkg),
    })
  }

  return {
    jurisdiction: input.jurisdiction,
    ledger_currency: input.ledgerCurrency,
    profile: { id: IMPLICIT_PROFILE.id, source: 'implicit' },
    packages,
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

/** One module as GET /api/v1/companies/{companyId}/capabilities publishes it. */
export type PublishedModuleCapability = Omit<ModuleCapability, 'package' | 'availability'>

export interface PublishedCapabilities {
  jurisdiction: string | null
  ledger_currency: string | null
  modules: PublishedModuleCapability[]
}

/**
 * The report v1 publishes: the module statuses, reasons and resolutions it
 * has always served, field for field. Packages, profiles and availability
 * stay internal until the API publishes them.
 */
export function publishedCapabilities(capabilities: CompanyCapabilities): PublishedCapabilities {
  return {
    jurisdiction: capabilities.jurisdiction,
    ledger_currency: capabilities.ledger_currency,
    modules: capabilities.modules.map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      name_sv: m.name_sv,
      summary: m.summary,
      depends_on: m.depends_on,
      status: m.status,
      reasons: m.reasons,
      resolution: m.resolution,
    })),
  }
}

/**
 * What a menu or a tool list reads off the resolved capabilities: plain
 * data, small enough to hand to a client component.
 */
export interface CapabilitySurface {
  /**
   * Modules whose doors no surface shows: their package is switched off or
   * not in the company's country, or the module itself is not in the
   * country. The menu and MCP's tools/list both hide these. A winding_down
   * package stays (its open work must be reachable), and so does a package
   * outside the plan (the paywall answers at the door with how to get it).
   * Empty for every company today.
   */
  hidden: ModuleId[]
  /**
   * Modules the company's legal form does not offer: payroll for an enskild
   * firma that has not said it pays salaries (#782). The menu hides these,
   * as it always has; MCP lists their tools and refuses the writes at the
   * call, as it always has.
   */
  notForLegalForm: ModuleId[]
}

/** The surface view of the resolved capabilities. */
export function capabilitySurface(capabilities: CompanyCapabilities): CapabilitySurface {
  const packageAvailability = new Map(capabilities.packages.map((p) => [p.id, p.availability]))
  return {
    hidden: capabilities.modules
      .filter((m) => {
        const pkg = m.package ? packageAvailability.get(m.package) : undefined
        return pkg === 'off' || pkg === 'not_in_country' || m.availability === 'not_in_country'
      })
      .map((m) => m.id),
    notForLegalForm: capabilities.modules.filter((m) => m.reasons.includes('unsupported_legal_form')).map((m) => m.id),
  }
}

/** The capability keys that gate a module: the only keys the loader asks about. */
const MODULE_CAPABILITY_KEYS: readonly CapabilityKey[] = [
  ...new Set(MODULES.flatMap((m) => (m.capability ? [m.capability] : []))),
]

const CAPABILITY_KEY_VALUES = new Set<string>(Object.values(CAPABILITY))

/** Package choices from the company_capability_config keys that are turned off. */
function packageChoicesFrom(disabledConfigKeys: Iterable<string>): Partial<Record<PackageId, boolean>> {
  const choices: Partial<Record<PackageId, boolean>> = {}
  for (const key of disabledConfigKeys) {
    const id = packageForConfigKey(key)
    if (id) choices[id] = false
  }
  return choices
}

/**
 * The resolver's inputs from what the dashboard layout and the assistant's
 * UI map already read: the company rows and getCompanyEntitlements (whose
 * config read carries the package switches too). Same rules as
 * loadCompanyCapabilities, no read of its own. Under the local-development
 * paywall bypass getCompanyEntitlements reads no config, so no switch
 * applies there.
 */
export function capabilityInputsFromEntitlements(
  company: {
    jurisdiction: string | null | undefined
    ledgerCurrency?: string | null
    entityType: unknown
    paysSalaries: boolean | null | undefined
  },
  entitlements: {
    capabilities: readonly string[]
    entitledCapabilities?: readonly string[]
    disabledConfigKeys?: readonly string[]
  },
): CapabilityInputs {
  const entitled = entitlements.entitledCapabilities ?? entitlements.capabilities
  const disabledConfigKeys = entitlements.disabledConfigKeys ?? []
  return {
    jurisdiction: company.jurisdiction ?? null,
    ledgerCurrency: company.ledgerCurrency ?? null,
    entityType: company.entityType,
    paysSalaries: company.paysSalaries ?? null,
    entitled: new Set(entitled.filter((k) => CAPABILITY_KEY_VALUES.has(k)) as CapabilityKey[]),
    disabled: new Set(disabledConfigKeys.filter((k) => CAPABILITY_KEY_VALUES.has(k)) as CapabilityKey[]),
    selfHosted: isSelfHosted(),
    packageChoices: packageChoicesFrom(disabledConfigKeys),
  }
}

/**
 * The surface for a dashboard without an active company (the byrå cockpit,
 * a stale company cookie): no country, plan or switch to read, only the
 * placeholder legal form the layout renders the menu with.
 */
export function capabilitySurfaceWithoutCompany(entityType: unknown): CapabilitySurface {
  return capabilitySurface(
    resolveCapabilities(
      capabilityInputsFromEntitlements(
        { jurisdiction: null, entityType, paysSalaries: null },
        { capabilities: [] },
      ),
    ),
  )
}

/**
 * Load one company's inputs and resolve them: the company row, its settings
 * row, the grants and the capability config (capability keys and package
 * switches in one query), all in one parallel wave. Null when the company
 * row does not exist. A failed read throws: the report would otherwise state
 * a reason that is not true.
 */
export async function loadCompanyCapabilities(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyCapabilities | null> {
  const [companyRes, settingsRes, axes] = await Promise.all([
    supabase.from('companies').select('jurisdiction, ledger_currency, entity_type').eq('id', companyId).maybeSingle(),
    supabase.from('company_settings').select('entity_type, pays_salaries').eq('company_id', companyId).maybeSingle(),
    readCapabilityAxes(supabase, companyId, MODULE_CAPABILITY_KEYS, { configKeys: PACKAGE_CONFIG_KEYS }),
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
    packageChoices: packageChoicesFrom(axes.disabledConfigKeys),
  })
}
