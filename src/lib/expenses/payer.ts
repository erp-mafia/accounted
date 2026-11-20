/**
 * Who paid for an underlag: the one question that decides how it is booked.
 *
 * 'company' -> the bank line is matched (or the supplier invoice is
 * registered and marked paid against a picked transaction); 'unpaid' -> a
 * supplier invoice on 2440 with a due date; 'owner' / 'employee' -> an
 * utlägg: cost + moms are booked at once against that person's liability
 * account and an expense_claims row keeps the debt open until it is repaid.
 *
 * Shared by the Underlag pane, the supplier-invoice form and the
 * supplier-invoice route so the answer has one vocabulary and one account
 * rule. Framework-free on purpose: routes import it too.
 */

export type ExpensePayer = 'owner' | 'employee'
export type PayerChoice = 'company' | 'unpaid' | ExpensePayer

/** Display order of the answers in the "Vem betalade?" select. */
export const PAYER_ORDER: readonly PayerChoice[] = ['company', 'owner', 'employee', 'unpaid']

export function isPersonPayer(choice: PayerChoice | null | undefined): choice is ExpensePayer {
  return choice === 'owner' || choice === 'employee'
}

/**
 * The owner's claims are grouped by name on Hem (there is no employee row for
 * the owner), so every writer that lets the name default must default to the
 * same string or one person shows up as two. The constant is the AB/EF value;
 * a caller with the form in reach uses ownerFallbackName(form) so a förening
 * member is labelled "Medlem", not "Ägare".
 */
import { ENTITY_TYPES, isEntityType, legalFormGlossary, ownerSettlementAccount } from '@/lib/company/entity-type'

export const OWNER_FALLBACK_NAME = 'Ägare'

/**
 * The claimant label for "Jag, privat" when no name is typed: the form's
 * glossary noun (AB and EF "Ägare", ideell förening "Medlem"). An unknown
 * form (a dialog rendering before the company context loads) keeps the
 * shared constant so the label never flips mid-render.
 */
export function ownerFallbackName(entityType: string | null | undefined): string {
  return isEntityType(entityType) ? legalFormGlossary(entityType).owner : OWNER_FALLBACK_NAME
}

/**
 * The labels a claim gets when nobody typed a name: every form's glossary
 * noun, the shared constant, and the English one the Utlägg page writes
 * (expense_claims.owner_fallback_name in en.json). Lowercased.
 */
const FALLBACK_LABELS: ReadonlySet<string> = new Set(
  [...ENTITY_TYPES.map((form) => legalFormGlossary(form).owner), OWNER_FALLBACK_NAME, 'Owner'].map((label) =>
    label.toLowerCase(),
  ),
)

/** The fields of an expense claim row that lastOwnerClaimantName reads. */
export interface ClaimantHistoryRow {
  employee_id?: string | null
  claimant_name?: string | null
  created_at?: string | null
}

/**
 * The name "Jag, privat" opens with: the one the company's most recently
 * registered owner claim was typed under. Without it the field starts empty
 * every time, people type their name on every receipt (PH 101), and a
 * receipt left empty becomes "Ägare" beside the typed name, so one owner is
 * two people to pay on Att göra (claims group by name: there is no
 * employee row for the owner). Null when no owner claim has a typed name;
 * the field then stays empty with the fallback label as its placeholder.
 */
export function lastOwnerClaimantName(claims: readonly ClaimantHistoryRow[]): string | null {
  let latest: { name: string; at: number } | null = null
  for (const claim of claims) {
    if (claim.employee_id) continue
    const name = claim.claimant_name?.trim()
    if (!name || FALLBACK_LABELS.has(name.toLowerCase())) continue
    const at = claim.created_at ? Date.parse(claim.created_at) : Number.NaN
    const when = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at
    if (!latest || when > latest.at) latest = { name, at: when }
  }
  return latest?.name ?? null
}

export type ExpenseLiabilityAccount = '2893' | '2820' | '2018' | '2890'

/**
 * Liability account for an utlägg. An employee is always 2820 (kortfristiga
 * skulder till anställda). The owner's account follows the entity type: an AB
 * owner is a creditor (2893 skulder till närstående); an enskild firma owner
 * makes an egen insättning (2018), which is equity, not a debt; a member of an
 * ideell förening is a plain short-term creditor (2890).
 *
 * Same resolver as lib/expenses/expense-claims-service.ts, which is the
 * authority at booking time; an unknown form here (a dialog rendering before
 * the company context loads) previews the AB account, never books it.
 */
export function resolveExpenseLiabilityAccount(
  entityType: string | null | undefined,
  payer: ExpensePayer,
): ExpenseLiabilityAccount {
  if (payer === 'employee') return '2820'
  if (!isEntityType(entityType)) return '2893'
  return ownerSettlementAccount(entityType, 'contribution') as ExpenseLiabilityAccount
}
