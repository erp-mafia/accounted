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
 * The inputs: the company's jurisdiction, the plan grants and
 * company_capability_config (capability keys, and package switches under
 * `package:<id>`), the payroll offer rule, and the company's profile
 * (companies.profile_id and profile_version, ./profiles.ts). A company
 * without a stored profile, which is every company that existed before
 * profiles, has "Standard (allt på)", every package on, so what it can use
 * resolves exactly as before. Read-only: nothing here writes.
 *
 * Two vocabularies, one object:
 *   - `availability` (packages and modules): on, off, winding_down,
 *     not_in_plan, not_in_country. What the readers decide with.
 *   - `status` (modules): active, off, needs_plan, unsupported, with
 *     `reasons` and `resolution`. The published v1 report and the briefing
 *     digest, unchanged.
 *
 * Beside them `parts`: a part of an active module switched on company by
 * company (ROLLOUT_PARTS), whose doors refuse a company outside it while the
 * module itself is active.
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
import { commitmentsEnabledFor } from '@/lib/env/commitments-switch'
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
import { readStoredProfile } from './stored-profile'
import {
  packageSwitchedOff,
  resolveStoredProfile,
  type ProfileDefinition,
  type ProfileId,
  type StoredProfile,
} from './profiles'
import { loadOpenObligations } from './obligations'
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
 *     run not booked, an open invoice; ./obligations.ts): no new work
 *     starts (./package-doors.ts refuses the start doors), the open work
 *     stays reachable until it is settled, then the package is off.
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
 * The company's profile as the resolver applied it: the stored one, or
 * "Standard (allt på)" (every package on) when none is stored, which is what
 * every company that existed before profiles has.
 */
export interface ProfileRef {
  id: ProfileId
  /** The version whose package defaults applied. */
  version: number
  name: string
  name_sv: string
  /**
   * stored: companies.profile_id. implicit: none is stored (or the stored id
   * or version is one this code does not know), so Standard applies.
   */
  source: 'stored' | 'implicit'
}

/**
 * Parts of a module switched on company by company: a staged rollout by
 * company id, not a plan, a package or a setting the company can change.
 * The module stays active (its other doors answer) while the part's doors
 * refuse a company the rollout does not name, so the report says so beside
 * the module instead of calling the whole of it active.
 */
export const ROLLOUT_PARTS = [
  // Avtal och åtaganden (lib/commitments): agreements, ställda säkerheter,
  // eventualförpliktelser and the group links, refused with
  // COMMITMENTS_UNAVAILABLE outside BOLAGET_COMPANY_IDS.
  { id: 'commitments', module: 'year-end', name: 'Agreements and commitments', nameSv: 'Avtal och åtaganden' },
] as const satisfies ReadonlyArray<{ id: string; module: ModuleId; name: string; nameSv: string }>

export type RolloutPartId = (typeof ROLLOUT_PARTS)[number]['id']

/** Why a part is not active: it is switched on company by company and not for this one. */
export const PART_REASONS = ['switched_on_per_company'] as const
export type PartReason = (typeof PART_REASONS)[number]

