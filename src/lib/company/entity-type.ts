import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType } from '@/types'
import { flagEnabled } from '@/lib/env/public-flags'
import { LEGAL_FORMS, PLANNED_LEGAL_FORMS } from '@/lib/company/forms'
import type { LegalFormProfile, PlannedLegalForm } from '@/lib/company/forms'

/**
 * The one place that knows which legal forms Accounted books for, and the
 * readers every call site uses to ask what a form can do.
 *
 * The facts themselves live in one profile per form under
 * lib/company/forms/ (contract: docs/LEGAL-FORMS.md). Call sites read a
 * capability (`filesIncomeReturn(form) === 'INK2'`, `hasOwners(form)`) and
 * never compare the form to a string: `=== 'aktiebolag'` sends every later
 * form down the branch it was not written for, silently. The
 * `literal-legal-form` ratchet in scripts/checks/no-new-antipatterns.mjs
 * keeps the remaining literal sites from growing.
 *
 * Before this module the form was a binary flag spread over ~300 files:
 * `=== 'aktiebolag' ? A : B` ternaries and `?? 'enskild_firma'` /
 * `?? 'aktiebolag'` defaults. Widening the `EntityType` union compiled
 * everywhere and changed nothing, so a third form silently booked as an
 * enskild firma in the app and as an aktiebolag in bokslut and MCP.
 */
export const ENTITY_TYPES = [
  'enskild_firma',
  'aktiebolag',
  'ideell_forening',
] as const satisfies readonly EntityType[]

// Compile-time proof that ENTITY_TYPES lists every member of the union.
type MissingFromList = Exclude<EntityType, (typeof ENTITY_TYPES)[number]>
const entityTypesAreExhaustive: MissingFromList extends never ? true : never = true
void entityTypesAreExhaustive

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
 * The profile behind a form. The runtime check catches a corrupt string that
 * slipped past the DB CHECK; the compile-time one is the `Record` in
 * lib/company/forms/index.ts.
 */
export function legalFormProfile(entityType: EntityType): LegalFormProfile {
  if (!Object.prototype.hasOwnProperty.call(LEGAL_FORMS, entityType)) {
    throw new UnknownEntityTypeError(entityType)
  }
  return LEGAL_FORMS[entityType]
}

/** Statutory Swedish names, kept in Swedish in both locales. */
export const ENTITY_TYPE_LABELS_SV: Record<EntityType, string> = Object.fromEntries(
  ENTITY_TYPES.map((form) => [form, LEGAL_FORMS[form].label]),
) as Record<EntityType, string>

/**
 * Exhaustive dispatch on the legal form for the few sites where the answer
 * is genuinely per form and not a capability (a registry mapping, a test
 * fixture). Everywhere else read a profile field: a new form should be one
 * profile, not one more arm at every call site.
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

// ── Creation gate ────────────────────────────────────────────────────

export const IDEELL_FORENING_FLAG = 'NEXT_PUBLIC_IDEELL_FORENING_ENABLED'

/**
 * One reader per `creationFlag` a profile declares. The literal
 * `process.env.NEXT_PUBLIC_...` spelling is what Next.js inlines into client
 * bundles; a computed key would read undefined in the browser, so the read
 * cannot live in the profile. `legal-forms.test.ts` proves every flagged
 * profile has a reader here.
 */
const CREATION_FLAG_READERS: Readonly<Record<string, () => string | undefined>> = {
  [IDEELL_FORENING_FLAG]: () => process.env.NEXT_PUBLIC_IDEELL_FORENING_ENABLED,
}

export function creationFlagReader(flag: string): (() => string | undefined) | undefined {
  return CREATION_FLAG_READERS[flag]
}

/**
 * Creation gate for forms still in beta. `NEXT_PUBLIC_` so the onboarding
 * picker and the server-side create paths read the same switch; the DB CHECK
 * accepts the value regardless, so flipping the flag never needs a migration.
 * A flag without a reader is closed: silently open would be the worse bug.
 */
export function isEntityTypeCreatable(entityType: EntityType): boolean {
  const { creationFlag } = legalFormProfile(entityType)
  if (!creationFlag) return true
  const read = CREATION_FLAG_READERS[creationFlag]
  return read ? flagEnabled(read()) : false
}

/** Forms a user may pick right now (feature flags applied). */
export function creatableEntityTypes(): EntityType[] {
  return ENTITY_TYPES.filter(isEntityTypeCreatable)
}

