import type { CompanyJurisdiction } from '@/types'
import { isAccountRole, type AccountRole, type AccountRoleAccounts } from './roles'
import { SE_BAS_ACCOUNT_ROLES } from './se-bas'

export { ACCOUNT_ROLES, isAccountRole, type AccountRole, type AccountRoleAccounts } from './roles'

/**
 * Account roles: which account a company books a given meaning on.
 *
 * The registry maps each jurisdiction pack to its accounts per role (Sweden:
 * ./se-bas.ts). `Record<CompanyJurisdiction, ...>` is where compile-time
 * exhaustiveness lives: widening CompanyJurisdiction does not compile until
 * the new country has a pack here.
 *
 * Client-safe and dependency-free: no database read, no server import. The
 * only per-company input is the jurisdiction. Company overrides (the primary
 * cash account, company_settings.skattekonto_account) keep their own
 * resolvers until a site that honours them moves onto a role.
 */
const ACCOUNT_ROLE_PACKS: Readonly<Record<CompanyJurisdiction, AccountRoleAccounts>> = Object.freeze({
  SE: SE_BAS_ACCOUNT_ROLES,
})

/** What the resolver needs from a company: companies.jurisdiction (ISO 3166-1 alpha-2). */
export interface AccountRoleScope {
  readonly jurisdiction: string
}

/**
 * The scope for a call site that does not hold the company yet.
 * companies.jurisdiction is CHECK-pinned to 'SE' (migration
 * 20261016006000), so this is the value every company row carries today.
 * Each use marks a site a later slice hands the company's own row instead:
 * search for PINNED_JURISDICTION to find them.
 */
export const PINNED_JURISDICTION: AccountRoleScope = Object.freeze({ jurisdiction: 'SE' })

export type AccountRoleErrorCode =
  | 'ACCOUNT_ROLE_UNKNOWN_JURISDICTION'
  | 'ACCOUNT_ROLE_UNKNOWN_ROLE'
  | 'ACCOUNT_ROLE_NOT_IN_PACK'

/**
 * A role the company's pack cannot answer. Thrown, never papered over with a
 * Swedish default: a booking on another country's books must fail before it
 * lands on a BAS number that means something else there.
 */
export class AccountRoleError extends Error {
  readonly code: AccountRoleErrorCode
  readonly jurisdiction: string
  readonly role: string

  constructor(code: AccountRoleErrorCode, jurisdiction: string, role: string) {
    const reason =
      code === 'ACCOUNT_ROLE_UNKNOWN_JURISDICTION'
        ? `no account role pack for jurisdiction ${JSON.stringify(jurisdiction)}`
        : code === 'ACCOUNT_ROLE_UNKNOWN_ROLE'
          ? `unknown account role ${JSON.stringify(role)}`
          : `the ${jurisdiction} pack has no account for role ${JSON.stringify(role)}`
    super(`Account role: ${reason}`)
    this.name = 'AccountRoleError'
    this.code = code
    this.jurisdiction = jurisdiction
    this.role = role
  }
}

/**
 * The account `company` books `role` on: its jurisdiction pack's account.
 * Throws AccountRoleError for a jurisdiction without a pack, a string that is
 * not a role, or a role the pack leaves out. Always a string: accounts are
 * identifiers, never numbers.
 */
export function resolveAccountRole(company: AccountRoleScope, role: AccountRole): string {
  const jurisdiction = company.jurisdiction
  if (!Object.hasOwn(ACCOUNT_ROLE_PACKS, jurisdiction)) {
    throw new AccountRoleError('ACCOUNT_ROLE_UNKNOWN_JURISDICTION', String(jurisdiction), String(role))
  }
  if (!isAccountRole(role)) {
    throw new AccountRoleError('ACCOUNT_ROLE_UNKNOWN_ROLE', jurisdiction, String(role))
  }
  const account = ACCOUNT_ROLE_PACKS[jurisdiction as CompanyJurisdiction][role]
  if (account === undefined) {
    throw new AccountRoleError('ACCOUNT_ROLE_NOT_IN_PACK', jurisdiction, role)
  }
  return account
}
