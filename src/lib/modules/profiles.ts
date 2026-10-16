/**
 * Profiles: named starting points over the packages (./packages.ts) of the
 * Profiles and Suggestions design (2026-10-16). A profile says which
 * switchable packages a company starts with on; Bokföring is always on and
 * never named. A company stores the id and version of its profile
 * (companies.profile_id, companies.profile_version); NULL is "Standard (allt
 * på)", every package on, which is what every company that existed before
 * profiles keeps. The company's own package choices win over the profile
 * (./capabilities.ts).
 *
 * Versioned data: every published version stays in PROFILE_VERSIONS and is
 * never edited. A change to a profile appends the next version; a company
 * keeps resolving the version it stored, so a new version can never take a
 * package away from a company that has one (additions reach existing
 * companies as suggestions, a later step). New companies get the latest
 * version. __tests__/profiles.test.ts holds the rules: versions count 1, 2,
 * 3 per id, every profile states every switchable package and names no other.
 *
 * Ids are English, kebab-case and country-neutral like the package ids: a
 * country pack decides which packages exist (the resolver's country gate
 * runs before the profile), so no profile is copied per country. The list is
 * the design's proposal and Jakob's to confirm; companies.profile_id has a
 * CHECK on these ids, so adding a profile is a migration that widens it.
 * Pure data with no server imports: client code may read it.
 */
import type { EntityType } from '@/types'
import { PACKAGES, type PackageId } from './packages'

export const PROFILE_IDS = [
  'sole-trader',
  'limited-company-no-employees',
  'limited-company-with-employees',
  'retail',
  'association',
  'standard',
] as const

export type ProfileId = (typeof PROFILE_IDS)[number]

/** The profile a company without a stored profile has: every package on. */
export const STANDARD_PROFILE_ID: ProfileId = 'standard'

/** The packages a profile states: every package a company can switch. */
export type SwitchablePackageId = Exclude<PackageId, 'bookkeeping'>

export type PackageDefault = 'on' | 'off'

export interface ProfileDefinition {
  readonly id: ProfileId
  /** 1 for the first published version; each change appends the next. */
  readonly version: number
  /** English display name. */
  readonly name: string
  /** Swedish display name, as the user meets it. */
  readonly nameSv: string
  /** Each switchable package's state when the company starts. */
  readonly packages: Readonly<Record<SwitchablePackageId, PackageDefault>>
}

const ALL_ON: Record<SwitchablePackageId, PackageDefault> = {
  bank: 'on',
  'customer-invoices': 'on',
  'supplier-invoices-and-payments': 'on',
  'receipts-and-documents': 'on',
  expenses: 'on',
  payroll: 'on',
  assets: 'on',
  'pos-and-webshop': 'on',
}

/**
 * Every published version of every profile. Version 1 of each is the
 * design's "Proposed profiles" table, row by row.
 */
const DEFINITIONS: readonly ProfileDefinition[] = [
  {
    id: 'sole-trader',
    version: 1,
    name: 'Sole trader',
    nameSv: 'Enskild firma',
    packages: {
      ...ALL_ON,
      'supplier-invoices-and-payments': 'off',
      expenses: 'off',
      payroll: 'off',
      assets: 'off',
      'pos-and-webshop': 'off',
    },
  },
  {
    id: 'limited-company-no-employees',
    version: 1,
    name: 'Limited company without employees',
    nameSv: 'Aktiebolag utan anställda',
    packages: { ...ALL_ON, payroll: 'off', assets: 'off', 'pos-and-webshop': 'off' },
  },
  {
    id: 'limited-company-with-employees',
    version: 1,
    name: 'Limited company with employees',
    nameSv: 'Aktiebolag med anställda',
    packages: { ...ALL_ON, 'pos-and-webshop': 'off' },
  },
  {
    id: 'retail',
    version: 1,
    name: 'Retail with a till or webshop',
    nameSv: 'Handel med kassa eller webbshop',
    packages: { ...ALL_ON, expenses: 'off', payroll: 'off' },
  },
  {
    id: 'association',
    version: 1,
    name: 'Association',
    nameSv: 'Förening',
    packages: {
      ...ALL_ON,
      'supplier-invoices-and-payments': 'off',
      payroll: 'off',
      assets: 'off',
      'pos-and-webshop': 'off',
    },
  },
  {
    id: 'standard',
    version: 1,
    name: 'Standard (everything on)',
    nameSv: 'Standard (allt på)',
    packages: { ...ALL_ON },
  },
]

