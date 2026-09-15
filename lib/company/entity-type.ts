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
 * - A bostadsrättsförening IS an ekonomisk förening (BRL 1991:614 1 kap.
 *   1 §; EFL applies where BRL is silent), so every answer below is the
 *   ekonomisk förening one unless BRL, IL 2 kap. 17 § (privatbostadsföretag)
 *   or the K3 duty from 2026 (BFN decision 2025-06-16, K3 chapter 38) says
 *   otherwise. `isEkonomiskForeningFamily` is the one test for "either".
 */
export const ENTITY_TYPES = [
  'enskild_firma',
  'aktiebolag',
  'ideell_forening',
  'ekonomisk_forening',
  'bostadsrattsforening',
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
  bostadsrattsforening: 'Bostadsrättsförening',
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
export const BOSTADSRATTSFORENING_FLAG = 'NEXT_PUBLIC_BOSTADSRATTSFORENING_ENABLED'

export function isEntityTypeCreatable(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: true,
    aktiebolag: true,
    ideell_forening: flagEnabled(process.env.NEXT_PUBLIC_IDEELL_FORENING_ENABLED),
    ekonomisk_forening: flagEnabled(process.env.NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED),
    bostadsrattsforening: flagEnabled(process.env.NEXT_PUBLIC_BOSTADSRATTSFORENING_ENABLED),
  })
}

/** Forms a user may pick right now (feature flags applied). */
export function creatableEntityTypes(): EntityType[] {
  return ENTITY_TYPES.filter(isEntityTypeCreatable)
}

// ── Domain facts ─────────────────────────────────────────────────────

/**
 * The ekonomisk förening and its special case, the bostadsrättsförening
 * (BRL 1 kap. 1 §: a BRF is an ekonomisk förening whose purpose is to grant
 * bostadsrätt in its buildings). Sites that mean "an association governed by
 * EFL" test this instead of the `'ekonomisk_forening'` literal, so the BRF
 * inherits the föreningsstämma, the ÅRL 6 kap. 3 § member disclosures, the
 * mandatory revisor and the member-capital equity by construction.
 */
export function isEkonomiskForeningFamily(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: false,
    aktiebolag: false,
    ideell_forening: false,
    ekonomisk_forening: true,
    bostadsrattsforening: true,
  })
}

/**
 * IL 39 kap. 25 §: a privatbostadsföretag (an äkta bostadsrättsförening, IL
 * 2 kap. 17 §) is not taxed on income from its property; only capital income
 * outside the property and non-property activities reach the tax base. The
 * form CAN have the exemption; whether a given year's company qualifies is
 * the per-year assessment in brf_tax_profiles (lib/company/brf-tax-profile).
 */
export function hasPropertyIncomeExemption(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: false,
    aktiebolag: false,
    ideell_forening: false,
    ekonomisk_forening: false,
    bostadsrattsforening: true,
  })
}

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
    bostadsrattsforening: { closing: '2099', closingName: 'Årets resultat', priorYearCarry: '2098' },
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
    bostadsrattsforening: '2890',
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
  // A juridisk person with employees books like an aktiebolag (the `_ab`
  // override: 7610 utbildning, 3004 momsfri försäljning), except that an
  // owner account (2893 skuld till aktieägare, or a base 2013/2018) becomes
  // the member settlement account 2890.
  const juridiskPersonWithMembers = (form: EntityType): string | undefined => {
    const resolved = abOverride ?? base
    return resolved && OWNER_SETTLEMENT_ACCOUNTS.has(resolved)
      ? ownerSettlementAccount(form, 'withdrawal')
      : resolved
  }
  return byEntityType(entityType, {
    enskild_firma: base,
    aktiebolag: abOverride ?? base,
    ideell_forening:
      base && OWNER_SETTLEMENT_ACCOUNTS.has(base) ? ownerSettlementAccount('ideell_forening', 'withdrawal') : base,
    ekonomisk_forening: juridiskPersonWithMembers('ekonomisk_forening'),
    bostadsrattsforening: juridiskPersonWithMembers('bostadsrattsforening'),
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
    bostadsrattsforening: true,
  })
}