/** Forms that are scoped but not creatable, for the picker's "kommer snart" stop. */
export function plannedLegalForms(): ReadonlyArray<PlannedLegalForm> {
  return PLANNED_LEGAL_FORMS
}

// ── Capability readers ───────────────────────────────────────────────
// Thin readers over the profile. A call site that reads `hasOwners(form)`
// says what it needs, and the profile can grow without touching it.

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
  const { closing, closingName, priorYearCarry } = legalFormProfile(entityType).equity
  return { closing, closingName, priorYearCarry }
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
  return legalFormProfile(entityType).equity.settlement[direction]
}

/** Whether someone owns the company; false for a förening, which has members. */
export function hasOwners(entityType: EntityType): boolean {
  return legalFormProfile(entityType).equity.hasOwners
}

/** Owner-side accounts a booking template may name in its base/AB columns. */
const OWNER_SETTLEMENT_ACCOUNTS = new Set(
  ENTITY_TYPES.flatMap((form) => {
    const { hasOwners: owned, settlement } = LEGAL_FORMS[form].equity
    return owned ? [settlement.withdrawal, settlement.contribution] : []
  }),
)

/**
 * Resolve a booking template's account for the form. Templates carry a base
 * (enskild firma) account and an optional `_ab` override; a form without
 * owners takes its column's account except that any owner account becomes
 * the member settlement account, since it has no egna uttag/insättningar
 * and no delägarskuld.
 */
export function templateAccountForForm(
  entityType: EntityType,
  base: string | undefined,
  abOverride: string | undefined,
): string | undefined {
  const profile = legalFormProfile(entityType)
  const picked = profile.bookkeeping.templateColumn === 'ab' ? (abOverride ?? base) : base
  if (!profile.equity.hasOwners && picked && OWNER_SETTLEMENT_ACCOUNTS.has(picked)) {
    return profile.equity.settlement.withdrawal
  }
  return picked
}

/** Whether the product prepares an årsredovisning for the form. */
export function preparesArsredovisning(entityType: EntityType): boolean {
  return legalFormProfile(entityType).filings.arsredovisning
}

/** The income return the product prepares for the form; null when none is modelled. */
export function filesIncomeReturn(entityType: EntityType): LegalFormProfile['filings']['incomeReturn'] {
  return legalFormProfile(entityType).filings.incomeReturn
}

/** Whether the year-end books the year's income tax as a liability (AB 2510/8910). */
export function booksCurrentTax(entityType: EntityType): boolean {
  return legalFormProfile(entityType).filings.booksCurrentTax
}

/** Periodiseringsfond and överavskrivningar proposals in the year-end wizard. */
export function supportsCorporateTaxDispositions(entityType: EntityType): boolean {
  return legalFormProfile(entityType).filings.corporateTaxDispositions
}

/** Whether the product offers the form a given accounting framework. */
export function supportsAccountingFramework(
  entityType: EntityType,
  framework: LegalFormProfile['filings']['frameworks'][number],
): boolean {
  return legalFormProfile(entityType).filings.frameworks.includes(framework)
}

/** BFL 3 kap 1 §: a fysisk person (enskild firma) is bound to the calendar year. */
export function fiscalYearLockedToCalendar(entityType: EntityType): boolean {
  return legalFormProfile(entityType).fiscalYear.calendarOnly
}

/** The org number is the owner's personnummer only for an enskild firma. */
export function usesPersonnummerAsOrgNumber(entityType: EntityType): boolean {
  return legalFormProfile(entityType).identity.orgId === 'personnummer'
}

export function defaultAccountingMethod(entityType: EntityType): 'accrual' | 'cash' {
  return legalFormProfile(entityType).bookkeeping.defaultMethod
}

/**
 * Simplified year-end regelverk label used by the accrual threshold logic
 * (K1: 5 000 kr per post may stay unperiodised). EF: BFNAR 2006:1; ideell
 * förening: BFNAR 2010:1; AB prepares under K2.
 */
export function simplifiedYearEndRegelverk(entityType: EntityType): 'K1' | 'K2' {
  return legalFormProfile(entityType).bookkeeping.simplifiedRegelverk
}

/** Swedish nouns that differ by law, for standalone labels. Sentences stay form-neutral. */
export function legalFormGlossary(entityType: EntityType): LegalFormProfile['glossary'] {
  return legalFormProfile(entityType).glossary
}
