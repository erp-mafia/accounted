import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType } from '@/types'
import { flagEnabled } from '@/lib/env/public-flags'

/**
 * The one place that knows which legal forms Accounted books for and what
 * follows from each of them.
 *
 * Before this module the form was a binary flag spread over ~300 files:
 * `=== 'aktiebolag' ? A : B` ternaries and `?? 'enskild_firma'` /
 * `?? 'aktiebolag'` defaults. Widening the `EntityType` union compiled
 * everywhere and changed nothing, so a third form silently booked as an
 * enskild firma in the app and as an aktiebolag in bokslut and MCP. Every
 * form-dependent fact now goes through `byEntityType`, whose `Record` arms
 * make the compiler refuse the next widening until each site has an answer.
 *
 * Domain facts (issue #2072, DECISIONS.md 2026-09-08):
 * - Ideell förening closes its result to 2069 "Årets resultat" and carries
 *   it to 2068 at the next year start, mirroring the AB 2099/2098 pair on the
 *   BAS 2060-2069 group for föreningar.
 * - A förening has no owner: there are no egna uttag/insättningar (EF
 *   2013/2018) and no delägarskuld (AB 2893). Money settled with a member is
 *   a plain short-term liability, 2890.
 * - A förening is a juridisk person, so BFL 3 kap does not force the
 *   calendar year on it (the EF rule) and its default method is accrual.
 * - An ekonomisk förening files INK2 and an annual report, but its bound
 *   equity is member capital (2083/2084) rather than share capital (2081).
 *   It must always have an auditor, regardless of size.
 */
export const ENTITY_TYPES = [
  'enskild_firma',
  'aktiebolag',
  'ideell_forening',
  'ekonomisk_forening',
] as const satisfies readonly EntityType[]

// Compile-time proof that ENTITY_TYPES lists every member of the union.
type MissingFromList = Exclude<EntityType, (typeof ENTITY_TYPES)[number]>
const entityTypesAreExhaustive: MissingFromList extends never ? true : never = true
void entityTypesAreExhaustive

/** Statutory Swedish names, kept in Swedish in both locales. */
export const ENTITY_TYPE_LABELS_SV: Record<EntityType, string> = {
  enskild_firma: 'Enskild firma',
  aktiebolag: 'Aktiebolag',
  ideell_forening: 'Ideell förening',
  ekonomisk_forening: 'Ekonomisk förening',
}

export class UnknownEntityTypeError extends Error {
  readonly code = 'COMPANY_ENTITY_TYPE_UNKNOWN'
  constructor(value: unknown) {
    super(
      `Unknown company entity_type ${JSON.stringify(value)}: expected one of ${ENTITY_TYPES.join(', ')}`,
    )
    this.name = 'UnknownEntityTypeError'
  }
}

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value)
}

/** Narrow a raw DB/JSON value; throws instead of defaulting. */
export function parseEntityType(value: unknown): EntityType {
  if (isEntityType(value)) return value
  throw new UnknownEntityTypeError(value)
}

/**
 * Exhaustive dispatch on the legal form. `Record<EntityType, T>` makes every
 * arm mandatory at compile time; the runtime check catches a corrupt string
 * that slipped past the DB CHECK.
 */
export function byEntityType<T>(entityType: EntityType, arms: Record<EntityType, T>): T {
  if (!Object.prototype.hasOwnProperty.call(arms, entityType)) {
    throw new UnknownEntityTypeError(entityType)
  }
  return arms[entityType]
}

/**
 * Resolve a company's legal form for a booking path. `hint` is whatever the
 * caller already loaded (usually `company_settings.entity_type`); when it is
 * missing or invalid the canonical `companies.entity_type` (NOT NULL, CHECKed)
 * is read. Never defaults: a wrong form books to the wrong equity account.
 */
