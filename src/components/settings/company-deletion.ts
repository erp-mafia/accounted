import { ACCOUNT_DELETION_HREF } from '@/lib/company/no-company-routes'
import { addableEngagements } from '@/lib/company-lookup/engagements'

/**
 * Which door opened the delete-company dialog (CompanyDangerZone.tsx).
 *
 * - 'danger_zone': the "Radera företag" row itself.
 * - 'wrong_company': the locked org number row (CompanyInfoForm.tsx). The
 *   owner set up the wrong company. The org number is the company's legal
 *   identity and stays locked, so the way out is to delete this company and
 *   add the right one.
 *
 * "Gör om migrering" is deliberately not a door here: its replacement company
 * is a copy of the same legal entity (same org number, name and settings), so
 * it cannot correct a wrong company.
 */
export type CompanyDeleteDoor = 'danger_zone' | 'wrong_company'

/**
 * The door "Lägg till företag" uses (CompanySwitcher, UserMenu): the BankID
 * engagement picker when there is something to pick, otherwise the onboarding
 * journey. Open to a user with or without a company.
 */
export const ADD_COMPANY_HREF = '/select-company?choose=1'

/**
 * The link behind "Lägg till företag" for this user. /select-company renders
 * the picker only when it has BankID engagements to offer and otherwise
 * redirects to the journey, a visible extra hop of about half a second. The
 * dashboard layout can tell which case applies, so with nothing to pick the
 * link opens the journey directly: same destination, one hop less.
 *
 * `bankIdRoles` is the account's stored CompanyRoles (`bankid_enrichment`),
 * null when it has none, undefined when the read failed: then the picker
 * page decides for itself, as before. `memberOrgNumbers` are the org numbers
 * of the user's non-archived companies, the same exclusion the picker uses.
 */
export function addCompanyHref(
  bankIdRoles: unknown,
  memberOrgNumbers: ReadonlyArray<string | null | undefined>,
): string {
  if (bankIdRoles === undefined) return ADD_COMPANY_HREF
  return addableEngagements(bankIdRoles, memberOrgNumbers).length > 0 ? ADD_COMPANY_HREF : '/onboarding'
}

/**
 * Where a successful company delete leads.
 *
 * From the wrong-company door the next step is always adding the right
 * company, whether or not the user has others left.
 *
 * From the danger zone the user stays inside settings. With another company
 * left, the dashboard layout resolves it and /settings/account renders as
 * normal. With none left (`nextCompanyId` null), deleting it was most likely
 * the step before deleting the account, which requires owning none: land on
 * that action, which the no-company shell keeps reachable (crm#1042). An
 * absent `nextCompanyId` means the resolution failed, which never reads as
 * "no companies left".
 */
export function afterCompanyDeleteHref(
  door: CompanyDeleteDoor,
  nextCompanyId: string | null | undefined,
): string {
  if (door === 'wrong_company') return ADD_COMPANY_HREF
  return nextCompanyId === null ? ACCOUNT_DELETION_HREF : '/settings/account'
}