/** BFL 3 kap 1 §: a fysisk person (enskild firma) is bound to the calendar year. */
export function fiscalYearLockedToCalendar(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: true,
    aktiebolag: false,
    ideell_forening: false,
    ekonomisk_forening: false,
    bostadsrattsforening: false,
  })
}

/** The org number is the owner's personnummer only for an enskild firma. */
export function usesPersonnummerAsOrgNumber(entityType: EntityType): boolean {
  return byEntityType(entityType, {
    enskild_firma: true,
    aktiebolag: false,
    ideell_forening: false,
    ekonomisk_forening: false,
    bostadsrattsforening: false,
  })
}

export function defaultAccountingMethod(entityType: EntityType): 'accrual' | 'cash' {
  return byEntityType(entityType, {
    enskild_firma: 'cash',
    aktiebolag: 'accrual',
    ideell_forening: 'accrual',
    ekonomisk_forening: 'accrual',
    bostadsrattsforening: 'accrual',
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
    bostadsrattsforening: 'K2',
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
    // A BRF files INK2 every year (Skatteverket, "Deklarera åt en
    // bostadsrättsförening"); an äkta BRF's property result is removed on
    // INK2S, it does not skip the return.
    bostadsrattsforening: true,
  })
}

/**
 * Forms that book their own income tax (2510/8910) and the bokslutsdispositioner
 * of a juridisk person: periodiseringsfond 25 % (IL 30 kap. 5 §),
 * överavskrivningar (IL 18 kap. 13-17 §§), särskild löneskatt and bolagsskatt
 * 20,6 % (IL 65 kap. 10 §). The rules are the same for an aktiebolag and an
 * ekonomisk förening; an enskild firma's counterparts are declaration-only
 * (NE-bilaga) and an ideell förening's income is mostly tax-exempt (IL 7 kap.).
 * A bostadsrättsförening books current tax too: even a privatbostadsföretag
 * pays 20,6 % on the capital income and activities outside the property
 * (IL 39 kap. 25 §), so the 2510/8910 pair and the dispositions exist; the
 * exempt property block is an INK2S adjustment, not a form-level opt-out.
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
    bostadsrattsforening: true,
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
    // Insatser and upplåtelseavgifter (2083/2087) are the BRF's bundet eget
    // kapital (ÅRL 3 kap. 10 b §); the apartment-level register is later work.
    bostadsrattsforening: true,
  })
}

/**
 * From financial years beginning after 2025-12-31 every bostadsrättsförening
 * must apply K3 (BFN decision 2025-06-16 adding chapter 38 to BFNAR 2012:1);
 * K2 is closed to the form from then on. Earlier years may still be K2.
 */
export const BRF_K3_MANDATORY_FROM = '2026-01-01'

/**
 * K2 (BFNAR 2016:10) is open to every mindre företag that prepares an
 * årsredovisning, K3 (BFNAR 2012:1) to all of them; an ekonomisk förening
 * chooses between the two exactly like an aktiebolag (BFN, "Vad gäller för
 * ekonomiska föreningar"). The K3 equity roll-forward carries member capital
 * for the form since the member-register work. Forms that close with an
 * årsbokslut (enskild firma, ideell förening) never pick a framework.
 *
 * A bostadsrättsförening is K3-only for a fiscal year that begins on or after
 * BRF_K3_MANDATORY_FROM. `fiscalYearStart` (ISO date) is the first day of the
 * year being judged; when the caller does not know it, the answer is the
 * conservative one (K3 only), so a K2 choice is never granted by omission.
 */
export function supportsAccountingFramework(
  entityType: EntityType,
  framework: 'k2' | 'k3',
  fiscalYearStart?: string | null,
): boolean {
  if (!preparesArsredovisning(entityType)) return false
  if (entityType === 'bostadsrattsforening' && framework === 'k2') {
    return typeof fiscalYearStart === 'string' && fiscalYearStart < BRF_K3_MANDATORY_FROM
  }
  return framework === 'k2' || framework === 'k3'
}
