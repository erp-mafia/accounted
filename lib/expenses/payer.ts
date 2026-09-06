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
 * same string or one person shows up as two.
 */
export const OWNER_FALLBACK_NAME = 'Ägare'

export type ExpenseLiabilityAccount = '2893' | '2820' | '2018'

/**
 * Liability account for an utlägg. An employee is always 2820 (kortfristiga
 * skulder till anställda). The owner's account follows the entity type: an AB
 * owner is a creditor (2893 skulder till närstående); an enskild firma owner
 * makes an egen insättning (2018), which is equity, not a debt.
 */
export function resolveExpenseLiabilityAccount(
  entityType: string | null | undefined,
  payer: ExpensePayer,
): ExpenseLiabilityAccount {
  if (payer === 'employee') return '2820'
  return entityType === 'enskild_firma' ? '2018' : '2893'
}