export async function resolveCompanyEntityType(
  supabase: SupabaseClient,
  companyId: string,
  hint?: unknown,
): Promise<EntityType> {
  if (isEntityType(hint)) return hint
  const { data, error } = await supabase
    .from('companies')
    .select('entity_type')
    .eq('id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load company entity type: ${error.message}`)
  return parseEntityType(data?.entity_type)
}

/**
 * Creation gate for forms still in beta. `NEXT_PUBLIC_` so the onboarding
 * picker and the server-side create paths read the same switch; the DB CHECK
 * accepts the value regardless, so flipping the flag never needs a migration.
 * The literal `process.env.NEXT_PUBLIC_...` spelling is what Next.js inlines
 * into client bundles; a computed key would read undefined in the browser.
 */
export const IDEELL_FORENING_FLAG = 'NEXT_PUBLIC_IDEELL_FORENING_ENABLED'
export const EKONOMISK_FORENING_FLAG = 'NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED'

export function isEntityTypeCreatable(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: true,
    aktiebolag: true,
    ideell_forening: flagEnabled(process.env.NEXT_PUBLIC_IDEELL_FORENING_ENABLED),
    ekonomisk_forening: flagEnabled(process.env.NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED),
  })
}

/** Forms a user may pick right now (feature flags applied). */
export function creatableEntityTypes(): EntityType[] {
  return ENTITY_TYPES.filter(isEntityTypeCreatable)
}

// ── Domain facts ─────────────────────────────────────────────────────

export interface ResultClosingAccounts {
  /** Account the year's net result is closed to. */
  closing: string
  closingName: string
  /**
   * Account the previous year's result is moved to at the next year start
   * (null when the form closes straight into an equity account, EF 2010).
   */
  priorYearCarry: string | null
}

export function resultClosingAccounts(entityType: EntityType): ResultClosingAccounts {
  return byEntityType<ResultClosingAccounts>(entityType, {
    enskild_firma: { closing: '2010', closingName: 'Eget kapital', priorYearCarry: null },
    aktiebolag: { closing: '2099', closingName: 'Årets resultat', priorYearCarry: '2098' },
    ideell_forening: { closing: '2069', closingName: 'Årets resultat', priorYearCarry: '2068' },
    ekonomisk_forening: { closing: '2099', closingName: 'Årets resultat', priorYearCarry: '2098' },
  })
}

/**
 * Account for money settled with the owner (EF: egna uttag/insättningar, AB:
 * skuld till aktieägare). A förening has no owner; a member who pays or is
 * paid is a plain short-term counterparty on 2890.
 */
export function ownerSettlementAccount(
  entityType: EntityType,
  direction: 'withdrawal' | 'contribution',
): string {
  return byEntityType(entityType, {
    enskild_firma: direction === 'withdrawal' ? '2013' : '2018',
    aktiebolag: '2893',
    ideell_forening: '2890',
    ekonomisk_forening: '2890',
  })
}

/** Owner-side accounts a booking template may name in its base/AB columns. */
const OWNER_SETTLEMENT_ACCOUNTS = new Set(['2013', '2018', '2893'])

/**
 * Resolve a booking template's account for the form. Templates carry a base
 * (enskild firma) account and an optional `_ab` override. A förening takes
 * the base account (6991 for a course, 3100 for exempt revenue) except that
 * any owner account becomes the member settlement account, since a förening
 * has no egna uttag/insättningar and no delägarskuld.
 */
export function templateAccountForForm(
  entityType: EntityType,
  base: string | undefined,
  abOverride: string | undefined,
): string | undefined {
  return byEntityType(entityType, {
    enskild_firma: base,
    aktiebolag: abOverride ?? base,
    ideell_forening:
      base && OWNER_SETTLEMENT_ACCOUNTS.has(base) ? ownerSettlementAccount('ideell_forening', 'withdrawal') : base,
    // A juridisk person with employees books like an aktiebolag (the `_ab`
    // override: 7610 utbildning, 3004 momsfri försäljning), except that an
    // owner account (2893 skuld till aktieägare, or a base 2013/2018) becomes
    // the member settlement account 2890.
    ekonomisk_forening: (() => {
      const resolved = abOverride ?? base
      return resolved && OWNER_SETTLEMENT_ACCOUNTS.has(resolved)
        ? ownerSettlementAccount('ekonomisk_forening', 'withdrawal')
        : resolved
    })(),
  })
}

/**
 * Legal forms whose bookkeeping ends in an årsredovisning (BFL 6 kap. 1 §:
 * every aktiebolag and every ekonomisk förening; an enskild firma and an
 * ideell förening below the ÅRL 1 kap. 3 § thresholds close with an
 * årsbokslut instead).
 */
export function preparesArsredovisning(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: false,
    aktiebolag: true,
    ideell_forening: false,
    ekonomisk_forening: true,
  })
}