export interface ModulePartCapability {
  id: RolloutPartId
  name: string
  name_sv: string
  /** active: on for this company. off: the rollout does not name it. */
  status: 'active' | 'off'
  /** Empty when active. */
  reasons: PartReason[]
  /** One English sentence a client can show; null when active. */
  resolution: string | null
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
  /** Its parts switched on company by company (ROLLOUT_PARTS); empty for most modules. */
  parts: ModulePartCapability[]
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
  /**
   * The open obligations (./obligations.ts) that keep a switched-off package
   * winding down, in PACKAGE_OBLIGATIONS order. Probed only for a package
   * that is switched off; empty for every other package and whenever the
   * obligations were not loaded.
   */
  open_obligations: string[]
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
   * companies.profile_id and profile_version: the profile whose package
   * defaults apply where the company made no choice. Absent or NULL is
   * "Standard (allt på)", every package on.
   */
  profile?: StoredProfile | null
  /**
   * The company's own package switches (company_capability_config,
   * `package:<id>`): false turns a package off, true on, absent leaves it to
   * the profile. A choice always wins over the profile.
   */
  packageChoices?: Partial<Record<PackageId, boolean>>
  /**
   * The open obligations per package (./obligations.ts, loadOpenObligations):
   * a switched-off package with any is winding_down instead of off. Loaded
   * only for the packages that are switched off; absent means not loaded,
   * and a package without an entry is off.
   */
  openObligations?: Partial<Record<PackageId, readonly string[]>>
  /**
   * Whether each rollout part is switched on for the company (ROLLOUT_PARTS).
   * Absent means not known, and a part not known reads active: a reader must
   * never hide on a guess.
   */
  rolloutParts?: Partial<Record<RolloutPartId, boolean>>
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

/** The rollout parts of one module, as the company has them. */
function partsFor(mod: ModuleDefinition, input: CapabilityInputs): ModulePartCapability[] {
  return ROLLOUT_PARTS.filter((part) => part.module === mod.id).map((part) => {
    const on = input.rolloutParts?.[part.id] ?? true
    return {
      id: part.id,
      name: part.name,
      name_sv: part.nameSv,
      status: on ? 'active' : 'off',
      reasons: on ? [] : ['switched_on_per_company'],
      resolution: on
        ? null
        : input.selfHosted
          ? `${part.name} is switched on company by company: add the company id to BOLAGET_COMPANY_IDS on this instance.`
          : `${part.name} is switched on company by company and is not on for this company: write to support@accounted.se to have it switched on.`,
    }
  })
}

/**
 * One package's availability. A package exists in the country when any of
 * its modules does (a kernel always does); it is switched on by the
 * company's choice, else by the profile's default (Bokföring always); it is
 * in the plan unless every module in it needs a capability the plan lacks.
 */
function resolvePackage(
  pkg: PackageDefinition,
  input: CapabilityInputs,
  profile: ProfileDefinition,
): PackageCapability {
  const reasons: PackageReason[] = []
  const mods = pkg.modules.map((id) => getModule(id))
  if (!mods.some((m) => m.kind === 'kernel' || inCountry(m, input.jurisdiction))) reasons.push('unsupported_country')
  let openObligations: string[] = []
  const switchedOff = packageSwitchedOff(pkg, profile, input.packageChoices?.[pkg.id])
  if (switchedOff) {
    reasons.push(switchedOff)
    openObligations = [...(input.openObligations?.[pkg.id] ?? [])]
    if (openObligations.length > 0) reasons.push('open_obligations')
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
    open_obligations: openObligations,
  }
}

/** The packages that are switched off (by the company or its profile), winding down or not. */
export function switchedOffPackageIds(capabilities: CompanyCapabilities): PackageId[] {
  return capabilities.packages
    .filter((p) => p.reasons.includes('turned_off_by_company') || p.reasons.includes('off_in_profile'))
    .map((p) => p.id)
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
  const profile = resolveStoredProfile(input.profile)
  const packages = PACKAGES.map((p) => resolvePackage(p, input, profile.definition))
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
        parts: partsFor(mod, input),
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
      parts: partsFor(mod, input),
      package: packageId,
      availability: moduleAvailability(own, blocking?.absence ?? null, pkg),
    })
  }

  return {
    jurisdiction: input.jurisdiction,
    ledger_currency: input.ledgerCurrency,
    profile: {
      id: profile.definition.id,
      version: profile.definition.version,
      name: profile.definition.name,
      name_sv: profile.definition.nameSv,
      source: profile.source,
    },
    packages,
    modules: MODULES.map((m) => byId.get(m.id)!),
  }
}

/** A module as the briefing digest lists it; `parts` only when one of its rollout parts is not active. */
export type CapabilityDigestEntry = Pick<ModuleCapability, 'id' | 'status' | 'reasons'> & {
  parts?: Array<Pick<ModulePartCapability, 'id' | 'status' | 'reasons'>>
}

/**
 * The compact form for the agent briefing: only the modules that are not
 * active, as id, status and reasons, and an active module whose rollout part
 * is not active, with that part. An active module is implied by its
 * absence, so a company with everything on costs an empty list.
 */
export function capabilityDigest(capabilities: CompanyCapabilities): CapabilityDigestEntry[] {
  return capabilities.modules.flatMap((m): CapabilityDigestEntry[] => {
    const offParts = m.parts.filter((p) => p.status !== 'active').map((p) => ({ id: p.id, status: p.status, reasons: p.reasons }))
    if (m.status === 'active' && offParts.length === 0) return []
    return [{ id: m.id, status: m.status, reasons: m.reasons, ...(offParts.length > 0 ? { parts: offParts } : {}) }]
  })
}

/** One module as GET /api/v1/companies/{companyId}/capabilities publishes it. */
export type PublishedModuleCapability = Omit<ModuleCapability, 'package' | 'availability'>

/** The company's profile as v1 publishes it. */
export type PublishedProfile = ProfileRef

export interface PublishedCapabilities {
  jurisdiction: string | null
  ledger_currency: string | null
  /** Added with profiles: the profile behind which packages the company's menus and tool list show. */
  profile: PublishedProfile
  modules: PublishedModuleCapability[]
}

/**
 * The report v1 publishes: the module statuses, reasons and resolutions it
 * has always served, field for field, plus the company's profile (an
 * additive field). Packages and availability stay internal: a module in a
 * package the profile leaves off is hidden from menus and tools/list but
 * still works when called, so its status stays what its gates say.
 */