/** Every published version, frozen: read it, never mutate it. */
export const PROFILE_VERSIONS: readonly ProfileDefinition[] = Object.freeze(
  DEFINITIONS.map((def) => Object.freeze({ ...def, packages: Object.freeze({ ...def.packages }) })),
)

const latestById = new Map<string, ProfileDefinition>()
for (const def of PROFILE_VERSIONS) {
  const seen = latestById.get(def.id)
  if (!seen || def.version > seen.version) latestById.set(def.id, def)
}

/** The latest version of every profile, in PROFILE_IDS order: what a picker offers. */
export const PROFILES: readonly ProfileDefinition[] = Object.freeze(
  PROFILE_IDS.flatMap((id) => {
    const def = latestById.get(id)
    return def ? [def] : []
  }),
)

export function isProfileId(value: unknown): value is ProfileId {
  return typeof value === 'string' && (PROFILE_IDS as readonly string[]).includes(value)
}

/**
 * One profile version: the exact one asked for, or the latest when no
 * version is given. Undefined for an id or version this code does not know.
 */
export function getProfile(id: string, version?: number | null): ProfileDefinition | undefined {
  if (version === undefined || version === null) return latestById.get(id)
  return PROFILE_VERSIONS.find((def) => def.id === id && def.version === version)
}

/** The latest version of a known profile. */
export function latestProfile(id: ProfileId): ProfileDefinition {
  return latestById.get(id)!
}

/** The switchable packages a profile starts with off, in package order. */
export function packagesOffIn(profile: ProfileDefinition): PackageId[] {
  return PACKAGES.filter((p) => p.switchable && profile.packages[p.id as SwitchablePackageId] === 'off').map(
    (p) => p.id,
  )
}

/** What a company stored: companies.profile_id and companies.profile_version. */
export interface StoredProfile {
  id: string | null | undefined
  version: number | null | undefined
}

export interface ResolvedProfile {
  definition: ProfileDefinition
  /**
   * stored: the company's own profile row. implicit: none is stored, so
   * "Standard (allt på)" applies. An id or version this code does not know
   * (a newer row read by an older deploy) also reads as implicit Standard:
   * a reader must never hide a package on a guess.
   */
  source: 'stored' | 'implicit'
}

export function resolveStoredProfile(stored: StoredProfile | null | undefined): ResolvedProfile {
  // The CHECK stores id and version together; either one missing is no profile.
  if (stored?.id && stored.version) {
    const found = getProfile(stored.id, stored.version)
    if (found) return { definition: found, source: 'stored' }
  }
  return { definition: latestProfile(STANDARD_PROFILE_ID), source: 'implicit' }
}

/**
 * The profile each legal form starts with on public signup. A Record over
 * every form, so a new legal form does not compile until it names one.
 */
const SIGNUP_PROFILE_BY_FORM: Readonly<Record<EntityType, ProfileId>> = Object.freeze({
  aktiebolag: 'limited-company-no-employees',
  enskild_firma: 'sole-trader',
  ideell_forening: 'association',
  ekonomisk_forening: 'association',
})

/**
 * The profile public signup derives from the onboarding answers, with no
 * extra step: an aktiebolag starts as "Aktiebolag utan anställda", an
 * enskild firma as "Enskild firma", an ideell or ekonomisk förening as
 * "Förening". The first employee, kassa or supplier invoice later brings a
 * suggestion. F-skatt and moms, the other onboarding answers, decide nothing
 * today: no proposed profile differs by them. Null for an unknown legal form.
 */
export function deriveSignupProfile(entityType: unknown): ProfileId | null {
  if (typeof entityType !== 'string' || !Object.hasOwn(SIGNUP_PROFILE_BY_FORM, entityType)) return null
  return SIGNUP_PROFILE_BY_FORM[entityType as EntityType]
}
