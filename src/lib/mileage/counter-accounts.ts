import type { EntityType } from '@/types'
import {
  hasOwners,
  ownerSettlementAccount,
  usesPersonnummerAsOrgNumber,
} from '@/lib/company/entity-type'

/**
 * Credit side of a milersättning verifikat. Client-safe (no server imports):
 * the körjournal page offers exactly the accounts the service accepts.
 */

/** Every account any legal form may credit: the request enum. Per company, see mileageCounterAccounts. */
export const MILEAGE_COUNTER_ACCOUNTS = ['2820', '2893', '2018', '1930'] as const
export type MileageCounterAccount = (typeof MILEAGE_COUNTER_ACCOUNTS)[number]

/** BAS 2820 Kortfristiga skulder till anställda. */
const EMPLOYEE_LIABILITY: MileageCounterAccount = '2820'
/** The reimbursement already left the company account. */
const PAID_FROM_BANK: MileageCounterAccount = '1930'

function isCounterAccount(account: string): account is MileageCounterAccount {
  return (MILEAGE_COUNTER_ACCOUNTS as readonly string[]).includes(account)
}

/**
 * Accounts a milersättning verifikat may credit for this company and trip
 * set, the default first. `ownerTrips` is true when the trips carry no
 * employee: the körjournal counts those as the owner's.
 *
 * An enskild firma IS its owner (one fysisk person; its org number is the
 * owner's personnummer). The firm can neither employ nor owe its owner, so
 * the owner's own-car milersättning is a business cost paid privately:
 * credit the owner's insättning account (2018 Övriga egna insättningar),
 * never 2820 skuld till anställda. Only an employee's trips may sit on 2820.
 * An aktiebolag can employ and owe its owner: 2820, the owner settlement
 * account (2893) or 1930, as before. A förening has no owner.
 */
export function mileageCounterAccounts(
  entityType: EntityType,
  ownerTrips: boolean,
): MileageCounterAccount[] {
  const ownerAccount = hasOwners(entityType)
    ? ownerSettlementAccount(entityType, 'contribution')
    : null
  const owner = ownerAccount && isCounterAccount(ownerAccount) ? ownerAccount : null

  if (usesPersonnummerAsOrgNumber(entityType)) {
    return ownerTrips && owner ? [owner, PAID_FROM_BANK] : [EMPLOYEE_LIABILITY, PAID_FROM_BANK]
  }
  return owner
    ? [EMPLOYEE_LIABILITY, owner, PAID_FROM_BANK]
    : [EMPLOYEE_LIABILITY, PAID_FROM_BANK]
}

/**
 * Whether crediting `account` records the owner's own money put into the
 * business (an enskild firma's 2018), not something the business owes.
 */
export function isOwnerDeposit(entityType: EntityType, account: string): boolean {
  return (
    usesPersonnummerAsOrgNumber(entityType) &&
    hasOwners(entityType) &&
    ownerSettlementAccount(entityType, 'contribution') === account
  )
}

export type ResolvedMileageCounterAccount =
  | { ok: true; account: MileageCounterAccount }
  | { ok: false; allowed: MileageCounterAccount[] }

/**
 * The account to credit: the requested one when the form allows it for
 * these trips, the default when none was requested, a refusal otherwise.
 */
export function resolveMileageCounterAccount(
  entityType: EntityType,
  ownerTrips: boolean,
  requested?: string | null,
): ResolvedMileageCounterAccount {
  const allowed = mileageCounterAccounts(entityType, ownerTrips)
  if (!requested) return { ok: true, account: allowed[0] }
  const match = allowed.find((account) => account === requested)
  return match ? { ok: true, account: match } : { ok: false, allowed }
}