export function publishedCapabilities(capabilities: CompanyCapabilities): PublishedCapabilities {
  return {
    jurisdiction: capabilities.jurisdiction,
    ledger_currency: capabilities.ledger_currency,
    profile: { ...capabilities.profile },
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
      parts: m.parts,
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
   * Empty for every company without a stored profile or a package switch.
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

/**
 * Package choices from the company_capability_config keys: a package key
 * turned off is false, one turned on is true (it wins over a profile that
 * leaves the package off). Any other key is ignored here.
 */
function packageChoicesFrom(
  disabledConfigKeys: Iterable<string>,
  enabledConfigKeys: Iterable<string> = [],
): Partial<Record<PackageId, boolean>> {
  const choices: Partial<Record<PackageId, boolean>> = {}
  for (const key of enabledConfigKeys) {
    const id = packageForConfigKey(key)
    if (id) choices[id] = true
  }
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
    /** companies.profile_id; absent or null is Standard. */
    profileId?: string | null
    /** companies.profile_version. */
    profileVersion?: number | null
  },
  entitlements: {
    capabilities: readonly string[]
    entitledCapabilities?: readonly string[]
    disabledConfigKeys?: readonly string[]
    enabledConfigKeys?: readonly string[]
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
    profile: { id: company.profileId ?? null, version: company.profileVersion ?? null },
    packageChoices: packageChoicesFrom(disabledConfigKeys, entitlements.enabledConfigKeys ?? []),
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

export { readStoredProfile } from './stored-profile'

export interface LoadCapabilitiesOptions {
  /**
   * Probe the open obligations of the packages that are switched off, so a
   * package with open work resolves to winding_down instead of off (default
   * true). A second wave of small reads that runs only when a package is
   * switched off: a company with every package on reads nothing more.
   */
  obligations?: boolean
  /**
   * Where the obligations come from, for a caller that shares one probe per
   * request between readers (the dashboard's request cache). Defaults to
   * loadOpenObligations on the same client.
   */
  loadObligations?: ObligationsLoader
}

/** Loads the open obligations of the given packages. */
export type ObligationsLoader = (packageIds: PackageId[]) => Promise<Partial<Record<PackageId, readonly string[]>>>

/**
 * Load one company's inputs and resolve them: the company row, its stored
 * profile, its settings row, the grants and the capability config
 * (capability keys and package switches in one query), all in one parallel
 * wave, then the open obligations of any package that is switched off.
 * Null when the company row does not exist. A failed read throws: the
 * report would otherwise state a reason that is not true.
 */
export async function loadCompanyCapabilities(
  supabase: SupabaseClient,
  companyId: string,
  options: LoadCapabilitiesOptions = {},
): Promise<CompanyCapabilities | null> {
  const [companyRes, settingsRes, axes, profile] = await Promise.all([
    supabase.from('companies').select('jurisdiction, ledger_currency, entity_type').eq('id', companyId).maybeSingle(),
    supabase.from('company_settings').select('entity_type, pays_salaries').eq('company_id', companyId).maybeSingle(),
    readCapabilityAxes(supabase, companyId, MODULE_CAPABILITY_KEYS, { configKeys: PACKAGE_CONFIG_KEYS }),
    readStoredProfile(supabase, companyId),
  ])
  if (companyRes.error) throw new Error(`Failed to load company: ${companyRes.error.message}`)
  if (settingsRes.error) throw new Error(`Failed to load company settings: ${settingsRes.error.message}`)
  const company = companyRes.data as { jurisdiction: string; ledger_currency: string; entity_type: string | null } | null
  if (!company) return null
  const settings = settingsRes.data as { entity_type: string | null; pays_salaries: boolean | null } | null

  const inputs: CapabilityInputs = {
    jurisdiction: company.jurisdiction,
    ledgerCurrency: company.ledger_currency,
    // Same resolution as the dashboard layout: settings first, the canonical row when missing.
    entityType: isEntityType(settings?.entity_type) ? settings.entity_type : company.entity_type,
    paysSalaries: settings?.pays_salaries ?? null,
    entitled: axes.entitled,
    disabled: axes.disabled,
    selfHosted: isSelfHosted(),
    profile,
    packageChoices: packageChoicesFrom(axes.disabledConfigKeys, axes.enabledConfigKeys),
    rolloutParts: { commitments: commitmentsEnabledFor(companyId) },
  }
  const resolved = resolveCapabilities(inputs)
  return options.obligations === false
    ? resolved
    : withOpenObligations(supabase, companyId, inputs, resolved, options.loadObligations)
}

/**
 * Resolve again with the open obligations of the packages `resolved` has
 * switched off, so those with open work read winding_down. Returns
 * `resolved` itself, without a read, when no package is switched off.
 */
export async function withOpenObligations(
  supabase: SupabaseClient,
  companyId: string,
  inputs: CapabilityInputs,
  resolved: CompanyCapabilities,
  loadObligations?: ObligationsLoader,
): Promise<CompanyCapabilities> {
  const off = switchedOffPackageIds(resolved)
  if (off.length === 0) return resolved
  const openObligations = loadObligations ? await loadObligations(off) : await loadOpenObligations(supabase, companyId, off)
  return resolveCapabilities({ ...inputs, openObligations })
}