/** BFL 3 kap 1 §: a fysisk person (enskild firma) is bound to the calendar year. */
export function fiscalYearLockedToCalendar(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: true,
    aktiebolag: false,
    ideell_forening: false,
    ekonomisk_forening: false,
  })
}

/** The org number is the owner's personnummer only for an enskild firma. */
export function usesPersonnummerAsOrgNumber(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: true,
    aktiebolag: false,
    ideell_forening: false,
    ekonomisk_forening: false,
  })
}

export function defaultAccountingMethod(entityType: EntityType): 'accrual' | 'cash' {
  return byEntityType(entityType, {
    enskild_firma: 'cash',
    aktiebolag: 'accrual',
    ideell_forening: 'accrual',
    ekonomisk_forening: 'accrual',
  })
}

/**
 * Simplified year-end regelverk label used by the accrual threshold logic
 * (K1: 5 000 kr per post may stay unperiodised). EF: BFNAR 2006:1; ideell
 * förening: BFNAR 2010:1; AB and ekonomisk förening prepare under K2/K3.
 */
export function simplifiedYearEndRegelverk(entityType: EntityType): 'K1' | 'K2' {
  return byEntityType(entityType, {
    enskild_firma: 'K1',
    aktiebolag: 'K2',
    ideell_forening: 'K1',
    ekonomisk_forening: 'K2',
  })
}

/**
 * Legal forms that file Inkomstdeklaration 2. Skatteverket's INK2 is the
 * return for aktiebolag, ekonomiska föreningar and other juridiska personer
 * taxed under IL 65 kap. 10 § (SFL 30 kap. 1 §); an enskild firma files the
 * NE-bilaga and an ideell förening INK3.
 */
export function usesInk2(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: false,
    aktiebolag: true,
    ideell_forening: false,
    ekonomisk_forening: true,
  })
}

/**
 * Forms that book their own income tax (2510/8910) and the bokslutsdispositioner
 * of a juridisk person: periodiseringsfond 25 % (IL 30 kap. 5 §),
 * överavskrivningar (IL 18 kap. 13-17 §§), särskild löneskatt and bolagsskatt
 * 20,6 % (IL 65 kap. 10 §). The rules are the same for an aktiebolag and an
 * ekonomisk förening; an enskild firma's counterparts are declaration-only
 * (NE-bilaga) and an ideell förening's income is mostly tax-exempt (IL 7 kap.).
 */
export function booksCurrentTax(entityType: EntityType): boolean {
  return usesInk2(entityType)
}

export function supportsCorporateTaxDispositions(entityType: EntityType): boolean {
  return usesInk2(entityType)
}

/**
 * EFL 8 kap. 1 §: an ekonomisk förening must have at least one revisor
 * whatever its size, and an authorised revisor above the EFL 8 kap. 14-15 §§
 * thresholds. An aktiebolag may opt out below the ABL 9 kap. 1 § thresholds.
 */
export function requiresAuditorRegardlessOfSize(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: false,
    aktiebolag: false,
    ideell_forening: false,
    ekonomisk_forening: true,
  })
}

/**
 * Bound equity made of member contributions (EFL 10 kap., BAS 2083) and
 * optional förlagsinsatser (EFL 11 kap., BAS 2084), reported as separate
 * posts under bundet eget kapital (ÅRL 3 kap. 10 b §). Share capital (2081)
 * is the aktiebolag counterpart and never applies to a förening.
 */
export function supportsMemberCapital(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: false,
    aktiebolag: false,
    ideell_forening: false,
    ekonomisk_forening: true,
  })
}

/**
 * K2 (BFNAR 2016:10) is open to every mindre företag that prepares an
 * årsredovisning, K3 (BFNAR 2012:1) to all of them; an ekonomisk förening
 * chooses between the two exactly like an aktiebolag (BFN, "Vad gäller för
 * ekonomiska föreningar"). The K3 equity roll-forward carries member capital
 * for the form since the member-register work. Forms that close with an
 * årsbokslut (enskild firma, ideell förening) never pick a framework.
 */
export function supportsAccountingFramework(
  entityType: EntityType,
  framework: 'k2' | 'k3',
): boolean {
  if (!preparesArsredovisning(entityType)) return false
  return framework === 'k2' || framework === 'k3'
}
