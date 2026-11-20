/**
 * Where a signed-in user with no active company may still go, and where the
 * delete-account action lives.
 *
 * Deleting an account requires owning no companies, so a user who wants to
 * leave first deletes (archives) their last company and is company-less from
 * then on. The middleware and the dashboard layout send every company-less
 * request to onboarding except the pages listed here, so the page holding the
 * delete-account action must be on this list, and every link that leads such
 * a user to that action must point at it.
 *
 * Those used to be separate hard-coded '/settings/account' strings (the
 * middleware allowlist, the dashboard layout allowlist, the onboarding escape
 * hatch, the post-delete redirect). When the action moved from Profil to
 * Säkerhet (#3010) none of them moved with it, and a user who had deleted
 * their last company could no longer reach it (crm#1042). One definition
 * here keeps them in step.
 */

/** The settings page that holds the delete-account action (AccountDangerZone). */
export const ACCOUNT_DELETION_PATH = '/settings/security'

/** Hash that makes the deletion page scroll the action into view. */
export const ACCOUNT_DELETION_HASH = 'delete-account'

/** Deep link to the delete-account action. */
export const ACCOUNT_DELETION_HREF = `${ACCOUNT_DELETION_PATH}#${ACCOUNT_DELETION_HASH}`

/**
 * Dashboard pages that render the no-company shell instead of redirecting to
 * onboarding: Profil (name, email, language) and the page with the
 * delete-account action.
 */
export const NO_COMPANY_DASHBOARD_PATHS: readonly string[] = [
  '/settings/account',
  ACCOUNT_DELETION_PATH,
]

/** True when `pathname` is one of NO_COMPANY_DASHBOARD_PATHS or below one. */
export function isNoCompanyDashboardPath(pathname: string): boolean {
  return NO_COMPANY_DASHBOARD_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  )
}
